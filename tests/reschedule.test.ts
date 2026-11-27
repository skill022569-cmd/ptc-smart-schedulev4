import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEvaluationContext, evaluateSchedule, planCellActions, type ScenarioDataset, type ScheduleItem } from '../packages/shared/src';
import { runAgenticPipeline } from '../apps/server/src/engine';

const q01 = JSON.parse(readFileSync(path.resolve('scenarios', 'Q01.json'), 'utf8')) as ScenarioDataset;
const base = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
const solved = runAgenticPipeline({ ctx: base, algorithm: 'csp_ga', seed: 2026, maxIterations: 8, timeLimitSec: 20, versionId: 'ver:rs' });
const ctx = { ...base, items: solved.items, itemTeachers: solved.itemTeachers };

const CLASH = new Set(['H01', 'H02', 'H03']);
const clashCount = (items: ScheduleItem[]) =>
  evaluateSchedule({ ...ctx, items }).hardViolations.filter((v) => CLASH.has(v.code)).length;
const at = (items: ScheduleItem[], id: string, day: number, startPeriod: number) =>
  items.map((i) => (i.id === id ? { ...i, dayOfWeek: day, startPeriod } : i));

describe('planCellActions (single-cell move & swap)', () => {
  const placed = ctx.items.filter((i) => i.status === 'scheduled');

  it('starts from a clash-free timetable', () => {
    expect(clashCount(ctx.items)).toBe(0);
  });

  it('every move it allows stays clash-free, every one it blocks has a Thai reason', () => {
    for (const item of placed.slice(0, 6)) {
      const { moves } = planCellActions(ctx, item.id);
      expect(moves.length).toBeGreaterThan(0);
      for (const m of moves) {
        if (m.ok) expect(clashCount(at(ctx.items, item.id, m.day, m.period)), `${item.id} -> ${m.day}:${m.period}`).toBe(0);
        else expect(m.reason).toMatch(/[ก-๙]/);
      }
    }
  });

  it('every swap it allows stays clash-free on both sides', () => {
    let tried = 0;
    for (const item of placed.slice(0, 10)) {
      for (const s of planCellActions(ctx, item.id).swaps.filter((x) => x.ok)) {
        const other = ctx.items.find((i) => i.id === s.otherItemId)!;
        const swapped = at(at(ctx.items, item.id, s.day, s.period), other.id, item.dayOfWeek!, item.startPeriod!);
        expect(clashCount(swapped), `${item.id} <-> ${other.id}`).toBe(0);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(0);
  });

  it('a locked item offers no move or swap', () => {
    const item = { ...placed[0]!, isLocked: true };
    const plan = planCellActions({ ...ctx, items: ctx.items.map((i) => (i.id === item.id ? item : i)) }, item.id);
    expect(plan.moves.every((m) => !m.ok) && plan.swaps.every((s) => !s.ok)).toBe(true);
  });
});
