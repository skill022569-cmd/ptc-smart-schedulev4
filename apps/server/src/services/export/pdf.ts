import { existsSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { buildQualitySummary4D, evaluateSchedule, type ScheduleEvaluationContext } from '@ptc/shared';
import { resolveProjectFile } from '../../db/env';
import { extractExportRows, type ExportViewMode } from './shared';

function resolveFontPath(fileName: string): string | null {
  const metaDir = typeof import.meta?.dirname === 'string' ? import.meta.dirname : process.cwd();
  const candidates = [
    resolveProjectFile('apps', 'server', 'assets', 'fonts', fileName),
    path.resolve(process.cwd(), 'apps', 'server', 'assets', 'fonts', fileName),
    path.resolve(process.cwd(), 'assets', 'fonts', fileName),
    path.resolve(metaDir, '..', '..', '..', 'assets', 'fonts', fileName),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export async function exportTimetablePdf(
  ctx: ScheduleEvaluationContext,
  options: { view?: ExportViewMode; targetId?: string; versionName?: string } = {},
): Promise<Buffer> {
  const regularFont = resolveFontPath('Sarabun-Regular.ttf');
  const boldFont = resolveFontPath('Sarabun-Bold.ttf');
  const report = evaluateSchedule(ctx, { includePassedExplanations: false });
  const summary = buildQualitySummary4D(ctx, report);
  const rows = extractExportRows(ctx, options);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (regularFont) doc.registerFont('Sarabun', regularFont);
    if (boldFont) doc.registerFont('Sarabun-Bold', boldFont);
    const bodyFont = regularFont ? 'Sarabun' : 'Helvetica';
    const headFont = boldFont ? 'Sarabun-Bold' : bodyFont;

    doc.font(headFont).fontSize(15).text('PTC Smart Schedule V4 — รายงานตารางสอนและผลตรวจ 4 ด้าน');
    doc
      .font(bodyFont)
      .fontSize(10)
      .text(
        `เวอร์ชัน: ${options.versionName ?? 'ฉบับล่าสุด'} | โปรไฟล์: ${report.profileName} | Hard Violations: ${report.hardCount} | ความครบชั่วโมง: ${summary.scheduleCompleteness.completenessPct}% | Fitness: ${report.fitness}`,
      );
    doc.moveDown(0.5);

    const cols = [
      { label: 'วัน/เวลา', w: 155 },
      { label: 'กลุ่มเรียน', w: 95 },
      { label: 'รายวิชา', w: 195 },
      { label: 'ครูผู้สอน', w: 135 },
      { label: 'ห้อง', w: 60 },
      { label: 'หมายเหตุ XAI', w: 135 },
    ];
    const startX = 32;
    let y = doc.y;

    const drawHeader = () => {
      doc.rect(startX, y, 775, 22).fill('#1E3A8A');
      let x = startX + 4;
      doc.fillColor('#FFFFFF').font(headFont).fontSize(9.5);
      for (const c of cols) {
        doc.text(c.label, x, y + 5, { width: c.w - 6, lineBreak: false });
        x += c.w;
      }
      y += 24;
      doc.fillColor('#111827').font(bodyFont).fontSize(8.5);
    };

    drawHeader();

    const maxRows = Math.min(rows.length, 450);
    for (let i = 0; i < maxRows; i++) {
      const r = rows[i]!;
      if (y > 530) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 });
        y = 36;
        drawHeader();
      }
      if (i % 2 === 1) {
        doc.rect(startX, y, 775, 18).fill('#F8FAFC');
        doc.fillColor('#111827');
      }
      let x = startX + 4;
      const values = [
        r.timeText,
        `${r.groupCodes}${r.subgroupLabel !== 'ทั้งกลุ่ม' ? ` (${r.subgroupLabel})` : ''}`,
        `${r.subjectCode} ${r.subjectName}`,
        r.teachers,
        r.roomCode,
        r.xaiSummary,
      ];
      for (let c = 0; c < cols.length; c++) {
        doc.text(values[c]!, x, y + 3, { width: cols[c]!.w - 6, height: 14, ellipsis: true });
        x += cols[c]!.w;
      }
      y += 18;
    }

    if (rows.length > maxRows) {
      doc.moveDown(0.5).font(bodyFont).fontSize(9).text(`... แสดง ${maxRows} จากทั้งหมด ${rows.length} รายการ (ส่งออก Excel/CSV เพื่อดูครบทั้งหมด)`);
    }

    doc.end();
  });
}
