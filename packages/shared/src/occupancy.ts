/**
 * Deterministic in-memory mirror of the `slot_occupancy` table.
 *
 * Writing rules (CLAUDE.md → "slot_occupancy Writing Rules"):
 * - every teacher of an item            → one `teacher` cell per period
 * - groups WITHOUT subgroups            → one `group` cell per period
 * - groups WITH subgroups               → always `subgroup` cells:
 *     · item with `subgroupId`          → only that subgroup
 *     · whole-group item (`subgroupId` null) → ALL subgroups of every offering group
 *   so A and B may run in parallel, yet both clash with any whole-group class.
 * - rooms with `allowMultiGroup = false` → one `room` cell per period (exclusive)
 * - rooms with `allowMultiGroup = true`  → no exclusive cell; the student load per
 *   (day, period, room) is tracked instead so capacity can be validated.
 * - fixed blocks are seeded before scheduling (`seedFixedBlocks`).
 *
 * The index never throws on clashes: `addItem` records every claim so validators can
 * list conflicts, while `findClashes` / `canPlace` let a Solver test before placing.
 */
import type {
  FixedBlock,
  FixedBlockAppliesTo,
  OccupancyResourceType,
  Room,
  SlotOccupancy,
  StudentGroup,
  Subgroup,
} from './types';

/** Who owns an occupied cell. */
export interface OccupancyEntry {
  itemId: string;
  isFixedBlock: boolean;
  studentCount: number;
}

export type OccupancyRoomRef = Pick<Room, 'id' | 'allowMultiGroup'> & { capacity?: number | null };

export interface OccupancyItemParams {
  itemId: string;
  day: number;
  startPeriod: number;
  duration: number;
  teacherIds?: readonly string[];
  /** Offering groups (`offering_groups.group_id`). */
  groupIds?: readonly string[];
  /** Specific subgroup (split subjects); null/undefined = whole group. */
  subgroupId?: string | null;
  room?: OccupancyRoomRef | null;
  studentCount?: number;
  isFixedBlock?: boolean;
}

export type OccupancyClashReason = 'exclusive' | 'capacity';

export interface OccupancyClash {
  resourceType: OccupancyResourceType;
  resourceId: string;
  day: number;
  period: number;
  blockingItemIds: string[];
  reason: OccupancyClashReason;
  /** Capacity clashes only: students already in the room + candidate students. */
  studentCount?: number;
  capacity?: number;
}

export interface OccupancyCell {
  day: number;
  period: number;
  resourceType: OccupancyResourceType;
  resourceId: string;
}

export interface SharedRoomLoad {
  itemIds: string[];
  studentCount: number;
}

export interface SeedFixedBlockOptions {
  /** Staff used when a `closed` block applies to `all` (whole college closed). */
  staff?: ReadonlyArray<{ id: string }>;
  /** Rooms used when a `closed` block applies to `all`. */
  rooms?: ReadonlyArray<{ id: string }>;
}

export interface FixedBlockTargets {
  groupIds: string[];
  staffIds: string[];
  roomIds: string[];
}

export const FIXED_BLOCK_ITEM_PREFIX = 'fixed:';

export function fixedBlockItemId(blockId: string): string {
  return `${FIXED_BLOCK_ITEM_PREFIX}${blockId}`;
}

export function isFixedBlockItemId(itemId: string): boolean {
  return itemId.startsWith(FIXED_BLOCK_ITEM_PREFIX);
}

/** Does a fixed-block selector cover this student group? (empty selector = nobody) */
export function fixedBlockAppliesToGroup(appliesTo: FixedBlockAppliesTo, group: StudentGroup): boolean {
  if (appliesTo.all) return true;
  if (appliesTo.groupIds?.includes(group.id)) return true;
  if (appliesTo.levels?.includes(group.level)) return true;
  if (appliesTo.departmentIds?.includes(group.departmentId)) return true;
  return false;
}

/** Resolve the groups / staff / rooms blocked by a fixed block (sorted, de-duplicated). */
export function resolveFixedBlockTargets(
  block: FixedBlock,
  studentGroups: readonly StudentGroup[],
  options: SeedFixedBlockOptions = {},
): FixedBlockTargets {
  const applies: FixedBlockAppliesTo = block.appliesTo ?? {};
  const groupIds = studentGroups.filter((g) => fixedBlockAppliesToGroup(applies, g)).map((g) => g.id);
  const staffIds = new Set(applies.staffIds ?? []);
  const roomIds = new Set<string>();
  if (block.roomId) roomIds.add(block.roomId);
  if (applies.all && block.blockType === 'closed') {
    for (const s of options.staff ?? []) staffIds.add(s.id);
    for (const r of options.rooms ?? []) roomIds.add(r.id);
  }
  return {
    groupIds: [...new Set(groupIds)].sort(),
    staffIds: [...staffIds].sort(),
    roomIds: [...roomIds].sort(),
  };
}

const cellKey = (day: number, period: number, type: OccupancyResourceType, id: string) => `${day}|${period}|${type}|${id}`;
const roomLoadKey = (day: number, period: number, roomId: string) => `${day}|${period}|${roomId}`;

function parseCellKey(key: string): OccupancyCell {
  const [day, period, resourceType, ...rest] = key.split('|');
  return {
    day: Number(day),
    period: Number(period),
    resourceType: resourceType as OccupancyResourceType,
    resourceId: rest.join('|'),
  };
}

interface PlannedClaims {
  exclusive: OccupancyCell[];
  shared: Array<{ day: number; period: number; roomId: string; capacity: number | null }>;
}

export class OccupancyIndex {
  private readonly cells = new Map<string, Map<string, OccupancyEntry>>();
  private readonly roomLoads = new Map<string, Map<string, OccupancyEntry>>();
  private readonly itemCells = new Map<string, string[]>();
  private readonly itemRoomLoads = new Map<string, string[]>();
  private readonly subgroupsByGroup = new Map<string, string[]>();

  constructor(subgroups: readonly Subgroup[] = []) {
    this.registerSubgroups(subgroups);
  }

  /** Register (additional) subgroups so whole-group items expand to subgroup cells. */
  registerSubgroups(subgroups: readonly Subgroup[]): void {
    for (const sg of subgroups) {
      const list = this.subgroupsByGroup.get(sg.groupId) ?? [];
      if (!list.includes(sg.id)) list.push(sg.id);
      list.sort();
      this.subgroupsByGroup.set(sg.groupId, list);
    }
  }

  /** Subgroup ids of a group (sorted); empty when the group has no subgroups. */
  subgroupsOf(groupId: string): readonly string[] {
    return this.subgroupsByGroup.get(groupId) ?? [];
  }

  /** Block every target of every fixed block before the Solver runs. */
  seedFixedBlocks(
    fixedBlocks: readonly FixedBlock[],
    studentGroups: readonly StudentGroup[],
    subgroups: readonly Subgroup[] = [],
    options: SeedFixedBlockOptions = {},
  ): void {
    this.registerSubgroups(subgroups);
    for (const block of fixedBlocks) {
      const targets = resolveFixedBlockTargets(block, studentGroups, options);
      const itemId = fixedBlockItemId(block.id);
      const keys: string[] = [];
      for (let period = block.startPeriod; period < block.startPeriod + block.duration; period++) {
        for (const staffId of targets.staffIds) keys.push(cellKey(block.dayOfWeek, period, 'teacher', staffId));
        for (const cell of this.groupCells(block.dayOfWeek, period, targets.groupIds, null)) {
          keys.push(cellKey(cell.day, cell.period, cell.resourceType, cell.resourceId));
        }
        // A fixed block always closes its room exclusively, even multi-group rooms.
        for (const roomId of targets.roomIds) keys.push(cellKey(block.dayOfWeek, period, 'room', roomId));
      }
      this.claim(itemId, keys, { itemId, isFixedBlock: true, studentCount: 0 });
    }
  }

  /** Record an item (clashes are kept, not rejected). Re-adding an item replaces it. */
  addItem(params: OccupancyItemParams): void {
    this.removeItem(params.itemId);
    const plan = this.plan(params);
    const entry: OccupancyEntry = {
      itemId: params.itemId,
      isFixedBlock: params.isFixedBlock ?? false,
      studentCount: params.studentCount ?? 0,
    };
    this.claim(
      params.itemId,
      plan.exclusive.map((c) => cellKey(c.day, c.period, c.resourceType, c.resourceId)),
      entry,
    );
    const loadKeys = plan.shared.map((s) => roomLoadKey(s.day, s.period, s.roomId));
    for (const key of loadKeys) {
      const bucket = this.roomLoads.get(key) ?? new Map<string, OccupancyEntry>();
      bucket.set(params.itemId, entry);
      this.roomLoads.set(key, bucket);
    }
    if (loadKeys.length > 0) this.itemRoomLoads.set(params.itemId, loadKeys);
  }

  /** Remove every cell owned by an item (or fixed block item id). Returns false if unknown. */
  removeItem(itemId: string): boolean {
    const keys = this.itemCells.get(itemId);
    const loads = this.itemRoomLoads.get(itemId);
    if (!keys && !loads) return false;
    for (const key of keys ?? []) {
      const bucket = this.cells.get(key);
      bucket?.delete(itemId);
      if (bucket && bucket.size === 0) this.cells.delete(key);
    }
    for (const key of loads ?? []) {
      const bucket = this.roomLoads.get(key);
      bucket?.delete(itemId);
      if (bucket && bucket.size === 0) this.roomLoads.delete(key);
    }
    this.itemCells.delete(itemId);
    this.itemRoomLoads.delete(itemId);
    return true;
  }

  hasItem(itemId: string): boolean {
    return this.itemCells.has(itemId) || this.itemRoomLoads.has(itemId);
  }

  /** Entries occupying one exclusive cell (sorted by item id). */
  getEntries(day: number, period: number, resourceType: OccupancyResourceType, resourceId: string): OccupancyEntry[] {
    const bucket = this.cells.get(cellKey(day, period, resourceType, resourceId));
    return bucket ? [...bucket.values()].sort((a, b) => a.itemId.localeCompare(b.itemId)) : [];
  }

  isOccupied(day: number, period: number, resourceType: OccupancyResourceType, resourceId: string): boolean {
    return (this.cells.get(cellKey(day, period, resourceType, resourceId))?.size ?? 0) > 0;
  }

  /** Student load of a multi-group room at (day, period). */
  getRoomLoad(day: number, period: number, roomId: string): SharedRoomLoad {
    const bucket = this.roomLoads.get(roomLoadKey(day, period, roomId));
    if (!bucket) return { itemIds: [], studentCount: 0 };
    const entries = [...bucket.values()];
    return {
      itemIds: entries.map((e) => e.itemId).sort(),
      studentCount: entries.reduce((n, e) => n + e.studentCount, 0),
    };
  }

  /** Every clash the candidate would cause (its own previous placement is ignored). */
  findClashes(candidate: OccupancyItemParams): OccupancyClash[] {
    const plan = this.plan(candidate);
    const clashes: OccupancyClash[] = [];
    for (const cell of plan.exclusive) {
      const bucket = this.cells.get(cellKey(cell.day, cell.period, cell.resourceType, cell.resourceId));
      if (!bucket) continue;
      const blocking = [...bucket.keys()].filter((id) => id !== candidate.itemId).sort();
      if (blocking.length > 0) clashes.push({ ...cell, blockingItemIds: blocking, reason: 'exclusive' });
    }
    for (const s of plan.shared) {
      // Fixed blocks close multi-group rooms exclusively.
      const closed = this.cells.get(cellKey(s.day, s.period, 'room', s.roomId));
      const closedBy = closed ? [...closed.keys()].filter((id) => id !== candidate.itemId).sort() : [];
      if (closedBy.length > 0) {
        clashes.push({ day: s.day, period: s.period, resourceType: 'room', resourceId: s.roomId, blockingItemIds: closedBy, reason: 'exclusive' });
      }
      if (s.capacity === null) continue;
      const bucket = this.roomLoads.get(roomLoadKey(s.day, s.period, s.roomId));
      const others = bucket ? [...bucket.values()].filter((e) => e.itemId !== candidate.itemId) : [];
      const total = others.reduce((n, e) => n + e.studentCount, 0) + (candidate.studentCount ?? 0);
      if (total > s.capacity) {
        clashes.push({
          day: s.day,
          period: s.period,
          resourceType: 'room',
          resourceId: s.roomId,
          blockingItemIds: others.map((e) => e.itemId).sort(),
          reason: 'capacity',
          studentCount: total,
          capacity: s.capacity,
        });
      }
    }
    return clashes;
  }

  canPlace(candidate: OccupancyItemParams): boolean {
    return this.findClashes(candidate).length === 0;
  }

  /** Exclusive cells currently claimed by ≥2 owners (validator view), deterministic order. */
  conflicts(): OccupancyClash[] {
    const out: OccupancyClash[] = [];
    for (const [key, bucket] of this.cells) {
      if (bucket.size < 2) continue;
      out.push({ ...parseCellKey(key), blockingItemIds: [...bucket.keys()].sort(), reason: 'exclusive' });
    }
    return out.sort(compareCells);
  }

  /** Rows for `slot_occupancy` (fixed blocks included unless disabled), deterministic order. */
  toRows(versionId: string, options: { includeFixedBlocks?: boolean } = {}): SlotOccupancy[] {
    const includeFixed = options.includeFixedBlocks ?? true;
    const rows: SlotOccupancy[] = [];
    for (const [key, bucket] of this.cells) {
      const cell = parseCellKey(key);
      for (const entry of bucket.values()) {
        if (!includeFixed && entry.isFixedBlock) continue;
        rows.push({
          versionId,
          dayOfWeek: cell.day,
          period: cell.period,
          resourceType: cell.resourceType,
          resourceId: cell.resourceId,
          itemId: entry.itemId,
        });
      }
    }
    return rows.sort(
      (a, b) =>
        a.dayOfWeek - b.dayOfWeek ||
        a.period - b.period ||
        a.resourceType.localeCompare(b.resourceType) ||
        a.resourceId.localeCompare(b.resourceId) ||
        a.itemId.localeCompare(b.itemId),
    );
  }

  /** Deep copy (for Solver branching). */
  clone(): OccupancyIndex {
    const copy = new OccupancyIndex();
    for (const [groupId, list] of this.subgroupsByGroup) copy.subgroupsByGroup.set(groupId, [...list]);
    for (const [key, bucket] of this.cells) copy.cells.set(key, new Map(bucket));
    for (const [key, bucket] of this.roomLoads) copy.roomLoads.set(key, new Map(bucket));
    for (const [id, keys] of this.itemCells) copy.itemCells.set(id, [...keys]);
    for (const [id, keys] of this.itemRoomLoads) copy.itemRoomLoads.set(id, [...keys]);
    return copy;
  }

  get itemCount(): number {
    return new Set([...this.itemCells.keys(), ...this.itemRoomLoads.keys()]).size;
  }

  // -------------------------------------------------------------------------

  private claim(itemId: string, keys: string[], entry: OccupancyEntry): void {
    const unique = [...new Set(keys)];
    for (const key of unique) {
      const bucket = this.cells.get(key) ?? new Map<string, OccupancyEntry>();
      bucket.set(itemId, entry);
      this.cells.set(key, bucket);
    }
    const previous = this.itemCells.get(itemId) ?? [];
    this.itemCells.set(itemId, [...new Set([...previous, ...unique])]);
  }

  private groupCells(day: number, period: number, groupIds: readonly string[], subgroupId: string | null): OccupancyCell[] {
    if (subgroupId) return [{ day, period, resourceType: 'subgroup', resourceId: subgroupId }];
    const cells: OccupancyCell[] = [];
    for (const groupId of groupIds) {
      const subs = this.subgroupsByGroup.get(groupId);
      if (subs && subs.length > 0) {
        for (const sub of subs) cells.push({ day, period, resourceType: 'subgroup', resourceId: sub });
      } else {
        cells.push({ day, period, resourceType: 'group', resourceId: groupId });
      }
    }
    return cells;
  }

  private plan(params: OccupancyItemParams): PlannedClaims {
    const exclusive: OccupancyCell[] = [];
    const shared: PlannedClaims['shared'] = [];
    const duration = Math.max(1, params.duration);
    const teacherIds = [...new Set(params.teacherIds ?? [])];
    for (let period = params.startPeriod; period < params.startPeriod + duration; period++) {
      for (const staffId of teacherIds) exclusive.push({ day: params.day, period, resourceType: 'teacher', resourceId: staffId });
      exclusive.push(...this.groupCells(params.day, period, params.groupIds ?? [], params.subgroupId ?? null));
      const room = params.room;
      if (room) {
        if (room.allowMultiGroup) {
          shared.push({ day: params.day, period, roomId: room.id, capacity: room.capacity ?? null });
        } else {
          exclusive.push({ day: params.day, period, resourceType: 'room', resourceId: room.id });
        }
      }
    }
    const seen = new Set<string>();
    const dedup = exclusive.filter((c) => {
      const k = cellKey(c.day, c.period, c.resourceType, c.resourceId);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { exclusive: dedup, shared };
  }
}

const RESOURCE_ORDER: Record<OccupancyResourceType, number> = { teacher: 0, room: 1, group: 2, subgroup: 3 };

function compareCells(a: OccupancyCell, b: OccupancyCell): number {
  return (
    a.day - b.day ||
    a.period - b.period ||
    RESOURCE_ORDER[a.resourceType] - RESOURCE_ORDER[b.resourceType] ||
    a.resourceId.localeCompare(b.resourceId)
  );
}
