import {
  type AgentLogEntry,
  type EvaluationReport,
  type QualitySummary4D,
  type ScheduleEvaluationContext,
  type ScheduleItem,
  type ScheduleItemTeacher,
  type SchedulingAlgorithm,
} from '@ptc/shared';
import { runPlanner, type PlannerResult } from './planner';
import { runValidator } from './validator';
import { runRepair } from './repair';
import { solveGreedy, type SolverOutput } from '../algorithms/greedy';
import { solveCsp } from '../algorithms/csp';
import { solveCspGa } from '../algorithms/genetic';
import { solveCspSa } from '../algorithms/annealing';

export interface PipelineInput {
  ctx: ScheduleEvaluationContext;
  algorithm?: SchedulingAlgorithm;
  seed?: number;
  maxIterations?: number;
  timeLimitSec?: number;
  versionId?: string;
}

export interface PipelineResult {
  algorithm: SchedulingAlgorithm;
  seed: number;
  versionId: string;
  durationMs: number;
  memoryMb: number;
  planner: PlannerResult;
  items: ScheduleItem[];
  itemTeachers: ScheduleItemTeacher[];
  report: EvaluationReport;
  qualitySummary: QualitySummary4D;
  agentLog: AgentLogEntry[];
}

function logEntry(
  agent: AgentLogEntry['agent'],
  level: AgentLogEntry['level'],
  message: string,
  data?: Record<string, unknown>,
): AgentLogEntry {
  return {
    at: new Date().toISOString(),
    agent,
    level,
    message,
    ...(data ? { data } : {}),
  };
}

/**
 * Full 4-Agent Scheduling Pipeline (`Planner -> Solver -> Validator -> Repair`).
 * Every generated item receives deterministic XAI explanations from the Validator.
 */
export function runAgenticPipeline(input: PipelineInput): PipelineResult {
  const startedAt = Date.now();
  const algorithm: SchedulingAlgorithm = input.algorithm ?? 'csp_ga';
  const seed = input.seed ?? 2026;
  const maxIterations = input.maxIterations ?? 24;
  const timeLimitMs = Math.max(2000, (input.timeLimitSec ?? 180) * 1000);
  const versionId = input.versionId ?? `ver:${seed}:${Date.now()}`;
  const agentLog: AgentLogEntry[] = [];

  // 1. Planner
  const planner = runPlanner(input.ctx);
  agentLog.push(
    logEntry(
      'planner',
      planner.feasible ? 'info' : 'warn',
      `Planner ตรวจข้อมูลแล้ว: ${planner.taskCount} ชิ้นวิชา (${planner.totalRequiredPeriods} คาบ) — ${planner.feasible ? 'พร้อมจัดตาราง' : 'พบข้อจำกัดที่ต้องระวัง'}`,
      { feasible: planner.feasible, taskCount: planner.taskCount },
    ),
  );

  // 2. Solver
  let solverOut: SolverOutput;
  const solverOpts = { seed, maxIterations, timeLimitMs, versionId };
  if (algorithm === 'greedy') {
    solverOut = solveGreedy(input.ctx, solverOpts);
  } else if (algorithm === 'csp_sa') {
    solverOut = solveCspSa(input.ctx, solverOpts);
  } else if (algorithm === 'csp_ga') {
    solverOut = solveCspGa(input.ctx, solverOpts);
  } else {
    solverOut = solveCsp(input.ctx, solverOpts);
  }

  agentLog.push(
    logEntry(
      'solver',
      solverOut.unplacedTasks.length === 0 ? 'info' : 'warn',
      `Solver (${algorithm}, seed=${seed}) จัดลงตาราง ${solverOut.items.filter((i) => i.status === 'scheduled').length} รายการ, ค้างถาด ${solverOut.unplacedTasks.length} รายการ`,
      { unplaced: solverOut.unplacedTasks.length },
    ),
  );

  // 3. Validator (independent check)
  let evalCtx: ScheduleEvaluationContext = {
    ...input.ctx,
    items: solverOut.items,
    itemTeachers: solverOut.itemTeachers,
  };
  let validated = runValidator(evalCtx, { durationMs: Date.now() - startedAt });
  agentLog.push(
    logEntry(
      'validator',
      validated.passed ? 'info' : 'warn',
      `Validator ตรวจ Hard Violation = ${validated.report.hardCount}, Completeness = ${validated.qualitySummary.scheduleCompleteness.completenessPct}%, Fitness = ${validated.report.fitness}`,
      { hardCount: validated.report.hardCount, fitness: validated.report.fitness },
    ),
  );

  // 4. Repair (only triggered when Validator finds Hard violations or unplaced items, and algorithm != 'greedy')
  if (!validated.passed && algorithm !== 'greedy') {
    const repaired = runRepair(evalCtx, { seed: seed + 17, timeLimitMs: Math.min(15_000, timeLimitMs), versionId });
    evalCtx = {
      ...input.ctx,
      items: repaired.output.items,
      itemTeachers: repaired.output.itemTeachers,
    };
    validated = runValidator(evalCtx, { durationMs: Date.now() - startedAt });
    agentLog.push(
      logEntry(
        'repair',
        validated.passed ? 'info' : 'warn',
        `Repair Agent แก้ไขตาราง (ย้าย ${repaired.movedCount} รายการ) -> Hard Violation = ${validated.report.hardCount}, Fitness = ${validated.report.fitness}`,
        { movedCount: repaired.movedCount, hardCount: validated.report.hardCount },
      ),
    );
  } else {
    agentLog.push(
      logEntry('repair', 'info', 'Repair Agent: ไม่จำเป็นต้องแก้ไขเพิ่ม (ตารางผ่านเกณฑ์หรือใช้โหมด Greedy baseline)'),
    );
  }

  // Attach deterministic XAI JSON explanations to every item
  const itemsWithXai: ScheduleItem[] = evalCtx.items.map((item) => ({
    ...item,
    explanation: validated.report.itemExplanations[item.id] ?? [],
  }));

  const durationMs = Math.max(1, Date.now() - startedAt);
  const memoryMb = validated.qualitySummary.performance.memoryMb;

  return {
    algorithm,
    seed,
    versionId,
    durationMs,
    memoryMb,
    planner,
    items: itemsWithXai,
    itemTeachers: evalCtx.itemTeachers,
    report: validated.report,
    qualitySummary: {
      ...validated.qualitySummary,
      performance: {
        ...validated.qualitySummary.performance,
        durationMs,
      },
    },
    agentLog,
  };
}
