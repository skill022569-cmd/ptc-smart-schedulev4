/** S01 STUDENT_GAPS · S09 THEORY_STREAK · S10 ROOM_CHANGES · S12 DAY_SPAN · S13 GROUP_DAILY_BALANCE */
import { dayNameTh } from '../../explain/messages.th';
import { periodsOf, type PlacedItem } from '../context';
import { consecutiveRuns, numParam, round } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';
import { itemIdsOf, studentDays, studentWeeks } from './shared';

/** S01: free open periods between a group's first and last class of a day (lunch excluded). */
export const evaluateS01: ConstraintEvaluator = ({ index, params }) => {
  const allowed = numParam(params, ['allowedGaps', 'maxGapPerDay'], 0);
  const out: ViolationDraft[] = [];
  for (const sd of studentDays(index)) {
    const periods = periodsOf(sd.entries);
    if (periods.length < 2) continue;
    const occupied = new Set(periods);
    const lunch = index.lunchPeriodOf(sd.groupId);
    const gaps: number[] = [];
    for (let per = periods[0] + 1; per < periods[periods.length - 1]; per++) {
      if (!occupied.has(per) && per !== lunch && index.isSlotOpen(sd.day, per)) gaps.push(per);
    }
    const penalty = gaps.length - allowed;
    if (penalty <= 0) continue;
    out.push({
      messageKey: 'S01.violation',
      params: { group: sd.label, day: dayNameTh(sd.day), gaps: gaps.length, periods: gaps.join(', ') },
      itemIds: itemIdsOf(sd.items),
      severity: penalty,
      resourceType: sd.unit.type,
      resourceId: sd.unit.id,
      day: sd.day,
      period: gaps[0],
    });
  }
  return out;
};

const isTheoryOnly = (p: PlacedItem) =>
  !!p.subject && (p.subject.practiceHours ?? 0) === 0 && p.subject.category !== 'activity';

/** S09: consecutive theory-only periods of a group exceeding `max` (default 2). */
export const evaluateS09: ConstraintEvaluator = ({ index, params }) => {
  const max = numParam(params, ['max', 'maxTheoryStreak'], 2);
  const out: ViolationDraft[] = [];
  for (const sd of studentDays(index)) {
    const theoryAt = new Map<number, boolean>();
    for (const e of sd.entries) theoryAt.set(e.period, (theoryAt.get(e.period) ?? true) && isTheoryOnly(e.placed));
    const theoryPeriods = [...theoryAt].filter(([, t]) => t).map(([p]) => p).sort((a, b) => a - b);
    for (const run of consecutiveRuns(theoryPeriods)) {
      if (run.length <= max) continue;
      const first = run[0];
      const last = run[run.length - 1];
      out.push({
        messageKey: 'S09.violation',
        params: { group: sd.label, slot: index.slotText(sd.day, first, run.length), count: run.length, max },
        itemIds: itemIdsOf(sd.entries.filter((e) => e.period >= first && e.period <= last).map((e) => e.placed)),
        severity: run.length - max,
        resourceType: sd.unit.type,
        resourceId: sd.unit.id,
        day: sd.day,
        period: first,
      });
    }
  }
  return out;
};

/** S10: number of room changes between successive classes of a group on one day. */
export const evaluateS10: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  for (const sd of studentDays(index)) {
    const withRoom = sd.items.filter((p) => p.item.roomId);
    let changes = 0;
    for (let i = 1; i < withRoom.length; i++) if (withRoom[i].item.roomId !== withRoom[i - 1].item.roomId) changes++;
    if (changes === 0) continue;
    out.push({
      messageKey: 'S10.violation',
      params: { group: sd.label, day: dayNameTh(sd.day), count: changes, rooms: withRoom.map((p) => index.roomLabel(p.item.roomId)).join(' → ') },
      itemIds: itemIdsOf(withRoom),
      severity: changes,
      resourceType: sd.unit.type,
      resourceId: sd.unit.id,
      day: sd.day,
    });
  }
  return out;
};

/**
 * S12: day span (first → last period) beyond both `maxSpan` (default 7) and what the
 * day actually needs (scheduled periods + the lunch period when it lies inside).
 */
export const evaluateS12: ConstraintEvaluator = ({ index, params }) => {
  const maxSpan = numParam(params, ['maxSpan', 'maxSpanPeriods', 'max'], 7);
  const out: ViolationDraft[] = [];
  for (const sd of studentDays(index)) {
    const periods = periodsOf(sd.entries);
    if (periods.length === 0) continue;
    const first = periods[0];
    const last = periods[periods.length - 1];
    const span = last - first + 1;
    const lunch = index.lunchPeriodOf(sd.groupId);
    const needed = periods.length + (lunch !== undefined && lunch > first && lunch < last && !periods.includes(lunch) ? 1 : 0);
    const excess = span - Math.max(maxSpan, needed);
    if (excess <= 0) continue;
    out.push({
      messageKey: 'S12.violation',
      params: { group: sd.label, day: dayNameTh(sd.day), span, max: maxSpan, scheduled: periods.length },
      itemIds: itemIdsOf(sd.items),
      severity: excess,
      resourceType: sd.unit.type,
      resourceId: sd.unit.id,
      day: sd.day,
      period: first,
    });
  }
  return out;
};

/**
 * S13: per group, daily periods on active days should stay within
 * [floor(avg) − tolerance, ceil(avg) + tolerance]; penalty = Σ excess + Σ deficit.
 */
export const evaluateS13: ConstraintEvaluator = ({ index, params }) => {
  const tolerance = numParam(params, ['tolerance'], 0);
  const out: ViolationDraft[] = [];
  for (const week of studentWeeks(index)) {
    const counts = [...week.periodsByDay].filter(([, ps]) => ps.length > 0);
    if (counts.length < 2) continue;
    const total = counts.reduce((n, [, ps]) => n + ps.length, 0);
    const avg = total / counts.length;
    const hi = Math.ceil(avg) + tolerance;
    const lo = Math.floor(avg) - tolerance;
    let penalty = 0;
    for (const [, ps] of counts) penalty += Math.max(0, ps.length - hi) + Math.max(0, lo - ps.length);
    if (penalty <= 0) continue;
    out.push({
      messageKey: 'S13.violation',
      params: {
        group: week.label,
        counts: counts.map(([d, ps]) => `${dayNameTh(d)} ${ps.length}`).join(', '),
        avg: round(avg, 2),
      },
      itemIds: week.itemIds,
      severity: penalty,
      resourceType: week.unit.type,
      resourceId: week.unit.id,
    });
  }
  return out;
};
