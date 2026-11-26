import { itemsInOrder, type AudienceUnit, type EvaluationIndex, type PlacedItem, type TimelineEntry } from '../context';

export interface StudentDay {
  unit: AudienceUnit;
  groupId: string;
  day: number;
  entries: TimelineEntry[];
  items: PlacedItem[];
  /** Group code when the day only has whole-group items, else the subgroup label. */
  label: string;
}

/**
 * Student timetables per day. Subgroups of one group that share an identical day
 * (only whole-group items) are reported once, so groups with subgroups are not
 * penalised twice for the same gap.
 */
export function studentDays(index: EvaluationIndex): StudentDay[] {
  const out: StudentDay[] = [];
  const seen = new Set<string>();
  for (const { unit, days } of index.unitTimelines().values()) {
    for (const [day, entries] of days) {
      const items = itemsInOrder(entries);
      const sig = `${unit.groupId}|${day}|${items.map((p) => p.item.id).join(',')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const whole = items.every((p) => !p.item.subgroupId);
      out.push({
        unit,
        groupId: unit.groupId,
        day,
        entries,
        items,
        label: whole ? index.groupLabel(unit.groupId) : index.unitLabel(unit),
      });
    }
  }
  return out;
}

export interface StudentWeek {
  unit: AudienceUnit;
  groupId: string;
  /** day → distinct periods */
  periodsByDay: Map<number, number[]>;
  itemIds: string[];
  label: string;
}

/** Weekly student timetables, de-duplicated across identical subgroups. */
export function studentWeeks(index: EvaluationIndex): StudentWeek[] {
  const out: StudentWeek[] = [];
  const seen = new Set<string>();
  for (const { unit, days } of index.unitTimelines().values()) {
    const ids = new Set<string>();
    const periodsByDay = new Map<number, number[]>();
    for (const day of [...days.keys()].sort((a, b) => a - b)) {
      const entries = days.get(day) ?? [];
      for (const e of entries) ids.add(e.placed.item.id);
      periodsByDay.set(day, [...new Set(entries.map((e) => e.period))].sort((a, b) => a - b));
    }
    const itemIds = [...ids].sort();
    const sig = `${unit.groupId}|${itemIds.join(',')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const whole = itemIds.every((id) => !index.placedById.get(id)?.item.subgroupId);
    out.push({ unit, groupId: unit.groupId, periodsByDay, itemIds, label: whole ? index.groupLabel(unit.groupId) : index.unitLabel(unit) });
  }
  return out;
}

export const itemIdsOf = (items: readonly PlacedItem[]) => [...new Set(items.map((p) => p.item.id))].sort();
