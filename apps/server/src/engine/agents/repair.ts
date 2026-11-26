import {
  evaluateSchedule,
  renderMessageTh,
  type IssueReport,
  type ScheduleEvaluationContext,
  type ScheduleItem,
  type ScheduleItemTeacher,
} from '@ptc/shared';
import { createSeededRng } from '../rng';
import { buildScheduleTasks, taskNaturalKey } from '../tasks';
import { SolverBoard } from '../feasibility';
import { findBestCandidate, type SolverOutput } from '../algorithms/greedy';
import { solveCsp } from '../algorithms/csp';

export interface RepairResult {
  output: SolverOutput;
  movedCount: number;
  hardCount: number;
  totalPenalty: number;
  fitness: number;
}

export interface FixOption {
  optionIndex: number;
  labelTh: string;
  descriptionTh: string;
  movedItemsCount: number;
  deltaPenalty: number;
  hardCount: number;
  items: ScheduleItem[];
  itemTeachers: ScheduleItemTeacher[];
  changes: Array<{ itemId: string; day: number | null; startPeriod: number | null; roomId: string | null; teacherIds: string[] }>;
}

export interface EmergencyFixProposal {
  issueId: string;
  category: IssueReport['category'];
  affectedDate: string;
  dayOfWeek: number;
  affectedItemCount: number;
  options: Array<{
    action: 'substitute' | 'room_change' | 'makeup' | 'cancel';
    labelTh: string;
    movedItemsCount: number;
    details: Array<{
      itemId: string;
      offeringId: string;
      substituteStaffId?: string;
      newRoomId?: string;
      makeupDay?: number;
      makeupPeriod?: number;
    }>;
  }>;
}

/**
 * Repair Agent: Keeps all valid non-violating items locked, unlocks only violated or
 * unplaced items (plus explicit unlocked IDs), and repairs to reach Hard Violation = 0
 * while minimizing S07 MIN_CHANGES.
 */
export function runRepair(
  ctx: ScheduleEvaluationContext,
  options: { seed?: number; timeLimitMs?: number; versionId?: string; extraUnlockedIds?: ReadonlySet<string> } = {},
): RepairResult {
  const versionId = options.versionId ?? 'v1';
  const beforeReport = evaluateSchedule(ctx, { includePassedExplanations: false });
  const badIds = new Set<string>(options.extraUnlockedIds ?? []);
  for (const v of beforeReport.hardViolations) {
    for (const id of v.itemIds) badIds.add(id);
  }
  for (const item of ctx.items) {
    if (item.status === 'unplaced_tray' || item.dayOfWeek === null || item.startPeriod === null) {
      badIds.add(item.id);
    }
  }

  const lockedIds = new Set<string>();
  const repairedItems: ScheduleItem[] = ctx.items.map((item) => {
    const keepLocked = !badIds.has(item.id);
    if (keepLocked) lockedIds.add(item.id);
    return { ...item, isLocked: keepLocked };
  });

  const repairedCtx: ScheduleEvaluationContext = {
    ...ctx,
    items: repairedItems,
    baselineItems: ctx.baselineItems ?? ctx.items,
    baselineItemTeachers: ctx.baselineItemTeachers ?? ctx.itemTeachers,
  };

  let output = solveCsp(repairedCtx, {
    seed: options.seed ?? 1,
    maxIterations: 4,
    timeLimitMs: options.timeLimitMs ?? 15_000,
    versionId,
    lockedItemIds: lockedIds,
  });

  let afterReport = evaluateSchedule(
    { ...repairedCtx, items: output.items, itemTeachers: output.itemTeachers },
    { includePassedExplanations: false },
  );

  // If keeping strict locks left unplaced/violating items (e.g. a large Lucky Challenge), unlock & solve freely
  if (afterReport.hardCount > 0 || output.unplacedTasks.length > 0) {
    const freeCtx: ScheduleEvaluationContext = {
      ...ctx,
      items: ctx.items.map((i) => ({ ...i, isLocked: false })),
      baselineItems: ctx.baselineItems ?? ctx.items,
      baselineItemTeachers: ctx.baselineItemTeachers ?? ctx.itemTeachers,
    };
    output = solveCsp(freeCtx, {
      seed: options.seed ?? 1,
      maxIterations: 4,
      timeLimitMs: options.timeLimitMs ?? 15_000,
      versionId,
      lockedItemIds: new Set(),
    });
    afterReport = evaluateSchedule(
      { ...freeCtx, items: output.items, itemTeachers: output.itemTeachers },
      { includePassedExplanations: false },
    );
  }

  const beforeMap = new Map(ctx.items.map((i) => [taskNaturalKey(i.offeringId, i.segmentIndex, i.subgroupId ?? null), i]));
  let movedCount = 0;
  for (const item of output.items) {
    const prev = beforeMap.get(taskNaturalKey(item.offeringId, item.segmentIndex, item.subgroupId ?? null));
    if (
      !prev ||
      prev.dayOfWeek !== item.dayOfWeek ||
      prev.startPeriod !== item.startPeriod ||
      (prev.roomId ?? null) !== (item.roomId ?? null)
    ) {
      movedCount++;
    }
  }

  return {
    output,
    movedCount,
    hardCount: afterReport.hardCount,
    totalPenalty: afterReport.totalPenalty,
    fitness: afterReport.fitness,
  };
}

/**
 * Generate up to 3 validated 1-Click Fix options for a target scheduled/unplaced item.
 * Each option guarantees Hard Violation = 0 (or strict improvement) and states exact movedItemsCount.
 */
export function proposeFixOptions(
  ctx: ScheduleEvaluationContext,
  targetItemId: string,
): FixOption[] {
  const targetItem = ctx.items.find((i) => i.id === targetItemId);
  if (!targetItem) return [];

  const baselineReport = evaluateSchedule(ctx, { includePassedExplanations: false });
  const board = new SolverBoard(ctx);
  const allTasks = buildScheduleTasks(ctx, []);
  const taskByKey = new Map(allTasks.map((t) => [taskNaturalKey(t.offeringId, t.segmentIndex, t.subgroupId), t]));
  const targetTask = taskByKey.get(taskNaturalKey(targetItem.offeringId, targetItem.segmentIndex, targetItem.subgroupId ?? null));
  if (!targetTask) return [];

  const teachersByItem = new Map<string, string[]>();
  for (const it of ctx.itemTeachers) {
    const l = teachersByItem.get(it.itemId) ?? [];
    l.push(it.staffId);
    teachersByItem.set(it.itemId, l);
  }

  // Place all OTHER scheduled items onto board
  for (const item of ctx.items) {
    if (item.id === targetItemId) continue;
    if (item.status === 'unplaced_tray' || item.dayOfWeek === null || item.startPeriod === null || !item.roomId) continue;
    const t = taskByKey.get(taskNaturalKey(item.offeringId, item.segmentIndex, item.subgroupId ?? null));
    if (!t) continue;
    board.place({
      task: t,
      itemId: item.id,
      day: item.dayOfWeek,
      startPeriod: item.startPeriod,
      roomId: item.roomId,
      teacherIds: teachersByItem.get(item.id) ?? t.preferredTeachers,
    });
  }

  const options: FixOption[] = [];
  const rng = createSeededRng(42);
  const rooms = board.candidateRoomsFor(targetTask).slice(0, 12);
  const teacherSets = board.candidateTeacherSetsFor(targetTask);

  // Collect direct clash-free placements
  for (const tSet of teacherSets) {
    for (const day of board.openDays) {
      for (const period of board.periods) {
        for (const room of rooms) {
          if (!board.isIntrinsicallyFeasible(targetTask, day, period, room, tSet)) continue;
          const clash = board.findBlockingItemIds(targetTask, day, period, room, tSet);
          if (!clash.canPlace) continue;
          if (
            targetItem.dayOfWeek === day &&
            targetItem.startPeriod === period &&
            targetItem.roomId === room.id
          ) {
            continue;
          }

          const newItems = ctx.items.map((i) =>
            i.id === targetItemId
              ? { ...i, dayOfWeek: day, startPeriod: period, roomId: room.id, status: 'scheduled' as const }
              : i,
          );
          const newItemTeachers = [
            ...ctx.itemTeachers.filter((it) => it.itemId !== targetItemId),
            ...tSet.map((sid) => ({ itemId: targetItemId, staffId: sid })),
          ];
          const rep = evaluateSchedule(
            { ...ctx, items: newItems, itemTeachers: newItemTeachers },
            { includePassedExplanations: false },
          );
          if (rep.hardCount > 0 && rep.hardCount >= baselineReport.hardCount) continue;

          const label = `ย้ายไปวัน ${day} คาบ ${period} ห้อง ${room.roomCode}`;
          if (options.some((o) => o.labelTh === label)) continue;

          options.push({
            optionIndex: options.length + 1,
            labelTh: label,
            descriptionTh: renderMessageTh('S07.changed', {
              subject: targetItem.offeringId,
              before: targetItem.dayOfWeek ? `วัน ${targetItem.dayOfWeek} คาบ ${targetItem.startPeriod}` : 'ถาดรอจัด',
              after: `วัน ${day} คาบ ${period} ห้อง ${room.roomCode}`,
            }),
            movedItemsCount: 1,
            deltaPenalty: Math.round((rep.totalPenalty - baselineReport.totalPenalty) * 100) / 100,
            hardCount: rep.hardCount,
            items: newItems,
            itemTeachers: newItemTeachers,
            changes: [{ itemId: targetItemId, day, startPeriod: period, roomId: room.id, teacherIds: tSet }],
          });
          if (options.length >= 3) return options;
        }
      }
    }
  }

  // If < 3 options, try 1-swap repair via full repair fallback
  if (options.length === 0) {
    const repRes = runRepair(ctx, { extraUnlockedIds: new Set([targetItemId]), seed: 99, timeLimitMs: 5000 });
    if (repRes.hardCount === 0) {
      options.push({
        optionIndex: 1,
        labelTh: `จัดใหม่อัตโนมัติ (ย้าย ${repRes.movedCount} คาบ)`,
        descriptionTh: `Repair Agent ย้ายรายการที่เกี่ยวข้อง ${repRes.movedCount} คาบ โดยยังคง Hard Violation = 0`,
        movedItemsCount: repRes.movedCount,
        deltaPenalty: Math.round((repRes.totalPenalty - baselineReport.totalPenalty) * 100) / 100,
        hardCount: repRes.hardCount,
        items: repRes.output.items,
        itemTeachers: repRes.output.itemTeachers,
        changes: [],
      });
    }
  }

  void findBestCandidate;
  void rng;
  return options;
}

/** ISO weekday 1 (Mon) .. 7 (Sun) from `YYYY-MM-DD`. */
function isoWeekday(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 1;
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Propose date-specific emergency repair plans (`schedule_exceptions` actions)
 * without breaking the master weekly timetable (Req 20).
 */
export function proposeEmergencyFix(
  ctx: ScheduleEvaluationContext,
  issue: Pick<IssueReport, 'id' | 'category' | 'affectedDate' | 'affectedStaffId' | 'affectedRoomId'>,
): EmergencyFixProposal {
  const dayOfWeek = isoWeekday(issue.affectedDate);
  const teachersByItem = new Map<string, string[]>();
  for (const it of ctx.itemTeachers) {
    const l = teachersByItem.get(it.itemId) ?? [];
    l.push(it.staffId);
    teachersByItem.set(it.itemId, l);
  }
  const offById = new Map(ctx.offerings.map((o) => [o.id, o]));
  const roomById = new Map(ctx.rooms.map((r) => [r.id, r]));

  const affectedItems = ctx.items.filter((item) => {
    if (item.status === 'unplaced_tray' || item.dayOfWeek !== dayOfWeek) return false;
    if (issue.category === 'teacher_leave' && issue.affectedStaffId) {
      return (teachersByItem.get(item.id) ?? []).includes(issue.affectedStaffId);
    }
    if (issue.category === 'room_outage' && issue.affectedRoomId) {
      return item.roomId === issue.affectedRoomId;
    }
    return false;
  });

  const board = new SolverBoard(ctx);
  const allTasks = buildScheduleTasks(ctx, []);
  const taskByKey = new Map(allTasks.map((t) => [taskNaturalKey(t.offeringId, t.segmentIndex, t.subgroupId), t]));
  for (const item of ctx.items) {
    if (item.status === 'unplaced_tray' || item.dayOfWeek === null || item.startPeriod === null || !item.roomId) continue;
    const t = taskByKey.get(taskNaturalKey(item.offeringId, item.segmentIndex, item.subgroupId ?? null));
    if (!t) continue;
    board.place({
      task: t,
      itemId: item.id,
      day: item.dayOfWeek,
      startPeriod: item.startPeriod,
      roomId: item.roomId,
      teacherIds: teachersByItem.get(item.id) ?? t.preferredTeachers,
    });
  }

  const options: EmergencyFixProposal['options'] = [];

  if (issue.category === 'teacher_leave') {
    const subDetails: EmergencyFixProposal['options'][number]['details'] = [];
    for (const item of affectedItems) {
      const off = offById.get(item.offeringId);
      const eligible = ctx.eligibilities
        .filter((e) => e.subjectId === off?.subjectId && e.staffId !== issue.affectedStaffId)
        .map((e) => e.staffId);
      let chosenSub: string | undefined;
      for (const sid of eligible) {
        const busy = board.occupancy.findClashes({
          itemId: `probe:${item.id}`,
          day: item.dayOfWeek!,
          startPeriod: item.startPeriod!,
          duration: item.duration,
          teacherIds: [sid],
        });
        if (busy.length === 0) {
          chosenSub = sid;
          break;
        }
      }
      if (chosenSub) {
        subDetails.push({ itemId: item.id, offeringId: item.offeringId, substituteStaffId: chosenSub });
      }
    }
    if (subDetails.length > 0) {
      options.push({
        action: 'substitute',
        labelTh: `จัดครูสอนแทนเฉพาะวันที่ ${issue.affectedDate} (${subDetails.length}/${affectedItems.length} คาบ)`,
        movedItemsCount: 0,
        details: subDetails,
      });
    }
  }

  if (issue.category === 'room_outage') {
    const roomDetails: EmergencyFixProposal['options'][number]['details'] = [];
    for (const item of affectedItems) {
      const t = taskByKey.get(taskNaturalKey(item.offeringId, item.segmentIndex, item.subgroupId ?? null));
      if (!t) continue;
      for (const room of board.candidateRoomsFor(t)) {
        if (room.id === issue.affectedRoomId) continue;
        const clash = board.occupancy.findClashes({
          itemId: `probe:${item.id}`,
          day: item.dayOfWeek!,
          startPeriod: item.startPeriod!,
          duration: item.duration,
          room,
          studentCount: t.studentCount,
        });
        if (clash.length === 0 && roomById.has(room.id)) {
          roomDetails.push({ itemId: item.id, offeringId: item.offeringId, newRoomId: room.id });
          break;
        }
      }
    }
    if (roomDetails.length > 0) {
      options.push({
        action: 'room_change',
        labelTh: `ย้ายห้องสำรองเฉพาะวันที่ ${issue.affectedDate} (${roomDetails.length}/${affectedItems.length} คาบ)`,
        movedItemsCount: roomDetails.length,
        details: roomDetails,
      });
    }
  }

  // Always offer makeup / cancel fallback option
  options.push({
    action: 'makeup',
    labelTh: `นัดสอนชดเชยในสัปดาห์ถัดไปสำหรับ ${affectedItems.length} คาบที่กระทบ (ไม่แก้ตารางหลัก)`,
    movedItemsCount: affectedItems.length,
    details: affectedItems.map((item) => ({
      itemId: item.id,
      offeringId: item.offeringId,
      makeupDay: (dayOfWeek % 5) + 1,
      makeupPeriod: item.startPeriod ?? 1,
    })),
  });

  return {
    issueId: issue.id,
    category: issue.category,
    affectedDate: issue.affectedDate,
    dayOfWeek,
    affectedItemCount: affectedItems.length,
    options,
  };
}
