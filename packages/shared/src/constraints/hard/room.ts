/** H04 ROOM_CAPACITY · H05 ROOM_TYPE · H12 BUILDING_GAP */
import { itemsInOrder, type PlacedItem } from '../context';
import { numParam, recordParam } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

/**
 * H04: students of an item (combined groups summed, or the subgroup size) ≤ capacity.
 * Multi-group rooms: the concurrent students of all items at (day, period) are summed.
 */
export const evaluateH04: ConstraintEvaluator = ({ index }) => {
  const out: ViolationDraft[] = [];
  const shared = new Map<string, { roomId: string; capacity: number; day: number; period: number; items: PlacedItem[] }>();
  for (const p of index.placed) {
    const room = p.room;
    if (!room) continue;
    if (room.allowMultiGroup) {
      for (const period of p.periods) {
        const key = `${p.day}|${period}|${room.id}`;
        const cell = shared.get(key) ?? { roomId: room.id, capacity: room.capacity, day: p.day, period, items: [] };
        cell.items.push(p);
        shared.set(key, cell);
      }
    } else if (p.studentCount > room.capacity) {
      out.push({
        messageKey: 'H04.violation',
        params: {
          room: room.roomCode,
          capacity: room.capacity,
          students: p.studentCount,
          subject: index.subjectLabel(p.item.offeringId),
          slot: index.placedSlotText(p),
        },
        itemIds: [p.item.id],
        offeringId: p.item.offeringId,
        resourceType: 'room',
        resourceId: room.id,
        day: p.day,
        period: p.start,
      });
    }
  }
  for (const cell of shared.values()) {
    const total = cell.items.reduce((n, p) => n + p.studentCount, 0);
    if (total <= cell.capacity) continue;
    out.push({
      messageKey: 'H04.shared',
      params: {
        room: index.roomLabel(cell.roomId),
        capacity: cell.capacity,
        students: total,
        count: cell.items.length,
        slot: index.slotText(cell.day, cell.period),
      },
      itemIds: cell.items.map((p) => p.item.id).sort(),
      resourceType: 'room',
      resourceId: cell.roomId,
      day: cell.day,
      period: cell.period,
    });
  }
  return out;
};

/**
 * H05: the room type must equal `offering.roomTypeId ?? subject.requiredRoomTypeId`.
 * `params.compatibleTypes` (room-type code → accepted codes) can relax the match,
 * e.g. `{ theory: ['lecture_hall'] }`. Works identically in hard or soft mode.
 */
export const evaluateH05: ConstraintEvaluator = ({ index, params }) => {
  const compatible = recordParam(params, 'compatibleTypes');
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const required = p.offering?.roomTypeId ?? p.subject?.requiredRoomTypeId ?? null;
    if (!required) continue;
    if (!p.item.roomId) {
      out.push({
        messageKey: 'H05.no_room',
        params: { subject: index.subjectLabel(p.item.offeringId), roomType: index.roomTypeLabel(required), slot: index.placedSlotText(p) },
        itemIds: [p.item.id],
        offeringId: p.item.offeringId,
        resourceType: 'item',
        resourceId: p.item.id,
        day: p.day,
        period: p.start,
      });
      continue;
    }
    const actual = p.room?.roomTypeId;
    if (!actual || actual === required) continue;
    const requiredCode = index.roomTypeById.get(required)?.code ?? required;
    const actualCode = index.roomTypeById.get(actual)?.code ?? actual;
    const accepted = compatible[requiredCode];
    if (Array.isArray(accepted) && accepted.includes(actualCode)) continue;
    out.push({
      messageKey: 'H05.violation',
      params: {
        subject: index.subjectLabel(p.item.offeringId),
        room: index.roomLabel(p.item.roomId),
        roomType: index.roomTypeLabel(required),
        actualType: index.roomTypeLabel(actual),
        slot: index.placedSlotText(p),
      },
      itemIds: [p.item.id],
      offeringId: p.item.offeringId,
      resourceType: 'room',
      resourceId: p.item.roomId,
      day: p.day,
      period: p.start,
    });
  }
  return out;
};

/**
 * H12: when a teacher or a student group moves to another building between two
 * classes, at least `gap` free periods (default 1) must separate them.
 */
export const evaluateH12: ConstraintEvaluator = ({ index, params }) => {
  const gap = numParam(params, ['gap', 'minGapPeriods'], 1);
  const out: ViolationDraft[] = [];
  const seen = new Set<string>();

  interface Walker {
    resourceType: 'teacher' | 'group' | 'subgroup';
    resourceId: string;
    /** Label + dedupe id for a pair (whole-group pairs repeat on every subgroup). */
    describe: (a: PlacedItem, b: PlacedItem) => { who: string; dedupeId: string };
  }

  const check = (walker: Walker, ordered: PlacedItem[]) => {
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (b.start <= a.end) continue; // overlapping = clash, not a walk
      const ba = index.buildingOf(a.item.roomId);
      const bb = index.buildingOf(b.item.roomId);
      if (!ba || !bb || ba === bb) continue;
      const free = b.start - a.end - 1;
      if (free >= gap) continue;
      const { who, dedupeId } = walker.describe(a, b);
      const key = `${walker.resourceType === 'teacher' ? 'T' : 'G'}|${dedupeId}|${a.item.id}|${b.item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        messageKey: 'H12.violation',
        params: {
          who,
          fromBuilding: index.buildingLabel(ba),
          toBuilding: index.buildingLabel(bb),
          slot: index.slotText(b.day, a.end, b.start - a.end + 1),
          gap,
          free,
        },
        itemIds: [a.item.id, b.item.id],
        resourceType: walker.resourceType,
        resourceId: walker.resourceId,
        day: b.day,
        period: b.start,
      });
    }
  };

  for (const [staffId, days] of index.teacherTimelines()) {
    const walker: Walker = {
      resourceType: 'teacher',
      resourceId: staffId,
      describe: () => ({ who: `ครู ${index.teacherLabel(staffId)}`, dedupeId: staffId }),
    };
    for (const entries of days.values()) check(walker, itemsInOrder(entries));
  }
  for (const { unit, days } of index.unitTimelines().values()) {
    const walker: Walker = {
      resourceType: unit.type,
      resourceId: unit.id,
      describe: (a, b) => {
        const whole = a.item.subgroupId == null && b.item.subgroupId == null;
        return whole
          ? { who: `กลุ่ม ${index.groupLabel(unit.groupId)}`, dedupeId: unit.groupId }
          : { who: `กลุ่ม ${index.unitLabel(unit)}`, dedupeId: unit.id };
      },
    };
    for (const entries of days.values()) check(walker, itemsInOrder(entries));
  }
  return out;
};
