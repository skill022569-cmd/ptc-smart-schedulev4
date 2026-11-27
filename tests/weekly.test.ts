import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  createEvaluationContext,
  datedPlacementProblem,
  dayOfWeekOf,
  mondayOf,
  owedOccurrences,
  termWeekOf,
  weekOccurrences,
  type ScenarioDataset,
  type ScheduleException,
} from '../packages/shared/src';
import { runAgenticPipeline } from '../apps/server/src/engine';

const q01 = JSON.parse(readFileSync(path.resolve('scenarios', 'Q01.json'), 'utf8')) as ScenarioDataset;
const base = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
const solved = runAgenticPipeline({ ctx: base, algorithm: 'csp_ga', seed: 2026, maxIterations: 8, timeLimitSec: 20, versionId: 'ver:wk' });
const ctx = { ...base, items: solved.items, itemTeachers: solved.itemTeachers };

const MON = '2026-11-30';
const SAT = '2026-12-05';
const placed = ctx.items.filter((i) => i.status === 'scheduled');
const item = placed.find((i) => i.duration === 1) ?? placed[0]!;
const origDate = addDays(MON, item.dayOfWeek! - 1);
const ex = (patch: Partial<ScheduleException>): ScheduleException => ({
  id: 'ex1',
  versionId: 'ver:wk',
  issueId: null,
  itemId: item.id,
  exceptionDate: origDate,
  action: 'cancel',
  substituteStaffId: null,
  newRoomId: null,
  makeupDate: null,
  makeupPeriod: null,
  ...patch,
});

describe('dated weekly timetable (master + exceptions)', () => {
  it('date helpers', () => {
    expect(dayOfWeekOf(MON)).toBe(1);
    expect(dayOfWeekOf(SAT)).toBe(6);
    expect(mondayOf('2026-12-06')).toBe(MON);
    expect(termWeekOf('2026-11-02', MON)).toBe(5);
  });

  it('without exceptions every placed class occurs once on its weekday', () => {
    const occ = weekOccurrences(ctx.items, ctx.itemTeachers, [], MON);
    expect(occ).toHaveLength(placed.length);
    expect(occ.every((o) => o.kind === 'regular' && o.date && dayOfWeekOf(o.date) === o.item.dayOfWeek)).toBe(true);
  });

  it('a cancelled class is owed until it gets a makeup slot', () => {
    const cancel = ex({});
    const occ = weekOccurrences(ctx.items, ctx.itemTeachers, [cancel], MON).find((o) => o.item.id === item.id)!;
    expect(occ.kind).toBe('away');
    expect(owedOccurrences(ctx.items, ctx.itemTeachers, [cancel]).map((o) => o.id)).toEqual([occ.id]);
    expect(owedOccurrences(ctx.items, ctx.itemTeachers, [ex({ makeupDate: SAT, makeupPeriod: 1 })])).toEqual([]);
  });

  it('can be made up on Saturday when that slot is free, and shows there', () => {
    const owed = owedOccurrences(ctx.items, ctx.itemTeachers, [ex({})])[0]!;
    expect(datedPlacementProblem(ctx, [ex({})], owed, SAT, 1)).toBeUndefined();
    const occ = weekOccurrences(ctx.items, ctx.itemTeachers, [ex({ makeupDate: SAT, makeupPeriod: 1 })], MON).find((o) => o.item.id === item.id)!;
    expect([occ.kind, occ.date, occ.period]).toEqual(['moved', SAT, 1]);
  });

  it('refuses a makeup slot where the group already has a class', () => {
    const owed = owedOccurrences(ctx.items, ctx.itemTeachers, [ex({})])[0]!;
    const groupOf = new Set(ctx.offeringGroups.filter((g) => g.offeringId === item.offeringId).map((g) => g.groupId));
    const busy = placed.find(
      (i) => i.id !== item.id && ctx.offeringGroups.some((g) => g.offeringId === i.offeringId && groupOf.has(g.groupId)),
    )!;
    const reason = datedPlacementProblem(ctx, [ex({})], owed, addDays(MON, busy.dayOfWeek! - 1), busy.startPeriod!);
    expect(reason).toMatch(/[ก-๙]/);
  });

  it('a makeup in a later week appears in that week as a makeup class', () => {
    const later = ex({ makeupDate: '2026-12-12', makeupPeriod: 2 });
    const next = weekOccurrences(ctx.items, ctx.itemTeachers, [later], '2026-12-07');
    const mk = next.filter((o) => o.kind === 'makeup');
    expect(mk.map((o) => [o.item.id, o.date, o.period])).toEqual([[item.id, '2026-12-12', 2]]);
    expect(next).toHaveLength(placed.length + 1);
  });
});
