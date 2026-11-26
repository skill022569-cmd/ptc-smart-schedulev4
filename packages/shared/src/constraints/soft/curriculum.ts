/** S02 SUBJECT_SPREAD · S03 TIME_PREFERENCE · S11 CONTENT_SEQUENCE */
import { dayNameTh } from '../../explain/messages.th';
import type { EvaluationIndex, PlacedItem } from '../context';
import { arrayParam, boolParam, numListParam, numParam } from '../params';
import type { ConstraintEvaluator, ViolationDraft } from '../types';

const timeKey = (p: PlacedItem) => p.day * 1000 + p.start;

/** offeringId → track (subgroupId or '') → segmentIndex → earliest piece. */
function segmentsByTrack(index: EvaluationIndex): Map<string, Map<string, Map<number, PlacedItem>>> {
  const out = new Map<string, Map<string, Map<number, PlacedItem>>>();
  for (const p of index.placed) {
    const tracks = out.get(p.item.offeringId) ?? new Map<string, Map<number, PlacedItem>>();
    const track = p.item.subgroupId ?? '';
    const segs = tracks.get(track) ?? new Map<number, PlacedItem>();
    const prev = segs.get(p.item.segmentIndex);
    if (!prev || timeKey(p) < timeKey(prev)) segs.set(p.item.segmentIndex, p);
    tracks.set(track, segs);
    out.set(p.item.offeringId, tracks);
  }
  return out;
}

/** S02: two segments of one offering on the same day (1) or adjacent days (0.5). */
export const evaluateS02: ConstraintEvaluator = ({ index, params }) => {
  const sameDay = numParam(params, ['sameDayPenalty'], 1);
  const adjacent = numParam(params, ['adjacentDayPenalty'], 0.5);
  const out: ViolationDraft[] = [];
  for (const [offeringId, tracks] of segmentsByTrack(index)) {
    for (const segs of tracks.values()) {
      const list = [...segs.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const diff = Math.abs(a.day - b.day);
          const penalty = diff === 0 ? sameDay : diff === 1 ? adjacent : 0;
          if (penalty <= 0) continue;
          out.push({
            messageKey: diff === 0 ? 'S02.same_day' : 'S02.adjacent_day',
            params: { subject: index.subjectLabel(offeringId), dayA: dayNameTh(a.day), dayB: dayNameTh(b.day) },
            itemIds: [a.item.id, b.item.id].sort(),
            severity: penalty,
            offeringId,
            resourceType: 'offering',
            resourceId: offeringId,
            day: b.day,
            period: b.start,
          });
        }
      }
    }
  }
  return out;
};

/** S03: `morning` subjects outside periods 1–4, `afternoon` subjects outside 6–9 (per period). */
export const evaluateS03: ConstraintEvaluator = ({ index, params }) => {
  const morning = numListParam(params, ['morningPeriods'], [1, 2, 3, 4]);
  const afternoon = numListParam(params, ['afternoonPeriods'], [6, 7, 8, 9]);
  const out: ViolationDraft[] = [];
  for (const p of index.placed) {
    const pref = p.subject?.timePreference;
    if (pref !== 'morning' && pref !== 'afternoon') continue;
    const allowed = pref === 'morning' ? morning : afternoon;
    const bad = p.periods.filter((per) => !allowed.includes(per));
    if (bad.length === 0) continue;
    out.push({
      messageKey: 'S03.violation',
      params: {
        subject: index.subjectLabel(p.item.offeringId),
        preference: pref === 'morning' ? 'ช่วงเช้า' : 'ช่วงบ่าย',
        slot: index.placedSlotText(p),
        periods: bad.join(', '),
      },
      itemIds: [p.item.id],
      severity: bad.length,
      offeringId: p.item.offeringId,
      resourceType: 'item',
      resourceId: p.item.id,
      day: p.day,
      period: bad[0],
    });
  }
  return out;
};

interface SequenceRule {
  before: string;
  after: string;
}

function readSequences(raw: unknown[]): SequenceRule[] {
  const rules: SequenceRule[] = [];
  for (const r of raw) {
    if (Array.isArray(r)) {
      const chain = r.map(String);
      for (let i = 0; i + 1 < chain.length; i++) rules.push({ before: chain[i], after: chain[i + 1] });
    } else if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      if (o.before != null && o.after != null) rules.push({ before: String(o.before), after: String(o.after) });
    }
  }
  return rules;
}

/**
 * S11: content order.
 * - `segmentOrder` (default true): segment k of an offering (e.g. theory) should come
 *   earlier in the week than segment k+1 (e.g. practice) for the same track.
 * - `sequences`: `[{ before, after }]` or chains `[[a, b, c]]` of subject ids/codes —
 *   for each group taking both, the first `before` class precedes the first `after` class.
 */
export const evaluateS11: ConstraintEvaluator = ({ index, params }) => {
  const out: ViolationDraft[] = [];
  if (boolParam(params, ['segmentOrder'], true)) {
    for (const [offeringId, tracks] of segmentsByTrack(index)) {
      for (const segs of tracks.values()) {
        const list = [...segs.entries()].sort((a, b) => a[0] - b[0]);
        for (let i = 0; i + 1 < list.length; i++) {
          const [idxA, a] = list[i];
          const [idxB, b] = list[i + 1];
          if (timeKey(a) <= timeKey(b)) continue;
          out.push({
            messageKey: 'S11.segment_order',
            params: { subject: index.subjectLabel(offeringId), first: idxA + 1, second: idxB + 1, slotA: index.placedSlotText(a), slotB: index.placedSlotText(b) },
            itemIds: [a.item.id, b.item.id].sort(),
            offeringId,
            resourceType: 'offering',
            resourceId: offeringId,
            day: b.day,
            period: b.start,
          });
        }
      }
    }
  }

  const rules = readSequences(arrayParam(params, 'sequences'));
  if (rules.length === 0) return out;
  const resolveSubject = (ref: string) =>
    index.subjectById.get(ref) ?? index.ctx.subjects.find((s) => s.subjectCode === ref);
  // groupId|subjectId → earliest placed item
  const earliest = new Map<string, PlacedItem>();
  for (const p of index.placed) {
    if (!p.offering) continue;
    for (const g of p.audienceGroupIds) {
      const key = `${g}|${p.offering.subjectId}`;
      const prev = earliest.get(key);
      if (!prev || timeKey(p) < timeKey(prev)) earliest.set(key, p);
    }
  }
  for (const rule of rules) {
    const before = resolveSubject(rule.before);
    const after = resolveSubject(rule.after);
    if (!before || !after) continue;
    for (const g of index.ctx.studentGroups) {
      const a = earliest.get(`${g.id}|${before.id}`);
      const b = earliest.get(`${g.id}|${after.id}`);
      if (!a || !b || timeKey(a) <= timeKey(b)) continue;
      out.push({
        messageKey: 'S11.sequence',
        params: {
          group: g.groupCode,
          before: `${before.subjectCode} ${before.subjectName}`,
          after: `${after.subjectCode} ${after.subjectName}`,
          slotBefore: index.placedSlotText(a),
          slotAfter: index.placedSlotText(b),
        },
        itemIds: [a.item.id, b.item.id].sort(),
        resourceType: 'group',
        resourceId: g.id,
        day: b.day,
        period: b.start,
      });
    }
  }
  return out;
};
