import type { ScheduleEvaluationContext, ScheduleItem } from '@ptc/shared';
import { createSeededRng } from '../rng';
import { SolverBoard } from '../feasibility';
import { type SolverOptions, type SolverOutput } from './greedy';
import { solveCsp } from './csp';
import { evaluateBoard, tryFeasiblePerturbation } from './genetic';

/**
 * Seeded Simulated Annealing optimizer (`csp_sa`):
 * Starts from a Hard-feasible CSP solution and applies probabilistic SA neighborhood
 * moves while strictly guarding Hard Violation count.
 */
export function solveCspSa(ctx: ScheduleEvaluationContext, options: SolverOptions = {}): SolverOutput {
  const versionId = options.versionId ?? 'v1';
  const seed = options.seed ?? 1;
  const maxIterations = Math.max(6, options.maxIterations ?? 24);
  const timeLimitMs = options.timeLimitMs ?? 25_000;
  const deadline = Date.now() + timeLimitMs;
  const rng = createSeededRng(seed);
  const lockedIds = options.lockedItemIds ?? new Set<string>();

  const initial = solveCsp(ctx, {
    seed,
    maxIterations: 3,
    timeLimitMs: Math.max(2000, Math.floor(timeLimitMs * 0.45)),
    versionId,
    lockedItemIds: lockedIds,
  });
  let current = evaluateBoard(ctx, initial);
  let best = current;

  const cloneBoard = (src: SolverOutput): SolverBoard => {
    const b = new SolverBoard(ctx);
    for (const pl of src.board.placements.values()) b.place(pl);
    return b;
  };

  let temp = 12.0;
  const cooling = 0.88;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (Date.now() > deadline) break;
    const workingBoard = cloneBoard(current.output);
    const lockedSet = new Set<string>(
      current.output.items.filter((i: ScheduleItem) => i.isLocked || lockedIds.has(i.id)).map((i) => i.id),
    );
    if (!tryFeasiblePerturbation(workingBoard, lockedSet, rng)) {
      temp *= cooling;
      continue;
    }

    const { items, itemTeachers } = workingBoard.toScheduleRows(
      versionId,
      lockedSet,
      current.output.unplacedTasks,
    );
    const nextEval = evaluateBoard(ctx, {
      items,
      itemTeachers,
      unplacedTasks: current.output.unplacedTasks,
      board: workingBoard,
    });

    if (nextEval.hardCount <= current.hardCount) {
      const delta = nextEval.totalPenalty - current.totalPenalty;
      if (nextEval.hardCount < current.hardCount || delta <= 0 || rng.next() < Math.exp(-delta / Math.max(0.2, temp))) {
        current = nextEval;
        if (
          nextEval.hardCount < best.hardCount ||
          (nextEval.hardCount === best.hardCount && nextEval.totalPenalty < best.totalPenalty)
        ) {
          best = nextEval;
        }
      }
    }
    temp *= cooling;
  }

  return best.output;
}
