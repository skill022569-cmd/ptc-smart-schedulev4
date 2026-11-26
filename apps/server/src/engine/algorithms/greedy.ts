import { createSeededRng, type SeededRng } from '../rng';
import { buildScheduleTasks, taskNaturalKey, type ScheduleTask } from '../tasks';
import { SolverBoard, type CandidateMove } from '../feasibility';
import type { Room, ScheduleEvaluationContext, ScheduleItem, ScheduleItemTeacher } from '@ptc/shared';

export interface SolverOptions {
  seed?: number;
  maxIterations?: number;
  timeLimitMs?: number;
  versionId?: string;
  lockedItemIds?: ReadonlySet<string>;
}

export interface SolverOutput {
  items: ScheduleItem[];
  itemTeachers: ScheduleItemTeacher[];
  unplacedTasks: ScheduleTask[];
  board: SolverBoard;
}

/** Order tasks by Minimum Remaining Values heuristic (hardest-to-place first). */
export function orderTasksMrv(
  tasks: readonly ScheduleTask[],
  board: SolverBoard,
  rng: SeededRng,
): ScheduleTask[] {
  const scored = tasks.map((t) => {
    const rooms = board.candidateRoomsFor(t);
    const teachers = board.candidateTeacherSetsFor(t);
    const groupFlexibility = t.audienceGroupIds.reduce((minDays, gid) => {
      const g = board.groupById.get(gid);
      return Math.min(minDays, g?.allowedDays?.length ?? 5);
    }, 5);
    // Lower domainScore => harder to schedule => place earlier
    const domainScore =
      Math.max(1, rooms.length) * Math.max(1, teachers.length) * groupFlexibility -
      t.duration * 15 -
      (t.offeringType === 'combined' ? 40 : 0) -
      (t.isTeam ? 35 : 0) -
      (t.mustBeConsecutive ? 25 : 0) -
      (t.subgroupId ? 10 : 0);
    return { t, domainScore, tie: rng.next() };
  });
  scored.sort((a, b) => a.domainScore - b.domainScore || a.tie - b.tie);
  return scored.map((s) => s.t);
}

/** Pre-place locked items onto `board` so Solver/Repair never moves them. */
export function seedLockedItems(
  board: SolverBoard,
  ctx: ScheduleEvaluationContext,
  lockedItemIds: ReadonlySet<string>,
): { lockedItems: ScheduleItem[]; lockedSet: Set<string> } {
  const allTasks = buildScheduleTasks(ctx, []);
  const taskByKey = new Map(allTasks.map((t) => [taskNaturalKey(t.offeringId, t.segmentIndex, t.subgroupId), t]));
  const teachersByItem = new Map<string, string[]>();
  for (const it of ctx.itemTeachers) {
    const list = teachersByItem.get(it.itemId) ?? [];
    list.push(it.staffId);
    teachersByItem.set(it.itemId, list);
  }
  const lockedItems: ScheduleItem[] = [];
  const lockedSet = new Set<string>();
  for (const item of ctx.items) {
    const isLocked = item.isLocked || lockedItemIds.has(item.id);
    if (!isLocked || item.status === 'unplaced_tray' || item.dayOfWeek === null || item.startPeriod === null || !item.roomId) {
      continue;
    }
    const task = taskByKey.get(taskNaturalKey(item.offeringId, item.segmentIndex, item.subgroupId ?? null));
    if (!task) continue;
    lockedItems.push(item);
    lockedSet.add(item.id);
    board.place({
      task,
      itemId: item.id,
      day: item.dayOfWeek,
      startPeriod: item.startPeriod,
      roomId: item.roomId,
      teacherIds: teachersByItem.get(item.id) ?? task.preferredTeachers,
    });
  }
  return { lockedItems, lockedSet };
}

/** Pick the best Hard-feasible placement for `task` on `board`, or `null` if none exists. */
export function findBestCandidate(
  board: SolverBoard,
  task: ScheduleTask,
  rng: SeededRng,
  options: { excludeItemId?: string; topRoomLimit?: number } = {},
): CandidateMove | null {
  const rooms = board.candidateRoomsFor(task);
  if (rooms.length === 0) return null;
  const teacherSets = board.candidateTeacherSetsFor(task);
  if (teacherSets.length === 0) return null;

  const days = rng.shuffle(board.openDays);
  const periods = board.periods;
  // Check ALL candidate rooms (matching room types first, then fallback rooms if allowed)
  const matchingRooms: Room[] = [];
  const otherRooms: Room[] = [];
  for (const r of rooms) {
    if (!task.requiredRoomTypeId || r.roomTypeId === task.requiredRoomTypeId) matchingRooms.push(r);
    else otherRooms.push(r);
  }
  const candidateRooms =
    options.topRoomLimit !== undefined
      ? [...matchingRooms.slice(0, options.topRoomLimit), ...otherRooms.slice(0, options.topRoomLimit)]
      : [...matchingRooms, ...otherRooms];

  let best: CandidateMove | null = null;

  for (const day of days) {
    for (const startPeriod of periods) {
      if (!board.isSlotGroupFeasible(task, day, startPeriod)) continue;

      for (const teacherIds of teacherSets) {
        if (!board.isTeacherFeasible(task, day, startPeriod, teacherIds)) continue;

        let foundMatchingRoomInSlot = false;
        for (const room of candidateRooms) {
          const isMatch = !task.requiredRoomTypeId || room.roomTypeId === task.requiredRoomTypeId;
          // If we already found a matching-type room in this (day, startPeriod), skip fallback rooms
          if (!isMatch && foundMatchingRoomInSlot) break;
          if (!board.isIntrinsicallyFeasible(task, day, startPeriod, room, teacherIds)) continue;
          const clash = board.findBlockingItemIds(task, day, startPeriod, room, teacherIds);
          if (!clash.canPlace) continue;

          const score = board.scoreCandidate(task, day, startPeriod, room, teacherIds) + rng.next() * 0.05;
          if (best === null || score < best.softEstimate) {
            best = { day, startPeriod, roomId: room.id, teacherIds, softEstimate: score };
          }
          if (isMatch) {
            foundMatchingRoomInSlot = true;
            break; // smallest valid matching room is checked first
          }
        }
      }
    }
  }

  return best;
}

/** Constructive MRV Greedy Solver (baseline for Benchmark Q25). */
export function solveGreedy(ctx: ScheduleEvaluationContext, options: SolverOptions = {}): SolverOutput {
  const versionId = options.versionId ?? 'v1';
  const rng = createSeededRng(options.seed ?? 1);
  const board = new SolverBoard(ctx);
  const { lockedItems, lockedSet } = seedLockedItems(board, ctx, options.lockedItemIds ?? new Set());
  const tasks = orderTasksMrv(buildScheduleTasks(ctx, lockedItems), board, rng);
  const unplacedTasks: ScheduleTask[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const move = findBestCandidate(board, task, rng);
    if (!move) {
      unplacedTasks.push(task);
      continue;
    }
    board.place({
      task,
      itemId: `item:${task.taskId}`,
      day: move.day,
      startPeriod: move.startPeriod,
      roomId: move.roomId,
      teacherIds: move.teacherIds,
    });
  }

  const { items, itemTeachers } = board.toScheduleRows(versionId, lockedSet, unplacedTasks);
  return { items, itemTeachers, unplacedTasks, board };
}
