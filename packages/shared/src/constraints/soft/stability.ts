/** S07 MIN_CHANGES */
import type { ScheduleItem } from '../../types';
import type { EvaluationIndex } from '../context';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

const naturalKey = (i: ScheduleItem) => `${i.offeringId}|${i.segmentIndex}|${i.subgroupId ?? ''}`;

function teacherMap(rows: ReadonlyArray<{ itemId: string; staffId: string }>): Map<string, string> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const list = m.get(r.itemId) ?? [];
    if (!list.includes(r.staffId)) list.push(r.staffId);
    m.set(r.itemId, list);
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort().join(',')]));
}

function describe(index: EvaluationIndex, item: ScheduleItem): string {
  if (item.dayOfWeek === null || item.startPeriod === null || item.status === 'unplaced_tray') return 'ถาดรอจัด';
  return `${index.slotText(item.dayOfWeek, item.startPeriod, item.duration)} ห้อง ${index.roomLabel(item.roomId)}`;
}

/**
 * S07: items whose (day, start period, room, teachers) differ from the baseline
 * version. Matched by item id, else by (offering, segment, subgroup). Items added or
 * removed relative to the baseline count as changes too. No baseline → no penalty.
 */
export const evaluateS07: ConstraintEvaluator = ({ ctx, index }) => {
  const baseline = ctx.baselineItems;
  if (!baseline || baseline.length === 0) return [];
  const baseTeachers = teacherMap(ctx.baselineItemTeachers ?? []);
  const curTeachers = teacherMap(ctx.itemTeachers);
  const byId = new Map(baseline.map((b) => [b.id, b]));
  const byKey = new Map<string, ScheduleItem[]>();
  for (const b of baseline) {
    const list = byKey.get(naturalKey(b)) ?? [];
    list.push(b);
    byKey.set(naturalKey(b), list);
  }
  const used = new Set<string>();
  const out: ViolationDraft[] = [];
  for (const item of ctx.items) {
    let base = byId.get(item.id);
    if (!base || used.has(base.id)) base = (byKey.get(naturalKey(item)) ?? []).find((b) => !used.has(b.id));
    const subject = index.subjectLabel(item.offeringId);
    if (!base) {
      out.push({
        messageKey: 'S07.added',
        params: { subject, after: describe(index, item) },
        itemIds: [item.id],
        offeringId: item.offeringId,
        resourceType: 'item',
        resourceId: item.id,
      });
      continue;
    }
    used.add(base.id);
    const changed =
      base.dayOfWeek !== item.dayOfWeek ||
      base.startPeriod !== item.startPeriod ||
      (base.roomId ?? null) !== (item.roomId ?? null) ||
      (baseTeachers.get(base.id) ?? '') !== (curTeachers.get(item.id) ?? '');
    if (!changed) continue;
    out.push({
      messageKey: 'S07.changed',
      params: { subject, before: describe(index, base), after: describe(index, item) },
      itemIds: [item.id],
      offeringId: item.offeringId,
      resourceType: 'item',
      resourceId: item.id,
      day: item.dayOfWeek ?? undefined,
      period: item.startPeriod ?? undefined,
    });
  }
  for (const b of baseline) {
    if (used.has(b.id)) continue;
    out.push({
      messageKey: 'S07.removed',
      params: { subject: index.subjectLabel(b.offeringId), before: describe(index, b) },
      itemIds: [],
      offeringId: b.offeringId,
      resourceType: 'item',
      resourceId: b.id,
    });
  }
  return out;
};
