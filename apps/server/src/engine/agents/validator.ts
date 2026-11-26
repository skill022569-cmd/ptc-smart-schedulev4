import {
  buildQualitySummary4D,
  evaluateSchedule,
  type EvaluationReport,
  type PerformanceInput,
  type QualitySummary4D,
  type ScheduleEvaluationContext,
} from '@ptc/shared';

export interface ValidatorResult {
  passed: boolean;
  report: EvaluationReport;
  qualitySummary: QualitySummary4D;
}

/**
 * Validator Agent (Check step of Plan-Act-Check):
 * Completely independent from Solver algorithms; evaluates the produced schedule via `@ptc/shared`.
 */
export function runValidator(
  ctx: ScheduleEvaluationContext,
  perf: PerformanceInput = {},
): ValidatorResult {
  const report = evaluateSchedule(ctx, { includePassedExplanations: true });
  const qualitySummary = buildQualitySummary4D(ctx, report, perf);
  return {
    passed: report.hardCount === 0 && report.unplacedOfferings.length === 0,
    report,
    qualitySummary,
  };
}
