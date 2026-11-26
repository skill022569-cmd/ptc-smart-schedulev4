import { createSeededRng, type SeededRng } from '../rng';
import { buildScheduleTasks, type ScheduleTask } from '../tasks';
import { SolverBoard, type SolverPlacement } from '../feasibility';
import { findBestCandidate, orderTasksMrv, seedLockedItems, type SolverOptions, type SolverOutput } from './greedy';
import type { ScheduleEvaluationContext } from '@ptc/shared';

interface EjectionCandidate {
  day: number;
  startPeriod: number;
  roomId: string;
  teacherIds: string[];
  blockers: SolverPlacement[];
  score: number;
}

/**
 * Try to place `task` by recursively relocating up to `maxDepth` unlocked blocking items
 * (ejection-chain / Kempe-chain style backtracking). Restores board on failure.
 */
function placeWithEjection(
  board: SolverBoard,
  task: ScheduleTask,
  itemId: string,
  lockedIds: ReadonlySet<string>,
  rng: SeededRng,
  depth: number,
  maxDepth: number,
  visitedTasks: Set<string>,
): boolean {
  // Fast path: direct placement without eviction
  const direct = findBestCandidate(board, task, rng);
  if (direct) {
    board.place({
      task,
      itemId,
      day: direct.day,
      startPeriod: direct.startPeriod,
      roomId: direct.roomId,
      teacherIds: direct.teacherIds,
    });
    return true;
  }
  if (depth >= maxDepth) return false;

  const rooms = board.candidateRoomsFor(task);
  const teacherSets = board.candidateTeacherSetsFor(task);
  if (rooms.length === 0 || teacherSets.length === 0) return false;

  const candidates: EjectionCandidate[] = [];
  const days = rng.shuffle(board.openDays);
  const candidateRooms = rooms;

  for (const day of days) {
    for (const startPeriod of board.periods) {
      for (const teacherIds of teacherSets) {
        for (const room of candidateRooms) {
          if (!board.isIntrinsicallyFeasible(task, day, startPeriod, room, teacherIds)) continue;
          const clash = board.findBlockingItemIds(task, day, startPeriod, room, teacherIds);
          if (clash.hitsFixedBlock || clash.blockingItemIds.length === 0 || clash.blockingItemIds.length > 2) continue;
          if (clash.blockingItemIds.some((bid) => lockedIds.has(bid))) continue;

          const blockers: SolverPlacement[] = [];
          let valid = true;
          for (const bid of clash.blockingItemIds) {
            const b = board.placements.get(bid);
            if (!b || visitedTasks.has(b.task.taskId)) {
              valid = false;
              break;
            }
            blockers.push(b);
          }
          if (!valid) continue;

          const baseScore = board.scoreCandidate(task, day, startPeriod, room, teacherIds);
          candidates.push({
            day,
            startPeriod,
            roomId: room.id,
            teacherIds,
            blockers,
            score: blockers.length * 100 + baseScore + rng.next() * 0.1,
          });
          if (candidates.length >= 24) break;
        }
        if (candidates.length >= 24) break;
      }
      if (candidates.length >= 24) break;
    }
    if (candidates.length >= 24) break;
  }

  candidates.sort((a, b) => a.score - b.score);
  const tryLimit = Math.min(candidates.length, 10);

  for (let i = 0; i < tryLimit; i++) {
    const cand = candidates[i]!;
    const snapshot = [...board.placements.values()];
    for (const b of cand.blockers) board.unplace(b.itemId);
    board.place({
      task,
      itemId,
      day: cand.day,
      startPeriod: cand.startPeriod,
      roomId: cand.roomId,
      teacherIds: cand.teacherIds,
    });
    visitedTasks.add(task.taskId);

    let allReplaced = true;
    for (const b of cand.blockers) {
      if (
        !placeWithEjection(
          board,
          b.task,
          b.itemId,
          lockedIds,
          rng,
          depth + 1,
          maxDepth,
          visitedTasks,
        )
      ) {
        allReplaced = false;
        break;
      }
    }

    if (allReplaced) return true;

    // Exact rollback via snapshot (prevents any stale overwrite from recursive child ejections)
    visitedTasks.delete(task.taskId);
    for (const existing of [...board.placements.values()]) board.unplace(existing.itemId);
    for (const prev of snapshot) board.place(prev);
  }

  return false;
}

/**
 * CSP Solver (MRV + Forward Checking + Ejection-Chain Backtracking Repair).
 * Aims for 0 unplaced tasks and 0 Hard violations within time budget.
 */
export function solveCsp(ctx: ScheduleEvaluationContext, options: SolverOptions = {}): SolverOutput {
  const versionId = options.versionId ?? 'v1';
  const baseSeed = options.seed ?? 1;
  const maxRestarts = Math.max(1, Math.min(6, options.maxIterations ?? 4));
  const deadline = Date.now() + (options.timeLimitMs ?? 30_000);

  let bestOutput: SolverOutput | null = null;

  for (let attempt = 0; attempt < maxRestarts; attempt++) {
    const rng = createSeededRng(baseSeed + attempt * 7919);
    const board = new SolverBoard(ctx);
    const { lockedItems, lockedSet } = seedLockedItems(board, ctx, options.lockedItemIds ?? new Set());
    const ordered = orderTasksMrv(buildScheduleTasks(ctx, lockedItems), board, rng);
    const unplaced: ScheduleTask[] = [];

    for (const task of ordered) {
      const itemId = `item:${task.taskId}`;
      const move = findBestCandidate(board, task, rng);
      if (move) {
        board.place({
          task,
          itemId,
          day: move.day,
          startPeriod: move.startPeriod,
          roomId: move.roomId,
          teacherIds: move.teacherIds,
        });
      } else {
        unplaced.push(task);
      }
    }

    // Ejection-chain pass for any unplaced tasks
    const stillUnplaced: ScheduleTask[] = [];
    for (const task of unplaced) {
      if (Date.now() > deadline) {
        stillUnplaced.push(task);
        continue;
      }
      const ok = placeWithEjection(
        board,
        task,
        `item:${task.taskId}`,
        lockedSet,
        rng,
        0,
        3,
        new Set<string>(),
      );
      if (!ok) stillUnplaced.push(task);
    }

    const { items, itemTeachers } = board.toScheduleRows(versionId, lockedSet, stillUnplaced);
    const current: SolverOutput = { items, itemTeachers, unplacedTasks: stillUnplaced, board };

    if (!bestOutput || current.unplacedTasks.length < bestOutput.unplacedTasks.length) {
      bestOutput = current;
    }
    if (stillUnplaced.length === 0) break;
    if (Date.now() > deadline) break;
  }

  return bestOutput!;
}
