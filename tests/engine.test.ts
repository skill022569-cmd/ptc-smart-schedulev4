import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationContext,
  type ChallengeRule,
  type ScenarioDataset,
} from '../packages/shared/src';
import {
  createSeededRng,
  diffScheduleVersions,
  evaluateChallengeImpact,
  proposeEmergencyFix,
  proposeFixOptions,
  runAgenticPipeline,
  runRepair,
} from '../apps/server/src/engine';

function loadScenario(code: 'Q01' | 'Q21'): ScenarioDataset {
  const filePath = path.resolve(process.cwd(), 'scenarios', `${code}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as ScenarioDataset;
}

describe('Phase 3 & 4 — Solver, Agentic Pipeline, Lucky Challenge & Repair', () => {
  it('Seeded PRNG produces identical sequences for the same seed', () => {
    const a = createSeededRng(202605);
    const b = createSeededRng(202605);
    const c = createSeededRng(999999);
    const seqA = Array.from({ length: 10 }, () => a.int(1, 1000));
    const seqB = Array.from({ length: 10 }, () => b.int(1, 1000));
    const seqC = Array.from({ length: 10 }, () => c.int(1, 1000));
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('Solves Q01 under competition and default profiles with Hard Violation = 0 and 100% completeness', () => {
    const q01 = loadScenario('Q01');
    const compCtx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
    const resComp = runAgenticPipeline({
      ctx: compCtx,
      algorithm: 'csp_ga',
      seed: 2026,
      maxIterations: 12,
      timeLimitSec: 30,
      versionId: 'ver:q01:competition',
    });
    expect(resComp.planner.feasible).toBe(true);
    expect(resComp.report.hardCount, 'competition hard violations').toBe(0);
    expect(resComp.qualitySummary.scheduleCompleteness.completenessPct).toBe(100);
    expect(resComp.qualitySummary.scheduleCompleteness.unplacedCount).toBe(0);
    expect(resComp.agentLog.map((l) => l.agent)).toEqual(['planner', 'solver', 'validator', 'repair']);
    expect(resComp.items[0]?.explanation?.length).toBeGreaterThan(0);

    // Default profile with Core 1.3 soft teacher consecutive cap (4) and H05 room type soft
    const defCtx = createEvaluationContext(
      { ...q01.tables, constraint_configs: [] },
      {
        profileName: 'default',
        overrides: { H14: { mode: 'soft', weight: 6 }, H05: { mode: 'soft', weight: 6 } },
      },
    );
    const resDef = runAgenticPipeline({
      ctx: defCtx,
      algorithm: 'csp_ga',
      seed: 2026,
      maxIterations: 8,
      timeLimitSec: 30,
      versionId: 'ver:q01:default',
    });
    expect(resDef.report.hardCount, 'default hard violations').toBe(0);
    expect(resDef.qualitySummary.scheduleCompleteness.completenessPct).toBe(100);
  });

  it('Produces identical Q01 schedules for the same seed and improves Soft Penalty with CSP+GA vs Greedy', () => {
    const q01 = loadScenario('Q01');
    const ctx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });

    const g1 = runAgenticPipeline({ ctx, algorithm: 'greedy', seed: 123, versionId: 'v:g1' });
    const g2 = runAgenticPipeline({ ctx, algorithm: 'greedy', seed: 123, versionId: 'v:g2' });
    const ga = runAgenticPipeline({ ctx, algorithm: 'csp_ga', seed: 123, maxIterations: 20, versionId: 'v:ga' });
    const sa = runAgenticPipeline({ ctx, algorithm: 'csp_sa', seed: 123, maxIterations: 20, versionId: 'v:sa' });

    const sig = (items: typeof g1.items) =>
      items.map((i) => `${i.offeringId}|${i.segmentIndex}|${i.subgroupId ?? ''}|${i.dayOfWeek}|${i.startPeriod}|${i.roomId}`).sort();
    expect(sig(g1.items)).toEqual(sig(g2.items));

    expect(ga.report.hardCount).toBe(0);
    expect(sa.report.hardCount).toBe(0);
    expect(ga.report.totalPenalty).toBeLessThanOrEqual(g1.report.totalPenalty);
    expect(ga.report.fitness).toBeGreaterThanOrEqual(g1.report.fitness);
  });

  it('Solves Q21 (60 groups / 120 teachers / 70 rooms / 564 offerings) with Hard = 0 and 100% completeness well within 180s', () => {
    const q21 = loadScenario('Q21');
    const ctx = createEvaluationContext({ ...q21.tables, constraint_configs: [] }, { profileName: 'competition' });
    const res = runAgenticPipeline({
      ctx,
      algorithm: 'csp_ga',
      seed: 20260121,
      maxIterations: 8,
      timeLimitSec: 45,
      versionId: 'ver:q21:test',
    });

    expect(res.report.hardCount).toBe(0);
    expect(res.qualitySummary.scheduleCompleteness.completenessPct).toBe(100);
    expect(res.qualitySummary.scheduleCompleteness.unplacedCount).toBe(0);
    expect(res.durationMs).toBeLessThan(30_000);
  }, 60_000);

  it('Evaluates Lucky Challenge across all 4 categories and repairs back to Hard Violation = 0 with Before/After diff', () => {
    const q01 = loadScenario('Q01');
    const baseCtx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
    const baseRun = runAgenticPipeline({ ctx: baseCtx, algorithm: 'csp_ga', seed: 77, maxIterations: 10 });
    expect(baseRun.report.hardCount).toBe(0);

    const solvedCtx = { ...baseCtx, items: baseRun.items, itemTeachers: baseRun.itemTeachers };
    const firstRoom = q01.tables.rooms[0]!;
    const firstStaff = q01.tables.staff[0]!;
    const firstItem = baseRun.items[0]!;

    const rules: ChallengeRule[] = [
      {
        id: 'cr1',
        termId: baseCtx.term.id,
        category: 'time',
        ruleType: 'block_slots',
        target: { all: true },
        params: { days: [3], periods: [7, 8] },
        mode: 'hard',
        description: 'ล็อกพุธบ่ายทำกิจกรรม',
        isActive: true,
        createdAt: null,
      },
      {
        id: 'cr2',
        termId: baseCtx.term.id,
        category: 'room',
        ruleType: 'room_closed',
        target: { room_ids: [firstRoom.id] },
        params: { days: [1], periods: [1, 2] },
        mode: 'hard',
        description: 'ห้องปิดปรับปรุงวันจันทร์คาบ 1-2',
        isActive: true,
        createdAt: null,
      },
      {
        id: 'cr3',
        termId: baseCtx.term.id,
        category: 'subject',
        ruleType: 'consecutive',
        target: { subject_ids: [q01.tables.subjects[0]!.id] },
        params: {},
        mode: 'hard',
        description: 'บังคับคาบต่อเนื่อง',
        isActive: true,
        createdAt: null,
      },
      {
        id: 'cr4',
        termId: baseCtx.term.id,
        category: 'teacher',
        ruleType: 'teacher_day_off',
        target: { staff_ids: [firstStaff.id] },
        params: { day: 5 },
        mode: 'hard',
        description: 'วันหยุดเตรียมสอนวันศุกร์',
        isActive: true,
        createdAt: null,
      },
    ];

    const impact = evaluateChallengeImpact(solvedCtx, rules);
    expect(impact.modifiedCtx.fixedBlocks.length).toBeGreaterThan(baseCtx.fixedBlocks.length);

    const repaired = runRepair(impact.modifiedCtx, { seed: 88, timeLimitMs: 15_000 });
    expect(repaired.hardCount).toBe(0);

    const afterCtx = { ...impact.modifiedCtx, items: repaired.output.items, itemTeachers: repaired.output.itemTeachers };
    const afterRes = runAgenticPipeline({ ctx: afterCtx, algorithm: 'csp_ga', seed: 88, maxIterations: 2 });
    expect(afterRes.report.hardCount).toBe(0);

    const diff = diffScheduleVersions(solvedCtx, afterCtx, impact.report, afterRes.report);
    expect(diff.afterHardCount).toBe(0);
    expect(typeof diff.movedCount).toBe('number');

    // 1-Click Fix options on an item
    const fixOptions = proposeFixOptions(solvedCtx, firstItem.id);
    expect(fixOptions.length).toBeGreaterThan(0);
    expect(fixOptions[0]!.hardCount).toBe(0);
  });

  it('Proposes emergency date-specific repair options for teacher_leave and room_outage', () => {
    const q01 = loadScenario('Q01');
    const baseCtx = createEvaluationContext(q01.tables, { profileName: 'competition' });
    const run = runAgenticPipeline({ ctx: baseCtx, algorithm: 'csp_ga', seed: 11, maxIterations: 8 });
    const solvedCtx = { ...baseCtx, items: run.items, itemTeachers: run.itemTeachers };

    // Pick a scheduled item on day 1..5 and map to ISO date (2026-11-23 is Monday = day 1)
    const targetItem = run.items.find((i) => i.dayOfWeek !== null)!;
    const teacherId = run.itemTeachers.find((it) => it.itemId === targetItem.id)!.staffId;
    const dateForDay = `2026-11-${22 + (targetItem.dayOfWeek ?? 1)}`;

    const leaveProp = proposeEmergencyFix(solvedCtx, {
      id: 'iss1',
      category: 'teacher_leave',
      affectedDate: dateForDay,
      affectedStaffId: teacherId,
      affectedRoomId: null,
    });
    expect(leaveProp.affectedItemCount).toBeGreaterThan(0);
    expect(leaveProp.options.length).toBeGreaterThan(0);

    const roomProp = proposeEmergencyFix(solvedCtx, {
      id: 'iss2',
      category: 'room_outage',
      affectedDate: dateForDay,
      affectedStaffId: null,
      affectedRoomId: targetItem.roomId,
    });
    expect(roomProp.affectedItemCount).toBeGreaterThan(0);
    expect(roomProp.options.some((o) => o.action === 'room_change' || o.action === 'makeup')).toBe(true);
  });
});
