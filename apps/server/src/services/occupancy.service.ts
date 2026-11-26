import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  OccupancyIndex,
  resolveConstraintConfigs,
  type ScheduleEvaluationContext,
  type ScheduleItem,
  type ScheduleItemTeacher,
  type ScheduleVersion,
  type SlotOccupancy,
} from '@ptc/shared';
import { db } from '../db/client';
import {
  auditLogs,
  scheduleItemTeachers,
  scheduleItems,
  scheduleVersions,
  slotOccupancy,
} from '../db/schema';

const ITEM_BATCH_SIZE = 100;
const LINK_BATCH_SIZE = 250;

export function formatMysqlTimestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function safeUuid(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.slice(0, 36);
}

/**
 * Convert `ScheduleItem[]` into `SlotOccupancy[]` following the exact `slot_occupancy` rules
 * from `CLAUDE.md` via `@ptc/shared`'s `OccupancyIndex`.
 */
export function buildSlotOccupancyRows(
  versionId: string,
  ctx: ScheduleEvaluationContext,
  items: readonly ScheduleItem[],
  itemTeachers: readonly ScheduleItemTeacher[],
): SlotOccupancy[] {
  const { configs } = resolveConstraintConfigs(ctx);
  const occ = new OccupancyIndex(ctx.subgroups);
  if (configs.H08.mode === 'hard') {
    occ.seedFixedBlocks(ctx.fixedBlocks, ctx.studentGroups, ctx.subgroups, {
      staff: ctx.staff,
      rooms: ctx.rooms,
    });
  }

  const roomById = new Map(ctx.rooms.map((r) => [r.id, r]));
  const groupById = new Map(ctx.studentGroups.map((g) => [g.id, g]));
  const subgroupById = new Map(ctx.subgroups.map((sg) => [sg.id, sg]));
  const groupsByOffering = new Map<string, string[]>();
  for (const og of ctx.offeringGroups) {
    const list = groupsByOffering.get(og.offeringId) ?? [];
    if (!list.includes(og.groupId)) list.push(og.groupId);
    groupsByOffering.set(og.offeringId, list);
  }
  const teachersByItem = new Map<string, string[]>();
  for (const it of itemTeachers) {
    const list = teachersByItem.get(it.itemId) ?? [];
    if (!list.includes(it.staffId)) list.push(it.staffId);
    teachersByItem.set(it.itemId, list);
  }

  for (const item of items) {
    if (item.status === 'unplaced_tray' || item.dayOfWeek === null || item.startPeriod === null) continue;
    const room = item.roomId ? roomById.get(item.roomId) ?? null : null;
    const gIds = groupsByOffering.get(item.offeringId) ?? [];
    const audienceGroups = item.subgroupId
      ? (() => {
          const gid = subgroupById.get(item.subgroupId)?.groupId;
          return gid ? [gid] : gIds;
        })()
      : gIds;
    const studentCount = item.subgroupId
      ? subgroupById.get(item.subgroupId)?.studentCount ?? 0
      : audienceGroups.reduce((s, gid) => s + (groupById.get(gid)?.studentCount ?? 0), 0);

    occ.addItem({
      itemId: item.id,
      day: item.dayOfWeek,
      startPeriod: item.startPeriod,
      duration: item.duration,
      teacherIds: teachersByItem.get(item.id) ?? [],
      groupIds: audienceGroups,
      subgroupId: item.subgroupId,
      room,
      studentCount,
    });
  }

  return occ.toRows(versionId, { includeFixedBlocks: false });
}

export function prepareScheduleVersionPersistence(params: {
  version: ScheduleVersion;
  ctx: ScheduleEvaluationContext;
  items: readonly ScheduleItem[];
  itemTeachers: readonly ScheduleItemTeacher[];
}): {
  version: ScheduleVersion;
  items: ScheduleItem[];
  itemTeachers: ScheduleItemTeacher[];
  occRows: SlotOccupancy[];
} {
  const nowTs = formatMysqlTimestamp();
  const safeVersionId = params.version.id.length <= 36 ? params.version.id : randomUUID();
  const idMap = new Map<string, string>();
  const persistedItems: ScheduleItem[] = params.items.map((item) => {
    const newId = randomUUID();
    idMap.set(item.id, newId);
    return {
      ...item,
      id: newId,
      versionId: safeVersionId,
      updatedBy: safeUuid(item.updatedBy),
      updatedAt: item.updatedAt ?? nowTs,
    };
  });

  const seenLinks = new Set<string>();
  const persistedTeachers: ScheduleItemTeacher[] = [];
  for (const it of params.itemTeachers) {
    const mappedItemId = idMap.get(it.itemId);
    if (!mappedItemId) continue;
    const key = `${mappedItemId}|${it.staffId}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    persistedTeachers.push({ itemId: mappedItemId, staffId: it.staffId });
  }

  const occRows = buildSlotOccupancyRows(safeVersionId, params.ctx, persistedItems, persistedTeachers);
  const persistedVersion: ScheduleVersion = {
    ...params.version,
    id: safeVersionId,
    parentVersionId: safeUuid(params.version.parentVersionId),
    createdBy: safeUuid(params.version.createdBy),
    createdAt: params.version.createdAt ?? nowTs,
  };

  return {
    version: persistedVersion,
    items: persistedItems,
    itemTeachers: persistedTeachers,
    occRows,
  };
}

/**
 * Persist a complete `schedule_version`, its `schedule_items`, `schedule_item_teachers`,
 * and `slot_occupancy` inside a single TiDB transaction (enforcing `uq_no_clash` at DB level).
 */
export async function saveScheduleVersionAtomic(params: {
  version: ScheduleVersion;
  ctx: ScheduleEvaluationContext;
  items: readonly ScheduleItem[];
  itemTeachers: readonly ScheduleItemTeacher[];
  auditAccountId?: string | null;
  auditAction?: string;
}): Promise<{ versionId: string; itemCount: number; occupancyCount: number }> {
  const prepared = prepareScheduleVersionPersistence(params);

  await db.transaction(async (tx) => {
    await tx.insert(scheduleVersions).values(prepared.version as never);
    for (let i = 0; i < prepared.items.length; i += ITEM_BATCH_SIZE) {
      await tx.insert(scheduleItems).values(prepared.items.slice(i, i + ITEM_BATCH_SIZE) as never);
    }
    for (let i = 0; i < prepared.itemTeachers.length; i += LINK_BATCH_SIZE) {
      await tx.insert(scheduleItemTeachers).values(prepared.itemTeachers.slice(i, i + LINK_BATCH_SIZE) as never);
    }
    for (let i = 0; i < prepared.occRows.length; i += LINK_BATCH_SIZE) {
      await tx.insert(slotOccupancy).values(prepared.occRows.slice(i, i + LINK_BATCH_SIZE) as never);
    }
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      accountId: safeUuid(params.auditAccountId),
      action: params.auditAction ?? 'create_schedule_version',
      entity: 'schedule_versions',
      entityId: prepared.version.id,
      beforeData: null,
      afterData: { name: prepared.version.name, source: prepared.version.source, itemCount: prepared.items.length },
    });
  });

  return {
    versionId: prepared.version.id,
    itemCount: prepared.items.length,
    occupancyCount: prepared.occRows.length,
  };
}

/**
 * Atomically update one schedule item (move day/period/room/teachers or toggle lock),
 * rebuilding `slot_occupancy` for the item inside a transaction so TiDB `uq_no_clash` rejects clashes.
 */
export async function updateScheduleItemAtomic(params: {
  versionId: string;
  itemId: string;
  ctx: ScheduleEvaluationContext;
  patch: {
    dayOfWeek?: number | null;
    startPeriod?: number | null;
    roomId?: string | null;
    isLocked?: boolean;
    status?: 'scheduled' | 'unplaced_tray';
    teacherIds?: string[];
  };
  updatedBy?: string | null;
}): Promise<ScheduleItem> {
  const existing = params.ctx.items.find((i) => i.id === params.itemId && i.versionId === params.versionId);
  if (!existing) throw new Error(`Schedule item ${params.itemId} not found in version ${params.versionId}`);

  const updated: ScheduleItem = {
    ...existing,
    dayOfWeek: params.patch.dayOfWeek !== undefined ? params.patch.dayOfWeek : existing.dayOfWeek,
    startPeriod: params.patch.startPeriod !== undefined ? params.patch.startPeriod : existing.startPeriod,
    roomId: params.patch.roomId !== undefined ? params.patch.roomId : existing.roomId,
    isLocked: params.patch.isLocked !== undefined ? params.patch.isLocked : existing.isLocked,
    status: params.patch.status !== undefined ? params.patch.status : existing.status,
    rowVersion: (existing.rowVersion ?? 1) + 1,
    updatedBy: safeUuid(params.updatedBy) ?? 'scheduler',
    updatedAt: formatMysqlTimestamp(),
  };

  const nextTeachers: ScheduleItemTeacher[] =
    params.patch.teacherIds !== undefined
      ? params.patch.teacherIds.map((staffId) => ({ itemId: updated.id, staffId }))
      : params.ctx.itemTeachers.filter((it) => it.itemId === updated.id);

  const singleOcc = buildSlotOccupancyRows(params.versionId, params.ctx, [updated], nextTeachers);

  await db.transaction(async (tx) => {
    await tx.delete(slotOccupancy).where(eq(slotOccupancy.itemId, updated.id));
    if (params.patch.teacherIds !== undefined) {
      await tx.delete(scheduleItemTeachers).where(eq(scheduleItemTeachers.itemId, updated.id));
      if (nextTeachers.length > 0) {
        await tx.insert(scheduleItemTeachers).values(nextTeachers as never);
      }
    }
    await tx
      .update(scheduleItems)
      .set({
        dayOfWeek: updated.dayOfWeek,
        startPeriod: updated.startPeriod,
        roomId: updated.roomId,
        isLocked: updated.isLocked,
        status: updated.status,
        rowVersion: updated.rowVersion,
        updatedBy: updated.updatedBy,
        updatedAt: updated.updatedAt,
      })
      .where(eq(scheduleItems.id, updated.id));

    if (singleOcc.length > 0) {
      await tx.insert(slotOccupancy).values(singleOcc as never);
    }
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      accountId: safeUuid(params.updatedBy),
      action: 'move_item',
      entity: 'schedule_items',
      entityId: updated.id,
      beforeData: {
        dayOfWeek: existing.dayOfWeek,
        startPeriod: existing.startPeriod,
        roomId: existing.roomId,
        isLocked: existing.isLocked,
      },
      afterData: {
        dayOfWeek: updated.dayOfWeek,
        startPeriod: updated.startPeriod,
        roomId: updated.roomId,
        isLocked: updated.isLocked,
      },
    });
  });

  return updated;
}
