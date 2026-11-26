/** H11 TEAM_TEACHING · H13 TEACHER_DAILY_MAX · H14 TEACHER_CONSECUTIVE · H15 DAY_OFF · H16 EVENING_AFTER_DAY · H19 ELIGIBLE_TEACHER */
import { dayNameTh } from '../../explain/messages.th';
import { periodsOf } from '../context';
import { consecutiveRuns, numParam, optNumParam } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

/**
 * H11: every `offering_teachers` row without `subgroupCode` (plus the rows of the
 * item's own subgroup code) must be assigned to the item — team teachers teach together.
 */
export const evaluateH11: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const rows = index.offeringTeachersByOffering.get(p.item.offeringId) ?? [];
    if (rows.length === 0) continue;
    const subCode = p.item.subgroupId ? index.subgroupById.get(p.item.subgroupId)?.code : undefined;
    const required = [
      ...new Set(rows.filter((r) => r.subgroupCode == null || (subCode !== undefined && r.subgroupCode === subCode)).map((r) => r.staffId)),
    ];
    const missing = required.filter((id) => !p.teacherIds.includes(id));
    if (missing.length === 0) continue;
    out.push({
      messageKey: 'H11.violation',
      params: {
        subject: index.subjectLabel(p.item.offeringId),
        slot: index.placedSlotText(p),
        missing: missing.map((id) => index.teacherLabel(id)).join(', '),
        required: required.length,
        assigned: p.teacherIds.length,
      },
      itemIds: [p.item.id],
      severity: missing.length,
      offeringId: p.item.offeringId,
      resourceType: 'item',
      resourceId: p.item.id,
      day: p.day,
      period: p.start,
    });
  }
  return out;
};

/** H13: taught periods per teacher per day ≤ `max ?? staff.maxDailyPeriods ?? 6`. */
export const evaluateH13: ConstraintEvaluator = ({ index, params }) => {
  const fromParams = optNumParam(params, ['max', 'maxDailyPeriods', 'maxDaily']);
  const out: ViolationDraft[] = [];
  for (const [staffId, days] of index.teacherTimelines()) {
    const max = fromParams ?? index.staffById.get(staffId)?.maxDailyPeriods ?? 6;
    for (const [day, entries] of days) {
      const count = periodsOf(entries).length;
      if (count <= max) continue;
      out.push({
        messageKey: 'H13.violation',
        params: { teacher: index.teacherLabel(staffId), day: dayNameTh(day), count, max },
        itemIds: [...new Set(entries.map((e) => e.placed.item.id))].sort(),
        severity: count - max,
        resourceType: 'teacher',
        resourceId: staffId,
        day,
      });
    }
  }
  return out;
};

/** H14: consecutive taught periods ≤ `max ?? staff.maxConsecutive ?? 3`. */
export const evaluateH14: ConstraintEvaluator = ({ index, params }) => {
  const fromParams = optNumParam(params, ['max', 'maxConsecutive']);
  const out: ViolationDraft[] = [];
  for (const [staffId, days] of index.teacherTimelines()) {
    const max = fromParams ?? index.staffById.get(staffId)?.maxConsecutive ?? 3;
    for (const [day, entries] of days) {
      for (const run of consecutiveRuns(periodsOf(entries))) {
        if (run.length <= max) continue;
        const first = run[0];
        const last = run[run.length - 1];
        out.push({
          messageKey: 'H14.violation',
          params: { teacher: index.teacherLabel(staffId), slot: index.slotText(day, first, run.length), count: run.length, max },
          itemIds: [...new Set(entries.filter((e) => e.period >= first && e.period <= last).map((e) => e.placed.item.id))].sort(),
          severity: run.length - max,
          resourceType: 'teacher',
          resourceId: staffId,
          day,
          period: first,
        });
      }
    }
  }
  return out;
};

/** H15: no teaching on `staff.dayOff`. */
export const evaluateH15: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    for (const staffId of p.teacherIds) {
      const dayOff = index.staffById.get(staffId)?.dayOff;
      if (dayOff == null || dayOff !== p.day) continue;
      out.push({
        messageKey: 'H15.violation',
        params: { teacher: index.teacherLabel(staffId), day: dayNameTh(p.day), subject: index.subjectLabel(p.item.offeringId), slot: index.placedSlotText(p) },
        itemIds: [p.item.id],
        severity: p.periods.length,
        offeringId: p.item.offeringId,
        resourceType: 'teacher',
        resourceId: staffId,
        day: p.day,
        period: p.start,
      });
    }
  }
  return out;
};

/** H16: days on which a teacher teaches both day and evening shifts ≤ `maxDays` (default 2). */
export const evaluateH16: ConstraintEvaluator = ({ index, params }) => {
  const maxDays = numParam(params, ['maxDays', 'max_days', 'max'], 2);
  const eveningStart = optNumParam(params, ['eveningStartPeriod']);
  const out: ViolationDraft[] = [];
  for (const [staffId, days] of index.teacherTimelines()) {
    const both: number[] = [];
    const itemIds = new Set<string>();
    for (const [day, entries] of days) {
      const shifts = new Set(entries.map((e) => index.shiftOf(e.period, eveningStart)));
      if (shifts.has('day') && shifts.has('evening')) {
        both.push(day);
        for (const e of entries) itemIds.add(e.placed.item.id);
      }
    }
    if (both.length <= maxDays) continue;
    both.sort((a, b) => a - b);
    out.push({
      messageKey: 'H16.violation',
      params: { teacher: index.teacherLabel(staffId), count: both.length, max: maxDays, days: both.map(dayNameTh).join(', ') },
      itemIds: [...itemIds].sort(),
      severity: both.length - maxDays,
      resourceType: 'teacher',
      resourceId: staffId,
    });
  }
  return out;
};

/**
 * H19: each assigned teacher is eligible for the subject via `teacher_subject_eligibility`
 * (row with `groupId` null, or rows covering every attending group) or is listed in the
 * offering's `offering_teachers`. Non-activity items need at least one teacher.
 */
export const evaluateH19: ConstraintEvaluator = ({ ctx, index }) => {
  const eligibleGroups = new Map<string, Set<string | null>>();
  for (const e of ctx.eligibilities) {
    const key = `${e.staffId}|${e.subjectId}`;
    const set = eligibleGroups.get(key) ?? new Set<string | null>();
    set.add(e.groupId);
    eligibleGroups.set(key, set);
  }
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const subjectId = p.offering?.subjectId;
    const base = { itemIds: [p.item.id], offeringId: p.item.offeringId, day: p.day, period: p.start };
    if (p.teacherIds.length === 0) {
      if (p.offering?.offeringType !== 'activity') {
        out.push({
          ...base,
          messageKey: 'H19.no_teacher',
          params: { subject: index.subjectLabel(p.item.offeringId), slot: index.placedSlotText(p) },
          resourceType: 'item',
          resourceId: p.item.id,
        });
      }
      continue;
    }
    const listed = new Set((index.offeringTeachersByOffering.get(p.item.offeringId) ?? []).map((r) => r.staffId));
    for (const staffId of p.teacherIds) {
      if (listed.has(staffId)) continue;
      const groups = subjectId ? eligibleGroups.get(`${staffId}|${subjectId}`) : undefined;
      const ok = !!groups && (groups.has(null) || (p.audienceGroupIds.length > 0 && p.audienceGroupIds.every((g) => groups.has(g))));
      if (ok) continue;
      out.push({
        ...base,
        messageKey: 'H19.violation',
        params: { teacher: index.teacherLabel(staffId), subject: index.subjectLabel(p.item.offeringId), slot: index.placedSlotText(p) },
        resourceType: 'teacher',
        resourceId: staffId,
      });
    }
  }
  return out;
};
