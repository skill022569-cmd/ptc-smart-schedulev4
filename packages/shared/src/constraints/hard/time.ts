/** H06 LUNCH_BREAK · H07 AVAILABILITY · H08 FIXED_BLOCK · H09 CONSECUTIVE · H10 ALLOWED_DAYS · H21 GROUP_AVAILABILITY */
import { dayNameTh } from '../../explain/messages.th';
import { resolveFixedBlockTargets, type FixedBlockTargets } from '../../occupancy';
import type { FixedBlock } from '../../types';
import { slotKey, type EvaluationIndex, type PlacedItem } from '../context';
import { recordParam } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

const SHIFT_TH: Record<string, string> = { day: 'ภาคปกติ (กลางวัน)', evening: 'ภาคค่ำ', both: 'ทั้งกลางวันและค่ำ' };

const periodList = (periods: readonly number[]) => periods.join(', ');

/** H06: the group's lunch period (ปวช. 4 / ปวส. 5 by default) must stay free. */
export const evaluateH06: ConstraintEvaluator = ({ index, params }) => {
  const byLevel = recordParam(params, 'lunchPeriodByLevel');
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    for (const groupId of p.audienceGroupIds) {
      const lunch = index.lunchPeriodOf(groupId, byLevel);
      if (lunch === undefined || !p.periods.includes(lunch)) continue;
      out.push({
        messageKey: 'H06.violation',
        params: { group: index.groupLabel(groupId), subject: index.subjectLabel(p.item.offeringId), lunchPeriod: lunch, slot: index.placedSlotText(p) },
        itemIds: [p.item.id],
        offeringId: p.item.offeringId,
        resourceType: 'group',
        resourceId: groupId,
        day: p.day,
        period: lunch,
      });
    }
  }
  return out;
};

/** Periods of an item that are outside `time_slots` or closed on that weekday. */
function closedPeriods(index: EvaluationIndex, p: PlacedItem): number[] {
  return p.periods.filter((period) => !index.isSlotOpen(p.day, period));
}

/**
 * H07: slot exists & open (`time_slots.openDays`), teachers are not in
 * `unavailableSlots` and inside `availableSlots` (whitelist when non-empty),
 * the room is not in its `unavailableSlots`.
 */
export const evaluateH07: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const base = { offeringId: p.item.offeringId, day: p.day, period: p.start };
    const subject = index.subjectLabel(p.item.offeringId);
    const slot = index.placedSlotText(p);
    const closed = closedPeriods(index, p);
    if (closed.length > 0) {
      out.push({
        ...base,
        messageKey: 'H07.slot_invalid',
        params: { subject, slot, periods: periodList(closed) },
        itemIds: [p.item.id],
        severity: closed.length,
        resourceType: 'item',
        resourceId: p.item.id,
      });
    }
    for (const staffId of p.teacherIds) {
      const unavailable = index.staffUnavailable.get(staffId);
      const whitelist = index.staffAvailable.get(staffId);
      const bad = p.periods.filter((period) => {
        const k = slotKey(p.day, period);
        return (unavailable?.has(k) ?? false) || (whitelist !== undefined && !whitelist.has(k));
      });
      if (bad.length === 0) continue;
      out.push({
        ...base,
        messageKey: 'H07.teacher',
        params: { teacher: index.teacherLabel(staffId), subject, slot, periods: periodList(bad) },
        itemIds: [p.item.id],
        severity: bad.length,
        resourceType: 'teacher',
        resourceId: staffId,
      });
    }
    if (p.item.roomId) {
      const unavailable = index.roomUnavailable.get(p.item.roomId);
      const bad = p.periods.filter((period) => unavailable?.has(slotKey(p.day, period)) ?? false);
      if (bad.length > 0) {
        out.push({
          ...base,
          messageKey: 'H07.room',
          params: { room: index.roomLabel(p.item.roomId), subject, slot, periods: periodList(bad) },
          itemIds: [p.item.id],
          severity: bad.length,
          resourceType: 'room',
          resourceId: p.item.roomId,
        });
      }
    }
  }
  return out;
};

/**
 * H08: items must not overlap fixed blocks that apply to their groups (`all`,
 * `groupIds`, `levels`, `departmentIds`), teachers (`staffIds`) or room (`roomId`).
 * Elective sections may sit inside `elective_block`s and activity offerings inside
 * `activity` blocks — that is what those blocks are reserved for.
 */
export const evaluateH08: ConstraintEvaluator = ({ ctx, index }) => {
  const termBlocks = ctx.fixedBlocks.filter((b) => b.termId === ctx.term.id);
  const blocks = termBlocks.length > 0 ? termBlocks : ctx.fixedBlocks;
  const targets = new Map<string, FixedBlockTargets>();
  const targetsOf = (b: FixedBlock) => {
    let t = targets.get(b.id);
    if (!t) {
      t = resolveFixedBlockTargets(b, ctx.studentGroups, { staff: ctx.staff, rooms: ctx.rooms });
      targets.set(b.id, t);
    }
    return t;
  };
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    for (const block of blocks) {
      if (block.dayOfWeek !== p.day) continue;
      const bEnd = block.startPeriod + Math.max(1, block.duration) - 1;
      if (p.end < block.startPeriod || p.start > bEnd) continue;
      const type = p.offering?.offeringType;
      if (block.blockType === 'elective_block' && type === 'elective_section') continue;
      if (block.blockType === 'activity' && type === 'activity') continue;
      const t = targetsOf(block);
      const hits: string[] = [];
      for (const g of p.audienceGroupIds) if (t.groupIds.includes(g)) hits.push(`กลุ่ม ${index.groupLabel(g)}`);
      for (const s of p.teacherIds) if (t.staffIds.includes(s)) hits.push(`ครู ${index.teacherLabel(s)}`);
      if (p.item.roomId && t.roomIds.includes(p.item.roomId)) hits.push(`ห้อง ${index.roomLabel(p.item.roomId)}`);
      if (hits.length === 0) continue;
      out.push({
        messageKey: 'H08.violation',
        params: {
          block: block.name,
          subject: index.subjectLabel(p.item.offeringId),
          target: hits.join(', '),
          slot: index.placedSlotText(p),
          blockSlot: index.slotText(block.dayOfWeek, block.startPeriod, block.duration),
        },
        itemIds: [p.item.id],
        offeringId: p.item.offeringId,
        resourceType: 'item',
        resourceId: p.item.id,
        day: p.day,
        period: Math.max(p.start, block.startPeriod),
      });
    }
  }
  return out;
};

/**
 * H09: multi-period items and `mustBeConsecutive` subjects stay inside the open
 * periods of one day and one shift and do not straddle the group's lunch period.
 * Pieces of the same consecutive segment must be contiguous on the same day.
 * Works identically in hard or soft mode.
 */
export const evaluateH09: ConstraintEvaluator = ({ index, params }) => {
  const byLevel = recordParam(params, 'lunchPeriodByLevel');
  const out: ViolationDraft[] = [];
  const pieces = new Map<string, PlacedItem[]>();
  for (const p of index.placed) {
    const must = p.subject?.mustBeConsecutive === true;
    if (!must && p.periods.length <= 1) continue;
    const subject = index.subjectLabel(p.item.offeringId);
    const slot = index.placedSlotText(p);
    const base = { itemIds: [p.item.id], offeringId: p.item.offeringId, resourceType: 'item' as const, resourceId: p.item.id, day: p.day, period: p.start };

    const closed = closedPeriods(index, p);
    if (closed.length > 0) {
      out.push({ ...base, messageKey: 'H09.out_of_day', params: { subject, slot, periods: periodList(closed), maxPeriod: index.maxPeriod } });
    }
    for (const groupId of p.audienceGroupIds) {
      const lunch = index.lunchPeriodOf(groupId, byLevel);
      if (lunch !== undefined && p.start < lunch && p.end > lunch) {
        out.push({ ...base, messageKey: 'H09.cross_lunch', params: { subject, group: index.groupLabel(groupId), lunchPeriod: lunch, slot } });
      }
    }
    if (new Set(p.periods.map((per) => index.shiftOf(per))).size > 1) {
      out.push({ ...base, messageKey: 'H09.cross_shift', params: { subject, slot } });
    }
    if (must) {
      const key = `${p.item.offeringId}|${p.item.segmentIndex}|${p.item.subgroupId ?? ''}`;
      const list = pieces.get(key) ?? [];
      list.push(p);
      pieces.set(key, list);
    }
  }
  for (const list of pieces.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.day - b.day || a.start - b.start || a.item.id.localeCompare(b.item.id));
    const contiguous = sorted.every((p, i) => i === 0 || (p.day === sorted[i - 1].day && p.start === sorted[i - 1].end + 1));
    if (contiguous) continue;
    const first = sorted[0];
    out.push({
      messageKey: 'H09.not_contiguous',
      params: {
        subject: index.subjectLabel(first.item.offeringId),
        count: sorted.length,
        slots: sorted.map((p) => index.placedSlotText(p)).join(' / '),
      },
      itemIds: sorted.map((p) => p.item.id),
      offeringId: first.item.offeringId,
      resourceType: 'offering',
      resourceId: first.item.offeringId,
      day: first.day,
      period: first.start,
    });
  }
  return out;
};

/** H10: weekday ∈ `group.allowedDays` and the period shift matches `group.allowedShift`. */
export const evaluateH10: ConstraintEvaluator = ({ index, params }) => {
  const eveningStart = typeof params.eveningStartPeriod === 'number' ? params.eveningStartPeriod : undefined;
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    for (const groupId of p.audienceGroupIds) {
      const g = index.groupById.get(groupId);
      if (!g) continue;
      const base = { itemIds: [p.item.id], offeringId: p.item.offeringId, resourceType: 'group' as const, resourceId: groupId, day: p.day, period: p.start };
      if ((g.allowedDays?.length ?? 0) > 0 && !g.allowedDays.includes(p.day)) {
        out.push({ ...base, messageKey: 'H10.day', params: { group: g.groupCode, day: dayNameTh(p.day), slot: index.placedSlotText(p) } });
      }
      const allowed = g.allowedShift;
      if (allowed && allowed !== 'both') {
        const bad = p.periods.filter((per) => index.shiftOf(per, eveningStart) !== allowed);
        if (bad.length > 0) {
          out.push({
            ...base,
            messageKey: 'H10.shift',
            params: { group: g.groupCode, shift: SHIFT_TH[allowed] ?? allowed, slot: index.placedSlotText(p), periods: periodList(bad) },
            severity: bad.length,
          });
        }
      }
    }
  }
  return out;
};

/** H21: `student_groups.unavailableSlots` + slot exists/open in `time_slots`. */
export const evaluateH21: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const slot = index.placedSlotText(p);
    const closed = closedPeriods(index, p);
    if (closed.length > 0) {
      out.push({
        messageKey: 'H21.slot_invalid',
        params: { subject: index.subjectLabel(p.item.offeringId), slot, periods: periodList(closed) },
        itemIds: [p.item.id],
        severity: closed.length,
        offeringId: p.item.offeringId,
        resourceType: 'item',
        resourceId: p.item.id,
        day: p.day,
        period: p.start,
      });
    }
    for (const groupId of p.audienceGroupIds) {
      const unavailable = index.groupUnavailable.get(groupId);
      const bad = p.periods.filter((period) => unavailable?.has(slotKey(p.day, period)) ?? false);
      if (bad.length === 0) continue;
      out.push({
        messageKey: 'H21.violation',
        params: { group: index.groupLabel(groupId), subject: index.subjectLabel(p.item.offeringId), slot, periods: periodList(bad) },
        itemIds: [p.item.id],
        severity: bad.length,
        offeringId: p.item.offeringId,
        resourceType: 'group',
        resourceId: groupId,
        day: p.day,
        period: bad[0],
      });
    }
  }
  return out;
};
