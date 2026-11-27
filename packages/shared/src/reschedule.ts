/**
 * Single-cell move & swap planner (used by the timetable editors).
 * For one placed item it lists every slot it can move to, every same-group item it can swap with, and the
 * rooms it could use instead — each blocked option with a short Thai reason. When a slot is blocked only by
 * the room, the option lists the free rooms (incl. shared halls / the college dome) that would make it work.
 * Pure — the server re-checks clashes in the DB.
 */
import { OccupancyIndex, type OccupancyClash } from './occupancy';
import type { ScheduleEvaluationContext } from './constraints/types';
import type { Room, ScheduleItem } from './types';

export type RescheduleContext = Pick<
  ScheduleEvaluationContext,
  'timeSlots' | 'rooms' | 'staff' | 'studentGroups' | 'subgroups' | 'subjects' | 'offerings' | 'offeringGroups' | 'items' | 'itemTeachers'
>;

export interface RoomChoice {
  id: string;
  code: string;
  capacity: number;
  /** Shared space several groups can use at once (hall / dome / activity yard). */
  shared: boolean;
}

export interface MoveOption {
  day: number;
  period: number;
  ok: boolean;
  reason?: string;
  /** Blocked only by the room: these free rooms would make the move possible. */
  altRooms?: RoomChoice[];
}

export interface SwapOption {
  otherItemId: string;
  day: number;
  period: number;
  ok: boolean;
  reason?: string;
}

export interface CellPlan {
  moves: MoveOption[];
  swaps: SwapOption[];
  /** Other rooms free at the item's current slot (change room without moving). */
  rooms: RoomChoice[];
}

const MAX_ROOM_CHOICES = 15;

function buildPlanner(ctx: RescheduleContext) {
  const roomById = new Map(ctx.rooms.map((r) => [r.id, r]));
  const staffName = new Map(ctx.staff.map((s) => [s.id, s.fullName]));
  const groupById = new Map(ctx.studentGroups.map((g) => [g.id, g]));
  const subById = new Map(ctx.subgroups.map((s) => [s.id, s]));
  const subjectOfOffering = new Map(
    ctx.offerings.map((o) => [o.id, ctx.subjects.find((s) => s.id === o.subjectId)?.subjectName ?? '']),
  );
  const groupsOf = new Map<string, string[]>();
  for (const og of ctx.offeringGroups) groupsOf.set(og.offeringId, [...(groupsOf.get(og.offeringId) ?? []), og.groupId]);
  const teachersOf = new Map<string, string[]>();
  for (const it of ctx.itemTeachers) teachersOf.set(it.itemId, [...(teachersOf.get(it.itemId) ?? []), it.staffId]);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const placed = ctx.items.filter((i) => i.status !== 'unplaced_tray' && i.dayOfWeek != null && i.startPeriod != null);

  const studentsOf = (it: ScheduleItem) =>
    it.subgroupId
      ? (subById.get(it.subgroupId)?.studentCount ?? 0)
      : (groupsOf.get(it.offeringId) ?? []).reduce((n, g) => n + (groupById.get(g)?.studentCount ?? 0), 0);
  /** `room` undefined = the item's own room; null = ignore rooms. */
  const params = (it: ScheduleItem, day: number, startPeriod: number, room?: Room | null) => ({
    itemId: it.id,
    day,
    startPeriod,
    duration: it.duration,
    teacherIds: teachersOf.get(it.id) ?? [],
    groupIds: groupsOf.get(it.offeringId) ?? [],
    subgroupId: it.subgroupId,
    room: room === undefined ? (it.roomId ? (roomById.get(it.roomId) ?? null) : null) : room,
    studentCount: studentsOf(it),
  });

  const occ = new OccupancyIndex(ctx.subgroups);
  for (const it of placed) occ.addItem(params(it, it.dayOfWeek!, it.startPeriod!));

  const open = new Set(ctx.timeSlots.flatMap((t) => (t.openDays ?? []).map((d) => `${d}:${t.period}`)));
  const groupLabel = (gid: string) => groupById.get(gid)?.groupCode ?? gid;
  const whoIsThere = (blockingId: string | undefined) => {
    const b = blockingId ? itemById.get(blockingId) : undefined;
    return b ? `${(groupsOf.get(b.offeringId) ?? []).map(groupLabel).join(', ')} (${subjectOfOffering.get(b.offeringId)})` : 'คาบอื่น';
  };
  const describe = (c: OccupancyClash, who: string) => {
    const at = whoIsThere(c.blockingItemIds[0]);
    if (c.resourceType === 'teacher') return `${who}${staffName.get(c.resourceId) ?? 'ครู'} ติดสอน ${at} ในคาบนี้`;
    if (c.resourceType === 'room') {
      const code = roomById.get(c.resourceId)?.roomCode ?? '';
      return c.reason === 'capacity' ? `${who}${code} มีคนใช้อยู่จนเต็มความจุ` : `${who}ห้อง ${code} ถูกใช้โดย ${at}`;
    }
    return `${who}กลุ่ม ${groupLabel(c.resourceId)} มีเรียน ${at} อยู่แล้ว`;
  };
  // Reasons a window can never hold this item, independent of other items.
  const windowProblem = (it: ScheduleItem, day: number, start: number): string | undefined => {
    for (let k = 0; k < it.duration; k++) if (!open.has(`${day}:${start + k}`)) return 'อยู่นอกช่วงเวลาเรียนของวันนั้น';
    for (const gid of groupsOf.get(it.offeringId) ?? []) {
      const lunch = groupById.get(gid)?.lunchPeriod;
      if (lunch != null && lunch >= start && lunch < start + it.duration) return `ทับคาบพักกลางวัน (คาบ ${lunch})`;
    }
    return undefined;
  };
  const capacityProblem = (it: ScheduleItem, room: Room | null) => {
    const n = studentsOf(it);
    return room && !room.allowMultiGroup && room.capacity < n ? `ห้อง ${room.roomCode} จุได้ ${room.capacity} คน แต่มีผู้เรียน ${n} คน` : undefined;
  };
  /** Why `it` cannot sit at (day, start) in `room` (undefined = own room), or undefined if it can. */
  const check = (it: ScheduleItem, day: number, start: number, room?: Room | null) => {
    const p = params(it, day, start, room);
    return windowProblem(it, day, start) ?? capacityProblem(it, p.room) ?? (occ.findClashes(p)[0] ? describe(occ.findClashes(p)[0]!, '') : undefined);
  };
  const preferredType = (it: ScheduleItem) => (it.roomId ? roomById.get(it.roomId)?.roomTypeId : undefined);
  /** Free rooms for `it` at (day, start): same room type first, then smallest that fits; shared halls always listed. */
  const freeRooms = (it: ScheduleItem, day: number, start: number): RoomChoice[] => {
    const free = ctx.rooms.filter((r) => r.id !== it.roomId && !check(it, day, start, r));
    const type = preferredType(it);
    free.sort((a, b) => Number(b.roomTypeId === type) - Number(a.roomTypeId === type) || a.capacity - b.capacity);
    const shared = free.filter((r) => r.allowMultiGroup);
    const rest = free.filter((r) => !r.allowMultiGroup).slice(0, MAX_ROOM_CHOICES - shared.length);
    return [...rest, ...shared].map((r) => ({ id: r.id, code: r.roomCode, capacity: r.capacity, shared: Boolean(r.allowMultiGroup) }));
  };

  return { roomById, staffName, groupsOf, teachersOf, placed, occ, params, describe, windowProblem, check, freeRooms };
}

export function planCellActions(ctx: RescheduleContext, itemId: string): CellPlan {
  const item = ctx.items.find((i) => i.id === itemId);
  if (!item) return { moves: [], swaps: [], rooms: [] };
  const P = buildPlanner(ctx);

  const lockedReason = 'คาบนี้ถูกล็อกไว้ ย้ายหรือสลับไม่ได้';
  const days = [...new Set(ctx.timeSlots.flatMap((t) => t.openDays ?? []))].sort((a, b) => a - b);
  const periods = [...new Set(ctx.timeSlots.map((t) => t.period))].sort((a, b) => a - b);

  const moves: MoveOption[] = [];
  for (const day of days) {
    for (const period of periods) {
      if (day === item.dayOfWeek && period === item.startPeriod) continue;
      const reason = item.isLocked ? lockedReason : P.check(item, day, period);
      if (!reason) {
        moves.push({ day, period, ok: true });
        continue;
      }
      // Only the room is in the way? Offer the rooms that are free there.
      const altRooms = !item.isLocked && !P.check(item, day, period, null) ? P.freeRooms(item, day, period) : [];
      moves.push(altRooms.length ? { day, period, ok: false, reason, altRooms } : { day, period, ok: false, reason });
    }
  }

  const placedHere = item.dayOfWeek != null && item.startPeriod != null && item.status !== 'unplaced_tray';
  const rooms = placedHere && !item.isLocked ? P.freeRooms(item, item.dayOfWeek!, item.startPeriod!) : [];

  const swaps: SwapOption[] = [];
  if (placedHere) {
    const myGroups = new Set(P.groupsOf.get(item.offeringId) ?? []);
    const myTeachers = (P.teachersOf.get(item.id) ?? []).map((t) => P.staffName.get(t) ?? '').join(', ');
    for (const other of P.placed) {
      if (other.id === item.id || !(P.groupsOf.get(other.offeringId) ?? []).some((g) => myGroups.has(g))) continue;
      const base = { otherItemId: other.id, day: other.dayOfWeek!, period: other.startPeriod! };
      const otherTeachers = (P.teachersOf.get(other.id) ?? []).map((t) => P.staffName.get(t) ?? '').join(', ');
      let reason: string | undefined;
      if (item.isLocked || other.isLocked) reason = lockedReason;
      else if (other.duration !== item.duration) reason = `จำนวนคาบไม่เท่ากัน (${item.duration} กับ ${other.duration} คาบ)`;
      else reason = P.windowProblem(item, base.day, base.period) ?? P.windowProblem(other, item.dayOfWeek!, item.startPeriod!);
      if (!reason) {
        // Take both out, test each in the other's slot, then put both back (cheaper than cloning the index).
        P.occ.removeItem(item.id);
        P.occ.removeItem(other.id);
        const a = P.occ.findClashes(P.params(item, base.day, base.period))[0];
        const b = a ? undefined : P.occ.findClashes(P.params(other, item.dayOfWeek!, item.startPeriod!))[0];
        P.occ.addItem(P.params(item, item.dayOfWeek!, item.startPeriod!));
        P.occ.addItem(P.params(other, base.day, base.period));
        if (a) reason = P.describe(a, a.resourceType === 'teacher' ? `${myTeachers || 'ครู'} ไม่ว่างในคาบปลายทาง: ` : '');
        else if (b) reason = P.describe(b, b.resourceType === 'teacher' ? `${otherTeachers || 'ครู'} ไม่ว่างในคาบต้นทาง: ` : '');
      }
      swaps.push(reason ? { ...base, ok: false, reason } : { ...base, ok: true });
    }
  }
  return { moves, swaps, rooms };
}

/**
 * Why `itemId` cannot be taught at (day, period) in `roomId` (undefined = its own room), or undefined
 * if it can. The item's own current placement is ignored.
 */
export function placementProblem(ctx: RescheduleContext, itemId: string, day: number, period: number, roomId?: string | null): string | undefined {
  const item = ctx.items.find((i) => i.id === itemId);
  if (!item) return 'ไม่พบคาบเรียน';
  if (item.isLocked) return 'คาบนี้ถูกล็อกไว้ ย้ายหรือสลับไม่ได้';
  const P = buildPlanner(ctx);
  P.occ.removeItem(item.id);
  const room = roomId === undefined ? undefined : roomId === null ? null : P.roomById.get(roomId);
  if (roomId && !room) return 'ไม่พบห้องเรียนที่เลือก';
  return P.check(item, day, period, room);
}
