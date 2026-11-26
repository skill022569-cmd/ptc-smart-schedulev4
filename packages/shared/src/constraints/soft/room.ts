/** S04 ROOM_BEST_FIT */
import { numParam, round } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

/**
 * S04: wasted seats, normalised per room size and weighted by duration:
 * `penalty = (capacity − students) / capacity × periods`, so a half-empty room for
 * 2 periods costs 1.0. Ratios ≤ `toleranceRatio` (default 0) are free.
 * Multi-group rooms are skipped (their load is shared).
 */
export const evaluateS04: ConstraintEvaluator = ({ index, params }) => {
  const tolerance = numParam(params, ['toleranceRatio'], 0);
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const room = p.room;
    if (!room || room.allowMultiGroup || room.capacity <= 0) continue;
    const wasted = room.capacity - p.studentCount;
    if (wasted <= 0) continue;
    const ratio = wasted / room.capacity;
    if (ratio <= tolerance) continue;
    out.push({
      messageKey: 'S04.violation',
      params: {
        room: room.roomCode,
        capacity: room.capacity,
        students: p.studentCount,
        wasted,
        subject: index.subjectLabel(p.item.offeringId),
      },
      itemIds: [p.item.id],
      severity: round(ratio * p.periods.length),
      offeringId: p.item.offeringId,
      resourceType: 'room',
      resourceId: room.id,
      day: p.day,
      period: p.start,
    });
  }
  return out;
};
