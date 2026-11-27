import type { ScheduleEvaluationContext } from '@ptc/shared';
import { extractExportRows, type ExportViewMode } from './shared';

function csvCell(v: string | number): string {
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const DAY_CODES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Competition `output.csv`: one row per group per period —
 * group_id,timeslot_id,day,period,subject_id,teacher_id,room_id.
 */
export function exportCompetitionOutputCsv(ctx: ScheduleEvaluationContext, timeslotIds: Record<string, string> = {}): Buffer {
  const groupCode = new Map(ctx.studentGroups.map((g) => [g.id, g.groupCode]));
  const subjectCode = new Map(ctx.subjects.map((s) => [s.id, s.subjectCode]));
  const subjectOf = new Map(ctx.offerings.map((o) => [o.id, subjectCode.get(o.subjectId) ?? o.subjectId]));
  const staffCode = new Map(ctx.staff.map((s) => [s.id, s.employeeCode]));
  const roomCode = new Map(ctx.rooms.map((r) => [r.id, r.roomCode]));
  const groupsOf = new Map<string, string[]>();
  for (const og of ctx.offeringGroups) groupsOf.set(og.offeringId, [...(groupsOf.get(og.offeringId) ?? []), og.groupId]);
  const teacherOf = new Map<string, string>();
  for (const it of ctx.itemTeachers) if (!teacherOf.has(it.itemId)) teacherOf.set(it.itemId, it.staffId);
  // No timeslot_id from the import (e.g. built-in scenarios): number slots day-major like the sample file.
  const perDay = ctx.timeSlots.reduce((m, s) => Math.max(m, s.period), 0);

  const rows: (string | number)[][] = [];
  for (const item of ctx.items) {
    if (item.status === 'unplaced_tray' || !item.dayOfWeek || !item.startPeriod) continue;
    const teacherId = teacherOf.get(item.id);
    for (const gid of groupsOf.get(item.offeringId) ?? []) {
      for (let p = item.startPeriod; p < item.startPeriod + item.duration; p++) {
        rows.push([
          groupCode.get(gid) ?? gid,
          timeslotIds[`${item.dayOfWeek}-${p}`] ?? (item.dayOfWeek - 1) * perDay + p,
          DAY_CODES[item.dayOfWeek] ?? item.dayOfWeek,
          p,
          subjectOf.get(item.offeringId) ?? '',
          teacherId ? (staffCode.get(teacherId) ?? teacherId) : '',
          item.roomId ? (roomCode.get(item.roomId) ?? item.roomId) : '',
        ]);
      }
    }
  }
  const dayIdx = (d: string | number) => DAY_CODES.indexOf(String(d));
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || dayIdx(a[2]!) - dayIdx(b[2]!) || Number(a[3]) - Number(b[3]));
  const header = ['group_id', 'timeslot_id', 'day', 'period', 'subject_id', 'teacher_id', 'room_id'];
  return Buffer.from([header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n', 'utf8');
}

export function exportTimetableCsv(
  ctx: ScheduleEvaluationContext,
  options: { view?: ExportViewMode; targetId?: string } = {},
): Buffer {
  const rows = extractExportRows(ctx, options);
  const header = ['วัน', 'คาบเริ่ม', 'คาบสิ้นสุด', 'จำนวนคาบ', 'ช่วงเวลา', 'กลุ่มเรียน', 'กลุ่มย่อย', 'รหัสวิชา', 'ชื่อวิชา', 'ครูผู้สอน', 'ห้องเรียน', 'สถานะ', 'ผลตรวจ XAI'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.dayName,
        r.startPeriod || '-',
        r.endPeriod || '-',
        r.duration,
        r.timeText,
        r.groupCodes,
        r.subgroupLabel,
        r.subjectCode,
        r.subjectName,
        r.teachers,
        r.roomCode,
        r.status,
        r.xaiSummary,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}
