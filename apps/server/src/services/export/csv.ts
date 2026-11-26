import type { ScheduleEvaluationContext } from '@ptc/shared';
import { extractExportRows, type ExportViewMode } from './shared';

function csvCell(v: string | number): string {
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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
