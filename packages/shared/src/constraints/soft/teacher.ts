/** S05 TEACHER_LUNCH · S06 TEACHER_LOAD · S08 TEACHER_GAPS */
import { dayNameTh } from '../../explain/messages.th';
import { periodsOf, type TimelineEntry } from '../context';
import { consecutiveRuns, numListParam, numParam } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

const DEFAULT_LUNCH_WINDOW = [4, 5];

const idsOf = (entries: readonly TimelineEntry[]) => [...new Set(entries.map((e) => e.placed.item.id))].sort();

/** S05: on a teaching day the teacher has at least one free period in the lunch window. */
export const evaluateS05: ConstraintEvaluator = ({ index, params }) => {
  const window = numListParam(params, ['lunchWindow'], DEFAULT_LUNCH_WINDOW);
  const out: ViolationDraft[] = [];
  for (const [staffId, days] of index.teacherTimelines()) {
    for (const [day, entries] of days) {
      const open = window.filter((p) => index.isSlotOpen(day, p));
      if (open.length === 0) continue;
      const taught = new Set(periodsOf(entries));
      if (!open.every((p) => taught.has(p))) continue;
      out.push({
        messageKey: 'S05.violation',
        params: { teacher: index.teacherLabel(staffId), day: dayNameTh(day), window: open.join(', ') },
        itemIds: idsOf(entries.filter((e) => open.includes(e.period))),
        resourceType: 'teacher',
        resourceId: staffId,
        day,
        period: open[0],
      });
    }
  }
  return out;
};

/** S06: soft caps — consecutive periods > `maxConsecutive` (4) and daily periods > `maxDaily` (6). */
export const evaluateS06: ConstraintEvaluator = ({ index, params }) => {
  const maxConsecutive = numParam(params, ['maxConsecutive'], 4);
  const maxDaily = numParam(params, ['maxDaily', 'maxDailyPeriods'], 6);
  const out: ViolationDraft[] = [];
  for (const [staffId, days] of index.teacherTimelines()) {
    for (const [day, entries] of days) {
      const periods = periodsOf(entries);
      const runs = consecutiveRuns(periods);
      const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
      const runExcess = runs.reduce((n, r) => n + Math.max(0, r.length - maxConsecutive), 0);
      const dailyExcess = Math.max(0, periods.length - maxDaily);
      if (runExcess + dailyExcess === 0) continue;
      out.push({
        messageKey: 'S06.violation',
        params: { teacher: index.teacherLabel(staffId), day: dayNameTh(day), count: periods.length, longest, maxConsecutive, maxDaily },
        itemIds: idsOf(entries),
        severity: runExcess + dailyExcess,
        resourceType: 'teacher',
        resourceId: staffId,
        day,
      });
    }
  }
  return out;
};

/** S08: idle open periods between a teacher's first and last class (1 lunch-window period is free). */
export const evaluateS08: ConstraintEvaluator = ({ index, params }) => {
  const window = numListParam(params, ['lunchWindow'], DEFAULT_LUNCH_WINDOW);
  const out: ViolationDraft[] = [];
  for (const [staffId, days] of index.teacherTimelines()) {
    for (const [day, entries] of days) {
      const periods = periodsOf(entries);
      if (periods.length < 2) continue;
      const taught = new Set(periods);
      const gaps: number[] = [];
      for (let p = periods[0] + 1; p < periods[periods.length - 1]; p++) {
        if (!taught.has(p) && index.isSlotOpen(day, p)) gaps.push(p);
      }
      const allowance = gaps.some((p) => window.includes(p)) ? 1 : 0;
      const penalty = gaps.length - allowance;
      if (penalty <= 0) continue;
      out.push({
        messageKey: 'S08.violation',
        params: { teacher: index.teacherLabel(staffId), day: dayNameTh(day), gaps: penalty, periods: gaps.join(', ') },
        itemIds: idsOf(entries),
        severity: penalty,
        resourceType: 'teacher',
        resourceId: staffId,
        day,
        period: gaps[0],
      });
    }
  }
  return out;
};
