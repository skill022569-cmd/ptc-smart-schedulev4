/**
 * Dated (real-calendar) timetable: the published master timetable + date-specific exceptions
 * (`schedule_exceptions`). The master never changes for "this week only" edits; an exception moves,
 * cancels, substitutes or re-rooms ONE dated occurrence of a class.
 *
 * Occurrence id = `${itemId}@${YYYY-MM-DD of its original date}`. A cancelled occurrence without a
 * makeup date is an owed class ("คาบค้างสอน"); setting a makeup date/period (weekend allowed) pays it.
 */
import type { ScheduleException, ScheduleItem, ScheduleItemTeacher } from './types';
import { planCellActions, type RescheduleContext } from './reschedule';

export type OccurrenceKind = 'regular' | 'moved' | 'makeup' | 'away';

export interface Occurrence {
  id: string;
  item: ScheduleItem;
  /** Date the class belongs to in the master timetable (its lesson week). */
  originalDate: string;
  /** Where it actually happens; null = not taught (cancelled / owed). */
  date: string | null;
  period: number | null;
  kind: OccurrenceKind;
  exception: ScheduleException | null;
  teacherIds: string[];
  roomId: string | null;
}

export const WEEKEND_DAYS = [6, 7];

const pad = (n: number) => String(n).padStart(2, '0');
export const toIsoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso: string, n: number) => {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIsoDate(d);
};
/** 1 = Monday … 7 = Sunday */
export const dayOfWeekOf = (iso: string) => ((parse(iso).getUTCDay() + 6) % 7) + 1;
export const mondayOf = (iso: string) => addDays(iso, 1 - dayOfWeekOf(iso));
/** Term week number (week of termStart = 1). */
export const termWeekOf = (termStart: string, iso: string) =>
  Math.floor((parse(mondayOf(iso)).getTime() - parse(mondayOf(termStart)).getTime()) / (7 * 86_400_000)) + 1;

/** Where a makeup/cancel exception puts the class; a makeup with only a period (from the issue page) is the same day. */
export const makeupSlotOf = (ex: ScheduleException): { date: string; period: number } | null => {
  if (ex.action !== 'makeup' && ex.action !== 'cancel') return null;
  const date = ex.makeupDate ?? (ex.action === 'makeup' && ex.makeupPeriod ? ex.exceptionDate : null);
  return date && ex.makeupPeriod ? { date, period: ex.makeupPeriod } : null;
};

const inWeek = (weekStart: string, iso: string | null) => !!iso && iso >= weekStart && iso <= addDays(weekStart, 6);

/** Every occurrence relevant to the week starting `weekStart` (a Monday). */
export function weekOccurrences(
  items: readonly ScheduleItem[],
  itemTeachers: readonly ScheduleItemTeacher[],
  exceptions: readonly ScheduleException[],
  weekStart: string,
): Occurrence[] {
  const teachersOf = new Map<string, string[]>();
  for (const t of itemTeachers) teachersOf.set(t.itemId, [...(teachersOf.get(t.itemId) ?? []), t.staffId]);
  const exByOcc = new Map(exceptions.map((e) => [`${e.itemId}@${e.exceptionDate}`, e]));
  const itemById = new Map(items.map((i) => [i.id, i]));

  const make = (item: ScheduleItem, originalDate: string, ex: ScheduleException | null): Occurrence => {
    const base = {
      id: `${item.id}@${originalDate}`,
      item,
      originalDate,
      exception: ex,
      teacherIds: ex?.action === 'substitute' && ex.substituteStaffId ? [ex.substituteStaffId] : (teachersOf.get(item.id) ?? []),
      roomId: ex?.action === 'room_change' && ex.newRoomId ? ex.newRoomId : item.roomId,
    };
    if (ex && (ex.action === 'makeup' || ex.action === 'cancel')) {
      const slot = makeupSlotOf(ex);
      if (slot) {
        const kind: OccurrenceKind = mondayOf(slot.date) === mondayOf(originalDate) ? 'moved' : 'makeup';
        return { ...base, date: slot.date, period: slot.period, kind };
      }
      return { ...base, date: null, period: null, kind: 'away' };
    }
    return { ...base, date: originalDate, period: item.startPeriod, kind: 'regular' };
  };

  const out: Occurrence[] = [];
  for (const item of items) {
    if (item.status === 'unplaced_tray' || !item.dayOfWeek || !item.startPeriod) continue;
    const originalDate = addDays(weekStart, item.dayOfWeek - 1);
    out.push(make(item, originalDate, exByOcc.get(`${item.id}@${originalDate}`) ?? null));
  }
  // Classes from other weeks that are made up during this week.
  for (const ex of exceptions) {
    if (inWeek(weekStart, ex.exceptionDate) || !inWeek(weekStart, makeupSlotOf(ex)?.date ?? null)) continue;
    const item = itemById.get(ex.itemId);
    if (item && (ex.action === 'makeup' || ex.action === 'cancel')) out.push(make(item, ex.exceptionDate, ex));
  }
  return out;
}

/** Owed classes: cancelled occurrences that have no makeup slot yet (all weeks). */
export function owedOccurrences(
  items: readonly ScheduleItem[],
  itemTeachers: readonly ScheduleItemTeacher[],
  exceptions: readonly ScheduleException[],
): Occurrence[] {
  return exceptions
    .filter((e) => (e.action === 'cancel' || e.action === 'makeup') && !makeupSlotOf(e))
    .flatMap((e) => weekOccurrences(items, itemTeachers, [e], mondayOf(e.exceptionDate)).filter((o) => o.exception === e));
}

/**
 * A scheduling context for one dated week, so the regular move/swap planner works on it:
 * occurrences become items (id = occurrence id), weekend days are open for makeups, and
 * `extra` occurrences (e.g. an owed class being placed) can be added unplaced.
 */
export function weekPlanningContext(
  ctx: RescheduleContext,
  occurrences: readonly Occurrence[],
  extra: readonly Occurrence[] = [],
): RescheduleContext {
  const all = [...occurrences, ...extra.filter((x) => !occurrences.some((o) => o.id === x.id))];
  return {
    ...ctx,
    timeSlots: ctx.timeSlots.map((t) => ({ ...t, openDays: [...new Set([...(t.openDays ?? []), ...WEEKEND_DAYS])] })),
    items: all.map((o) => ({
      ...o.item,
      id: o.id,
      roomId: o.roomId,
      status: o.date ? 'scheduled' : 'unplaced_tray',
      dayOfWeek: o.date ? dayOfWeekOf(o.date) : null,
      startPeriod: o.period,
    })),
    itemTeachers: all.flatMap((o) => o.teacherIds.map((staffId) => ({ itemId: o.id, staffId }))),
  };
}

/**
 * Why `occ` cannot be taught at (date, period) in that date's week — or undefined if it can.
 * Checks teacher / group / room clashes against the week's real occurrences, lunch and open hours.
 */
export function datedPlacementProblem(
  ctx: RescheduleContext,
  exceptions: readonly ScheduleException[],
  occ: Occurrence,
  date: string,
  period: number,
): string | undefined {
  const week = weekOccurrences(ctx.items, ctx.itemTeachers, exceptions, mondayOf(date)).filter((o) => o.id !== occ.id);
  const planCtx = weekPlanningContext(ctx, week, [{ ...occ, date: null, period: null }]);
  const move = planCellActions(planCtx, occ.id).moves.find((m) => m.day === dayOfWeekOf(date) && m.period === period);
  return move ? move.reason : 'ไม่มีคาบนี้ในวันดังกล่าว';
}
