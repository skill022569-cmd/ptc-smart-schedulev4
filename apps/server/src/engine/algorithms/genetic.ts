import { evaluateSchedule, type ScheduleEvaluationContext, type ScheduleItem } from '@ptc/shared';
import { createSeededRng, type SeededRng } from '../rng';
import { SolverBoard, type SolverPlacement } from '../feasibility';
import { findBestCandidate, type SolverOptions, type SolverOutput } from './greedy';
import { solveCsp } from './csp';

export interface EvaluatedIndividual {
  output: SolverOutput;
  hardCount: number;
  totalPenalty: number;
  fitness: number;
}

/**
 * Evaluate a SolverBoard directly with `@ptc/shared`'s `evaluateSchedule` so optimization
 * uses the exact official fitness function `1000 / (1 + totalPenalty)`.
 */
export function evaluateBoard(
  ctx: ScheduleEvaluationContext,
  output: SolverOutput,
): EvaluatedIndividual {
  const report = evaluateSchedule(
    {
      ...ctx,
      items: output.items,
      itemTeachers: output.itemTeachers,
    },
    { includePassedExplanations: false },
  );
  return {
    output,
    hardCount: report.hardCount,
    totalPenalty: report.totalPenalty,
    fitness: report.fitness,
  };
}

/**
 * Attempt one Hard-feasible neighborhood move or two-item swap on `board`.
 * Always restores the previous board state if feasibility fails.
 */
export function tryFeasiblePerturbation(
  board: SolverBoard,
  lockedIds: ReadonlySet<string>,
  rng: SeededRng,
): boolean {
  const unlocked = [...board.placements.values()].filter((p) => !lockedIds.has(p.itemId));
  if (unlocked.length === 0) return false;

  const target = rng.pick(unlocked);
  if (rng.next() < 0.7 || unlocked.length < 2) {
    // Move one unlocked item to a better/alternate feasible slot
    board.unplace(target.itemId);
    const move = findBestCandidate(board, target.task, rng);
    if (move && (move.day !== target.day || move.startPeriod !== target.startPeriod || move.roomId !== target.roomId)) {
      board.place({
        task: target.task,
        itemId: target.itemId,
        day: move.day,
        startPeriod: move.startPeriod,
        roomId: move.roomId,
        teacherIds: move.teacherIds,
      });
      return true;
    }
    board.place(target);
    return false;
  }

  // Swap two unlocked items of equal duration
  const sameDur = unlocked.filter((p) => p.itemId !== target.itemId && p.task.duration === target.task.duration);
  if (sameDur.length === 0) return false;
  const partner = rng.pick(sameDur);

  board.unplace(target.itemId);
  board.unplace(partner.itemId);

  const roomForTarget = board.roomById.get(partner.roomId);
  const roomForPartner = board.roomById.get(target.roomId);
  if (!roomForTarget || !roomForPartner) {
    board.place(target);
    board.place(partner);
    return false;
  }

  const ok1 =
    board.isIntrinsicallyFeasible(target.task, partner.day, partner.startPeriod, roomForTarget, target.teacherIds) &&
    board.findBlockingItemIds(target.task, partner.day, partner.startPeriod, roomForTarget, target.teacherIds).canPlace;
  if (!ok1) {
    board.place(target);
    board.place(partner);
    return false;
  }
  const placed1: SolverPlacement = {
    task: target.task,
    itemId: target.itemId,
    day: partner.day,
    startPeriod: partner.startPeriod,
    roomId: partner.roomId,
    teacherIds: target.teacherIds,
  };
  board.place(placed1);

  const ok2 =
    board.isIntrinsicallyFeasible(partner.task, target.day, target.startPeriod, roomForPartner, partner.teacherIds) &&
    board.findBlockingItemIds(partner.task, target.day, target.startPeriod, roomForPartner, partner.teacherIds).canPlace;
  if (!ok2) {
    board.unplace(target.itemId);
    board.place(target);
    board.place(partner);
    return false;
  }

  board.place({
    task: partner.task,
    itemId: partner.itemId,
    day: target.day,
    startPeriod: target.startPeriod,
    roomId: target.roomId,
    teacherIds: partner.teacherIds,
  });
  return true;
}

/**
 * Memetic CSP + GA optimizer:
 * 1) Builds feasible population via `solveCsp` with seeded restarts.
 * 2) Applies Hard-feasible move/swap mutations + exact `evaluateSchedule` selection
 *    to minimize Soft Penalty while keeping `Hard Violation = 0`.
 */
export function solveCspGa(ctx: ScheduleEvaluationContext, options: SolverOptions = {}): SolverOutput {
  const versionId = options.versionId ?? 'v1';
  const seed = options.seed ?? 1;
  const maxIterations = Math.max(4, options.maxIterations ?? 24);
  const timeLimitMs = options.timeLimitMs ?? 25_000;
  const deadline = Date.now() + timeLimitMs;
  const rng = createSeededRng(seed);
  const lockedIds = options.lockedItemIds ?? new Set<string>();

  // Step 1: Feasible initial seed population (1-2 restarts within time budget)
  const popSeeds = ctx.offerings.length > 200 ? 1 : 2;
  const candidates: EvaluatedIndividual[] = [];
  for (let i = 0; i < popSeeds; i++) {
    if (i > 0 && Date.now() > deadline - 2000) break;
    const out = solveCsp(ctx, {
      seed: seed + i * 1013,
      maxIterations: 2,
      timeLimitMs: Math.max(2000, Math.floor(timeLimitMs * 0.45)),
      versionId,
      lockedItemIds: lockedIds,
    });
    candidates.push(evaluateBoard(ctx, out));
  }

  candidates.sort((a, b) => a.hardCount - b.hardCount || a.totalPenalty - b.totalPenalty);
  let best = candidates[0]!;

  // Step 2: Memetic improvement loop strictly preserving Hard Violation count
  const cloneBoard = (src: SolverOutput): SolverBoard => {
    const b = new SolverBoard(ctx);
    for (const pl of src.board.placements.values()) b.place(pl);
    return b;
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    if (Date.now() > deadline) break;
    const workingBoard = cloneBoard(best.output);
    const lockedSet = new Set<string>(
      best.output.items.filter((i: ScheduleItem) => i.isLocked || lockedIds.has(i.id)).map((i) => i.id),
    );
    const movesPerGen = Math.min(8, Math.max(2, Math.floor(workingBoard.placements.size / 12)));
    let changed = false;
    for (let m = 0; m < movesPerGen; m++) {
      if (tryFeasiblePerturbation(workingBoard, lockedSet, rng)) changed = true;
    }
    if (!changed) continue;

    const { items, itemTeachers } = workingBoard.toScheduleRows(versionId, lockedSet, best.output.unplacedTasks);
    const mutated: SolverOutput = {
      items,
      itemTeachers,
      unplacedTasks: best.output.unplacedTasks,
      board: workingBoard,
    };
    const evalMut = evaluateBoard(ctx, mutated);
    if (
      evalMut.hardCount < best.hardCount ||
      (evalMut.hardCount === best.hardCount && evalMut.totalPenalty < best.totalPenalty)
    ) {
      best = evalMut;
    }
  }

  return best.output;
}
