/** Quality Summary (Screen 14): 4 dimensions computed from an EvaluationReport. */
import { CONSTRAINT_CATALOG, HARD_CONSTRAINT_CODES } from './catalog';
import { EvaluationIndex } from './context';
import { evaluateSchedule } from './engine';
import { computeOfferingHours, evaluateH01, evaluateH02, evaluateH03 } from './hard';
import { round } from './params';
import type {
  ConstraintEvaluator,
  EvaluationReport,
  HardCodeStatus,
  HardConstraintStatus,
  PerformanceInput,
  QualitySummary4D,
  ScheduleEvaluationContext,
} from './types';

/** Heap usage in MB when running on Node / a Worker; 0 in browsers. */
export function currentMemoryMb(): number {
  const proc = (globalThis as unknown as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  const used = proc?.memoryUsage?.().heapUsed;
  return typeof used === 'number' ? round(used / (1024 * 1024), 2) : 0;
}

/**
 * Build the 4-dimension Quality Summary. Clash counts (dimension 1) are always
 * measured — even when H01–H03 are switched off in the profile.
 */
export function buildQualitySummary4D(
  ctx: ScheduleEvaluationContext,
  report?: EvaluationReport,
  perf: PerformanceInput = {},
): QualitySummary4D {
  const r = report ?? evaluateSchedule(ctx, { includePassedExplanations: false });
  const index = new EvaluationIndex(ctx);
  const count = (code: 'H01' | 'H02' | 'H03', evaluator: ConstraintEvaluator) =>
    evaluator({ ctx, index, params: r.configs[code].params, mode: 'hard' }).length;

  // 1. Conflict detection
  const teacherClashes = count('H01', evaluateH01);
  const roomClashes = count('H02', evaluateH02);
  const groupClashes = count('H03', evaluateH03);
  const totalClashes = teacherClashes + roomClashes + groupClashes;

  // 2. Constraint validation (per Hard code)
  const codes: HardConstraintStatus[] = HARD_CONSTRAINT_CODES.map((code): HardConstraintStatus => {
    const mode = r.configs[code].mode;
    const violations =
      mode === 'hard'
        ? (r.hardCountsByCode[code] ?? 0)
        : mode === 'soft'
          ? (r.softPenalties.find((s) => s.code === code)?.violations.length ?? 0)
          : 0;
    const status: HardCodeStatus = mode === 'off' ? 'off' : mode === 'soft' ? 'soft' : violations > 0 ? 'fail' : 'pass';
    return {
      code,
      name: CONSTRAINT_CATALOG[code].key,
      nameTh: CONSTRAINT_CATALOG[code].nameTh,
      mode,
      violations,
      status,
      passed: status !== 'fail',
    };
  });
  const failedCodes = codes.filter((c) => c.status === 'fail').map((c) => c.code);

  // 3. Schedule completeness (split A/B tracks are not double-counted)
  const hours = computeOfferingHours(index);
  const requiredHours = hours.reduce((n, h) => n + h.required, 0);
  const scheduledHours = hours.reduce((n, h) => n + Math.min(h.scheduled, h.required), 0);
  const unplacedCount = index.unplacedItems.length;
  const completenessPct = requiredHours === 0 ? 100 : round((scheduledHours / requiredHours) * 100, 2);

  // 4. Performance + soft breakdown
  const softItems = r.softPenalties.map((s) => ({
    code: s.code,
    name: s.name,
    nameTh: CONSTRAINT_CATALOG[s.code].nameTh,
    weight: s.weight,
    rawPenalty: s.rawPenalty,
    weightedPenalty: s.weightedPenalty,
  }));

  const conflictDetection = { teacherClashes, roomClashes, groupClashes, totalClashes, passed: totalClashes === 0 };
  const constraintValidation = { codes, failedCodes, passed: failedCodes.length === 0 };
  const scheduleCompleteness = {
    requiredHours,
    scheduledHours,
    completenessPct,
    unplacedCount,
    unplacedOfferings: r.unplacedOfferings.length,
    passed: scheduledHours === requiredHours && unplacedCount === 0,
  };
  return {
    profileName: r.profileName,
    conflictDetection,
    constraintValidation,
    scheduleCompleteness,
    performance: {
      durationMs: perf.durationMs ?? 0,
      memoryMb: perf.memoryMb ?? currentMemoryMb(),
      softBreakdown: { items: softItems, totalPenalty: r.totalPenalty, fitness: r.fitness },
    },
    multiObjective: r.multiObjective,
    passed: conflictDetection.passed && constraintValidation.passed && scheduleCompleteness.passed,
  };
}
