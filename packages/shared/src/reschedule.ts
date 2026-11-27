/**
 * Single-cell move & swap planner (used by the timetable editor).
 * For one placed item it lists every slot it can move to and every same-group item it can swap with,
 * each with a short Thai reason when it is not possible. Pure — the server re-checks clashes in the DB.
 */
import { OccupancyIndex, type OccupancyClash } from './occupancy';
import type { ScheduleEvaluationContext } from './constraints/types';

export type RescheduleContext = Pick<
  ScheduleEvaluationContext,
  'timeSlots' | 'rooms' | 'staff' | 'studentGroups' | 'subgroups' | 'subjects' | 'offerings' | 'offeringGroups' | 'items' | 'itemTeachers'
>;

export interface MoveOption {
  day: number;
  period: number;
  ok: boolean;
  reason?: string;
}

export interface SwapOption {
  otherItemId: string;
  day: number;
  period: number;
  ok: boolean;
  reason?: string;
}

export interface CellPlan {
  moves: MoveOption[];
  swaps: SwapOption[];
}

export function planCellActions(ctx: RescheduleContext, itemId: string): CellPlan {
  const item = ctx.items.find((i) => i.id === itemId);
  if (!item) return { moves: [], swaps: [] };

  const roomById = new Map(ctx.rooms.map((r) => [r.id, r]));
  const staffName = new Map(ctx.staff.map((s) => [s.id, s.fullName]));
  const groupById = new Map(ctx.studentGroups.map((g) => [g.id, g]));
  const subjectOfOffering = new Map(
    ctx.offerings.map((o) => [o.id, ctx.subjects.find((s) => s.id === o.subjectId)?.subjectName ?? '']),
  );
  const groupsOf = new Map<string, string[]>();
  for (const og of ctx.offeringGroups) groupsOf.set(og.offeringId, [...(groupsOf.get(og.offeringId) ?? []), og.groupId]);
  const teachersOf = new Map<string, string[]>();
  for (const it of ctx.itemTeachers) teachersOf.set(it.itemId, [...(teachersOf.get(it.itemId) ?? []), it.staffId]);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const placed = ctx.items.filter((i) => i.status !== 'unplaced_tray' && i.dayOfWeek != null && i.startPeriod != null);

  const params = (it: typeof item, day: number, startPeriod: number) => ({
    itemId: it.id,
    day,
    startPeriod,
    duration: it.duration,
    teacherIds: teachersOf.get(it.id) ?? [],
    groupIds: groupsOf.get(it.offeringId) ?? [],
    subgroupId: it.subgroupId,
    room: it.roomId ? (roomById.get(it.roomId) ?? null) : null,
  });

  const occ = new OccupancyIndex(ctx.subgroups);
  for (const it of placed) occ.addItem(params(it, it.dayOfWeek!, it.startPeriod!));

  const open = new Set(ctx.timeSlots.flatMap((t) => (t.openDays ?? []).map((d) => `${d}:${t.period}`)));
  const groupLabel = (gid: string) => groupById.get(gid)?.groupCode ?? gid;
  const whoIsThere = (blockingId: string | undefined) => {
    const b = blockingId ? itemById.get(blockingId) : undefined;
    return b ? `${(groupsOf.get(b.offeringId) ?? []).map(groupLabel).join(', ')} (${subjectOfOffering.get(b.offeringId)})` : 'คาบอื่น';
  };
  const describe = (c: OccupancyClash, who: string) => {
    const at = whoIsThere(c.blockingItemIds[0]);
    if (c.resourceType === 'teacher') return `${who}${staffName.get(c.resourceId) ?? 'ครู'} ติดสอน ${at} ในคาบนี้`;
    if (c.resourceType === 'room') return `${who}ห้อง ${roomById.get(c.resourceId)?.roomCode ?? ''} ถูกใช้โดย ${at}`;
    return `${who}กลุ่ม ${groupLabel(c.resourceId)} มีเรียน ${at} อยู่แล้ว`;
  };
  // Reasons a window can never hold this item, independent of other items.
  const windowProblem = (it: typeof item, day: number, start: number): string | undefined => {
    for (let k = 0; k < it.duration; k++) if (!open.has(`${day}:${start + k}`)) return 'อยู่นอกช่วงเวลาเรียนของวันนั้น';
    for (const gid of groupsOf.get(it.offeringId) ?? []) {
      const lunch = groupById.get(gid)?.lunchPeriod;
      if (lunch != null && lunch >= start && lunch < start + it.duration) return `ทับคาบพักกลางวัน (คาบ ${lunch})`;
    }
    return undefined;
  };

  const lockedReason = 'คาบนี้ถูกล็อกไว้ ย้ายหรือสลับไม่ได้';
  const days = [...new Set(ctx.timeSlots.flatMap((t) => t.openDays ?? []))].sort((a, b) => a - b);
  const periods = [...new Set(ctx.timeSlots.map((t) => t.period))].sort((a, b) => a - b);

  const moves: MoveOption[] = [];
  for (const day of days) {
    for (const period of periods) {
      if (day === item.dayOfWeek && period === item.startPeriod) continue;
      let reason = item.isLocked ? lockedReason : windowProblem(item, day, period);
      if (!reason) {
        const clash = occ.findClashes(params(item, day, period))[0];
        if (clash) reason = describe(clash, '');
      }
      moves.push(reason ? { day, period, ok: false, reason } : { day, period, ok: true });
    }
  }

  const swaps: SwapOption[] = [];
  if (item.dayOfWeek != null && item.startPeriod != null) {
    const myGroups = new Set(groupsOf.get(item.offeringId) ?? []);
    const myTeachers = (teachersOf.get(item.id) ?? []).map((t) => staffName.get(t) ?? '').join(', ');
    for (const other of placed) {
      if (other.id === item.id || !(groupsOf.get(other.offeringId) ?? []).some((g) => myGroups.has(g))) continue;
      const base = { otherItemId: other.id, day: other.dayOfWeek!, period: other.startPeriod! };
      const otherTeachers = (teachersOf.get(other.id) ?? []).map((t) => staffName.get(t) ?? '').join(', ');
      let reason: string | undefined;
      if (item.isLocked || other.isLocked) reason = lockedReason;
      else if (other.duration !== item.duration) reason = `จำนวนคาบไม่เท่ากัน (${item.duration} กับ ${other.duration} คาบ)`;
      else {
        reason = windowProblem(item, base.day, base.period) ?? windowProblem(other, item.dayOfWeek, item.startPeriod);
      }
      if (!reason) {
        // Take both out, test each in the other's slot, then put both back (cheaper than cloning the index).
        occ.removeItem(item.id);
        occ.removeItem(other.id);
        const a = occ.findClashes(params(item, base.day, base.period))[0];
        const b = a ? undefined : occ.findClashes(params(other, item.dayOfWeek, item.startPeriod))[0];
        occ.addItem(params(item, item.dayOfWeek, item.startPeriod));
        occ.addItem(params(other, base.day, base.period));
        if (a) reason = describe(a, a.resourceType === 'teacher' ? `${myTeachers || 'ครู'} ไม่ว่างในคาบปลายทาง: ` : '');
        else if (b) reason = describe(b, b.resourceType === 'teacher' ? `${otherTeachers || 'ครู'} ไม่ว่างในคาบต้นทาง: ` : '');
      }
      swaps.push(reason ? { ...base, ok: false, reason } : { ...base, ok: true });
    }
  }
  return { moves, swaps };
}
