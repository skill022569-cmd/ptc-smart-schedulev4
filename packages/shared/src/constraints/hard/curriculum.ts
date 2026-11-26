/** H17 ELECTIVE_CLASH · H18 REGISTERED_ONLY · H20 HOURS_COMPLETE */
import type { CourseOffering } from '../../types';
import type { EvaluationIndex, PlacedItem } from '../context';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

const overlaps = (a: PlacedItem, b: PlacedItem) => a.day === b.day && a.start <= b.end && b.start <= a.end;

/**
 * H17: an elective section a student is enrolled in (`elective_enrollments.offeringId`)
 * must not overlap that student's compulsory items (whole-group items of the student's
 * group, or items of the student's own subgroup). Reported once per item pair.
 */
export const evaluateH17: ConstraintEvaluator = ({ ctx, index }) => {
  const byGroup = new Map<string, PlacedItem[]>();
  const bySubgroup = new Map<string, PlacedItem[]>();
  for (const p of index.placed) {
    if (p.offering?.offeringType === 'elective_section') continue;
    if (p.item.subgroupId) {
      const list = bySubgroup.get(p.item.subgroupId) ?? [];
      list.push(p);
      bySubgroup.set(p.item.subgroupId, list);
    } else {
      for (const g of p.groupIds) {
        const list = byGroup.get(g) ?? [];
        list.push(p);
        byGroup.set(g, list);
      }
    }
  }
  const pairs = new Map<string, { elective: PlacedItem; compulsory: PlacedItem; students: number }>();
  for (const e of ctx.electiveEnrollments) {
    if (!e.offeringId || (e.termId && e.termId !== ctx.term.id)) continue;
    const student = index.studentById.get(e.studentId);
    if (!student) continue;
    const electives = index.placedByOffering.get(e.offeringId) ?? [];
    if (electives.length === 0) continue;
    const compulsory = [...(byGroup.get(student.groupId) ?? []), ...(student.subgroupId ? (bySubgroup.get(student.subgroupId) ?? []) : [])];
    for (const el of electives) {
      for (const c of compulsory) {
        if (c.item.offeringId === e.offeringId || !overlaps(el, c)) continue;
        const key = `${el.item.id}|${c.item.id}`;
        const pair = pairs.get(key) ?? { elective: el, compulsory: c, students: 0 };
        pair.students += 1;
        pairs.set(key, pair);
      }
    }
  }
  const out: ViolationDraft[] = [];
  for (const { elective, compulsory, students } of pairs.values()) {
    out.push({
      messageKey: 'H17.violation',
      params: {
        elective: index.subjectLabel(elective.item.offeringId),
        compulsory: index.subjectLabel(compulsory.item.offeringId),
        students,
        slot: index.placedSlotText(elective),
      },
      itemIds: [elective.item.id, compulsory.item.id],
      offeringId: elective.item.offeringId,
      resourceType: 'student',
      resourceId: elective.item.offeringId,
      day: elective.day,
      period: Math.max(elective.start, compulsory.start),
    });
  }
  return out;
};

/**
 * H18: every item (placed or in the tray) belongs to a `course_offerings` row of the
 * current term that has ≥1 `offering_groups`; a `subgroupId` must belong to one of them.
 */
export const evaluateH18: ConstraintEvaluator = ({ ctx, index }) => {
  const out: ViolationDraft[] = [];
  for (const item of ctx.items) {
    const offering = index.offeringById.get(item.offeringId);
    const base = { itemIds: [item.id], offeringId: item.offeringId, resourceType: 'item' as const, resourceId: item.id };
    if (!offering) {
      out.push({ ...base, messageKey: 'H18.unknown_offering', params: { offeringId: item.offeringId } });
      continue;
    }
    const subject = index.subjectLabel(item.offeringId);
    if (offering.termId !== ctx.term.id) {
      out.push({ ...base, messageKey: 'H18.wrong_term', params: { subject } });
      continue;
    }
    const groups = index.groupIdsByOffering.get(offering.id) ?? [];
    if (groups.length === 0) {
      out.push({ ...base, messageKey: 'H18.no_group', params: { subject } });
      continue;
    }
    if (item.subgroupId) {
      const sg = index.subgroupById.get(item.subgroupId);
      if (!sg || !groups.includes(sg.groupId)) {
        out.push({ ...base, messageKey: 'H18.subgroup_mismatch', params: { subject, subgroup: sg ? index.subgroupLabel(sg.id) : item.subgroupId } });
      }
    }
  }
  return out;
};

export interface OfferingHoursTrack {
  /** null = whole group (no subgroup-specific items). */
  subgroupId: string | null;
  periods: number;
}

export interface OfferingHours {
  offering: CourseOffering;
  required: number;
  /** Bottleneck track total — split A/B periods are NOT added together. */
  scheduled: number;
  tracks: OfferingHoursTrack[];
  complete: boolean;
}

/**
 * Scheduled periods per offering. Students of each subgroup ("track") get the
 * whole-group items plus their own subgroup items; every track must reach
 * `periodsPerWeek`. Split offerings always expect a track per subgroup of their groups,
 * so a missing B half is detected while A+B are never double-counted.
 * Only items whose periods are all open slots count.
 */
export function computeOfferingHours(index: EvaluationIndex): OfferingHours[] {
  const out: OfferingHours[] = [];
  for (const offering of index.termOfferings) {
    const items = (index.placedByOffering.get(offering.id) ?? []).filter((p) => p.periods.every((per) => index.isSlotOpen(p.day, per)));
    const whole = items.filter((p) => !p.item.subgroupId).reduce((n, p) => n + p.periods.length, 0);
    const subIds = new Set(items.filter((p) => p.item.subgroupId).map((p) => p.item.subgroupId as string));
    if (offering.offeringType === 'split') {
      for (const g of index.groupIdsByOffering.get(offering.id) ?? []) {
        for (const sg of index.subgroupsByGroup.get(g) ?? []) subIds.add(sg.id);
      }
    }
    const tracks: OfferingHoursTrack[] =
      subIds.size === 0
        ? [{ subgroupId: null, periods: whole }]
        : [...subIds].sort().map((id) => ({
            subgroupId: id,
            periods: whole + items.filter((p) => p.item.subgroupId === id).reduce((n, p) => n + p.periods.length, 0),
          }));
    const required = offering.periodsPerWeek;
    out.push({
      offering,
      required,
      scheduled: Math.min(...tracks.map((t) => t.periods)),
      tracks,
      complete: tracks.every((t) => t.periods === required),
    });
  }
  return out;
}

/**
 * H20: no item left in the `unplaced_tray` (or without day/period), every placed item
 * sits on open slots, and every offering track totals exactly `periodsPerWeek`.
 */
export const evaluateH20: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  for (const item of index.unplacedItems) {
    out.push({
      messageKey: 'H20.unplaced',
      params: { subject: index.subjectLabel(item.offeringId), duration: item.duration },
      itemIds: [item.id],
      severity: Math.max(1, item.duration),
      offeringId: item.offeringId,
      resourceType: 'item',
      resourceId: item.id,
    });
  }
  for (const p of index.placed) {
    const closed = p.periods.filter((per) => !index.isSlotOpen(p.day, per));
    if (closed.length === 0) continue;
    out.push({
      messageKey: 'H20.invalid_slot',
      params: { subject: index.subjectLabel(p.item.offeringId), slot: index.placedSlotText(p) },
      itemIds: [p.item.id],
      severity: closed.length,
      offeringId: p.item.offeringId,
      resourceType: 'item',
      resourceId: p.item.id,
      day: p.day,
      period: p.start,
    });
  }
  for (const h of computeOfferingHours(index)) {
    for (const track of h.tracks) {
      if (track.periods === h.required) continue;
      const itemIds = (index.placedByOffering.get(h.offering.id) ?? [])
        .filter((p) => !p.item.subgroupId || p.item.subgroupId === track.subgroupId)
        .map((p) => p.item.id)
        .sort();
      out.push({
        messageKey: track.periods < h.required ? 'H20.incomplete' : 'H20.excess',
        params: {
          subject: index.subjectLabel(h.offering.id),
          track: track.subgroupId ? index.subgroupLabel(track.subgroupId) : 'ทั้งกลุ่ม',
          required: h.required,
          scheduled: track.periods,
        },
        itemIds,
        severity: Math.abs(h.required - track.periods),
        offeringId: h.offering.id,
        resourceType: 'offering',
        resourceId: h.offering.id,
      });
    }
  }
  return out;
};
