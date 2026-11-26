import ExcelJS from 'exceljs';
import { evaluateSchedule, type ScheduleEvaluationContext } from '@ptc/shared';
import { extractExportRows, type ExportViewMode } from './shared';

export async function exportTimetableExcel(
  ctx: ScheduleEvaluationContext,
  options: { view?: ExportViewMode; targetId?: string; versionName?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PTC Smart Schedule V4';
  wb.created = new Date();

  const report = evaluateSchedule(ctx, { includePassedExplanations: false });
  const rows = extractExportRows(ctx, options);

  // Sheet 1: Timetable
  const ws = wb.addWorksheet('ตารางสอน', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.mergeCells('A1:L1');
  const title = ws.getCell('A1');
  title.value = `PTC Smart Schedule V4 — ${options.versionName ?? 'ฉบับล่าสุด'} (Hard Violation: ${report.hardCount}, Fitness: ${report.fitness})`;
  title.font = { bold: true, size: 13 };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 26;

  const headers = ['วัน', 'คาบ', 'จำนวน', 'เวลา', 'กลุ่มเรียน', 'กลุ่มย่อย', 'รหัสวิชา', 'ชื่อวิชา', 'ครูผู้สอน', 'ห้อง', 'สถานะ', 'เหตุผล XAI'];
  const hRow = ws.addRow(headers);
  hRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  for (const r of rows) {
    ws.addRow([
      r.dayName,
      r.startPeriod > 0 ? `${r.startPeriod}${r.endPeriod > r.startPeriod ? `-${r.endPeriod}` : ''}` : '-',
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
    ]);
  }

  ws.columns.forEach((col, i) => {
    col.width = [12, 10, 8, 28, 16, 12, 14, 30, 26, 12, 12, 36][i] ?? 18;
  });

  // Sheet 2: Quality & Soft Penalty Summary
  const ws2 = wb.addWorksheet('สรุปผลตรวจ_XAI');
  ws2.addRow(['ตัวชี้วัด', 'ค่า']).font = { bold: true };
  ws2.addRow(['โปรไฟล์', report.profileName]);
  ws2.addRow(['Hard Violations', report.hardCount]);
  ws2.addRow(['Soft Penalty รวม', report.totalPenalty]);
  ws2.addRow(['Fitness Score', report.fitness]);
  ws2.addRow(['ความพึงพอใจครู', `${Math.round(report.multiObjective.teacherSatisfaction * 100)}%`]);
  ws2.addRow(['อัตราการใช้ห้อง', `${Math.round(report.multiObjective.roomUtilization * 100)}%`]);
  ws2.addRow([]);
  ws2.addRow(['รหัส Soft', 'รายการ', 'จำนวน', 'น้ำหนัก', 'คะแนนปรับ']).font = { bold: true };
  for (const sp of report.softPenalties) {
    ws2.addRow([sp.code, sp.name, sp.violations.length, sp.weight, sp.weightedPenalty]);
  }
  ws2.columns.forEach((c, i) => {
    c.width = [18, 32, 12, 12, 14][i] ?? 16;
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
