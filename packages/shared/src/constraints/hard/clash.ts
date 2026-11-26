/** H01 TEACHER_CLASH · H02 ROOM_CLASH · H03 GROUP_CLASH — via OccupancyIndex conflicts. */
import type { ConstraintEvaluator, ViolationDraft } from '../types';

/** H01: one teacher, one (day, period), ≥2 items. */
export const evaluateH01: ConstraintEvaluator = ({ index }) =>
  index
    .occupancy()
    .conflicts()
    .filter((c) => c.resourceType === 'teacher')
    .map((c): ViolationDraft => ({
      messageKey: 'H01.violation',
      params: { teacher: index.teacherLabel(c.resourceId), slot: index.slotText(c.day, c.period), count: c.blockingItemIds.length },
      itemIds: c.blockingItemIds,
      resourceType: 'teacher',
      resourceId: c.resourceId,
      day: c.day,
      period: c.period,
    }));

/** H02: exclusive room (allowMultiGroup = false) used by ≥2 items in one cell. */
export const evaluateH02: ConstraintEvaluator = ({ index }) =>
  index
    .occupancy()
    .conflicts()
    .filter((c) => c.resourceType === 'room')
    .map((c): ViolationDraft => ({
      messageKey: 'H02.violation',
      params: { room: index.roomLabel(c.resourceId), slot: index.slotText(c.day, c.period), count: c.blockingItemIds.length },
      itemIds: c.blockingItemIds,
      resourceType: 'room',
      resourceId: c.resourceId,
      day: c.day,
      period: c.period,
    }));

/**
 * H03: group (no subgroups) or subgroup cell claimed by ≥2 items. A whole-group clash
 * appears on every subgroup cell, so it is reported once per (group, cell, items).
 */
export const evaluateH03: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  const seen = new Set<string>();
  for (const c of index.occupancy().conflicts()) {
    if (c.resourceType !== 'group' && c.resourceType !== 'subgroup') continue;
    const groupId = c.resourceType === 'group' ? c.resourceId : (index.subgroupById.get(c.resourceId)?.groupId ?? c.resourceId);
    const wholeGroup = c.blockingItemIds.every((id) => index.placedById.get(id)?.item.subgroupId == null);
    const key = `${c.day}|${c.period}|${wholeGroup ? groupId : c.resourceId}|${c.blockingItemIds.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = c.resourceType === 'group' || wholeGroup ? index.groupLabel(groupId) : index.subgroupLabel(c.resourceId);
    out.push({
      messageKey: 'H03.violation',
      params: { group: label, slot: index.slotText(c.day, c.period), count: c.blockingItemIds.length },
      itemIds: c.blockingItemIds,
      resourceType: wholeGroup ? 'group' : c.resourceType,
      resourceId: wholeGroup ? groupId : c.resourceId,
      day: c.day,
      period: c.period,
    });
  }
  return out;
};
