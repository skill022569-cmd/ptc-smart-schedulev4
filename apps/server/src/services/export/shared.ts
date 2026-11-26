import { dayNameTh, formatSlotTimeTh, type ScheduleEvaluationContext } from '@ptc/shared';

export type ExportViewMode = 'group' | 'teacher' | 'room' | 'master';

export interface ExportRow {
  day: number;
  dayName: string;
  startPeriod: number;
  endPeriod: number;
  duration: number;
  timeText: string;
  groupCodes: string;
  subgroupLabel: string;
  subjectCode: string;
  subjectName: string;
  teachers: string;
  roomCode: string;
  status: string;
  xaiSummary: string;
}

export function extractExportRows(
  ctx: ScheduleEvaluationContext,
  options: { view?: ExportViewMode; targetId?: string } = {},
): ExportRow[] {
  const offById = new Map(ctx.offerings.map((o) => [o.id, o]));
  const subjById = new Map(ctx.subjects.map((s) => [s.id, s]));
  const roomById = new Map(ctx.rooms.map((r) => [r.id, r]));
  const staffById = new Map(ctx.staff.map((s) => [s.id, s]));
  const groupById = new Map(ctx.studentGroups.map((g) => [g.id, g]));
  const subById = new Map(ctx.subgroups.map((sg) => [sg.id, sg]));
  const groupsByOff = new Map<string, string[]>();
  for (const og of ctx.offeringGroups) {
    const l = groupsByOff.get(og.offeringId) ?? [];
    l.push(og.groupId);
    groupsByOff.set(og.offeringId, l);
  }
  const teachersByItem = new Map<string, string[]>();
  for (const it of ctx.itemTeachers) {
    const l = teachersByItem.get(it.itemId) ?? [];
    l.push(it.staffId);
    teachersByItem.set(it.itemId, l);
  }

  const rows: ExportRow[] = [];
  for (const item of ctx.items) {
    const gIds = groupsByOff.get(item.offeringId) ?? [];
    const tIds = teachersByItem.get(item.id) ?? [];

    if (options.targetId && options.view === 'group' && !gIds.includes(options.targetId)) continue;
    if (options.targetId && options.view === 'teacher' && !tIds.includes(options.targetId)) continue;
    if (options.targetId && options.view === 'room' && item.roomId !== options.targetId) continue;

    const off = offById.get(item.offeringId);
    const subj = off ? subjById.get(off.subjectId) : undefined;
    const room = item.roomId ? roomById.get(item.roomId) : undefined;
    const sub = item.subgroupId ? subById.get(item.subgroupId) : undefined;
    const day = item.dayOfWeek ?? 0;
    const start = item.startPeriod ?? 0;
    const end = start > 0 ? start + item.duration - 1 : 0;

    const failedXai = (item.explanation ?? []).filter((e) => !e.passed).map((e) => e.messageTh).filter(Boolean);
    const xaiSummary =
      failedXai.length > 0
        ? failedXai.join('; ')
        : item.status === 'unplaced_tray'
          ? 'อยู่ในถาดรอจัด'
          : 'ผ่านทุกเงื่อนไข Hard';

    rows.push({
      day,
      dayName: day > 0 ? dayNameTh(day) : 'รอจัด',
      startPeriod: start,
      endPeriod: end,
      duration: item.duration,
      timeText: day > 0 && start > 0 ? formatSlotTimeTh(day, start, item.duration, ctx.timeSlots) : 'ถาดรอจัด',
      groupCodes: gIds.map((gid) => groupById.get(gid)?.groupCode ?? gid).join(', '),
      subgroupLabel: sub ? `กลุ่ม ${sub.code}` : 'ทั้งกลุ่ม',
      subjectCode: subj?.subjectCode ?? item.offeringId,
      subjectName: subj?.subjectName ?? '',
      teachers: tIds.map((tid) => staffById.get(tid)?.fullName ?? tid).join(', '),
      roomCode: room?.roomCode ?? '-',
      status: item.status ?? 'scheduled',
      xaiSummary,
    });
  }

  rows.sort((a, b) => a.day - b.day || a.startPeriod - b.startPeriod || a.groupCodes.localeCompare(b.groupCodes));
  return rows;
}
