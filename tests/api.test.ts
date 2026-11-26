import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEvaluationContext, type ScenarioDataset } from '../packages/shared/src';
import { createApp } from '../apps/server/src/app';
import { runAgenticPipeline } from '../apps/server/src/engine';
import { exportTimetableCsv } from '../apps/server/src/services/export/csv';
import { exportTimetableExcel } from '../apps/server/src/services/export/excel';
import { exportTimetablePdf } from '../apps/server/src/services/export/pdf';
import {
  buildSlotOccupancyRows,
  prepareScheduleVersionPersistence,
} from '../apps/server/src/services/occupancy.service';

function loadQ01(): ScenarioDataset {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), 'scenarios', 'Q01.json'), 'utf8')) as ScenarioDataset;
}

describe('Phase 5 — Exports, Slot Occupancy Builder & Express REST API', () => {
  it('builds clash-free slot_occupancy rows and exports valid CSV, Excel, and Sarabun PDF', async () => {
    const q01 = loadQ01();
    const baseCtx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
    const run = runAgenticPipeline({ ctx: baseCtx, algorithm: 'csp_ga', seed: 42, maxIterations: 8 });
    const ctx = { ...baseCtx, items: run.items, itemTeachers: run.itemTeachers };

    const occRows = buildSlotOccupancyRows('v-export-test', ctx, run.items, run.itemTeachers);
    expect(occRows.length).toBeGreaterThan(0);
    const uniqueCells = new Set(occRows.map((r) => `${r.dayOfWeek}|${r.period}|${r.resourceType}|${r.resourceId}`));
    expect(uniqueCells.size).toBe(occRows.length);

    const csvBuf = exportTimetableCsv(ctx);
    const csvStr = csvBuf.toString('utf8');
    expect(csvStr.startsWith('\uFEFF')).toBe(true);
    expect(csvStr).toContain('กลุ่มเรียน');

    const xlsxBuf = await exportTimetableExcel(ctx, { versionName: 'Q01 Export Test' });
    expect(xlsxBuf.length).toBeGreaterThan(2000);
    expect(xlsxBuf.subarray(0, 2).toString('utf8')).toBe('PK'); // ZIP / XLSX signature

    const pdfBuf = await exportTimetablePdf(ctx, { versionName: 'Q01 PDF Test' });
    expect(pdfBuf.length).toBeGreaterThan(5000);
    expect(pdfBuf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('serves auth/me, import/templates, and import/preview endpoints cleanly via Express', async () => {
    const app = createApp();
    const server = app.listen(0);
    try {
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}/api`;

      const meRes = await fetch(`${base}/auth/me`);
      expect(meRes.status).toBe(200);
      const meJson = (await meRes.json()) as { publicDemoMode: boolean; user: { role: string } | null };
      expect(meJson.publicDemoMode).toBe(true);
      expect(meJson.user?.role).toBe('admin');

      const tplRes = await fetch(`${base}/import/templates`);
      expect(tplRes.status).toBe(200);
      const tplJson = (await tplRes.json()) as { files: Record<string, string> };
      expect(Object.keys(tplJson.files).length).toBe(7);

      const prevRes = await fetch(`${base}/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: tplJson.files }),
      });
      expect(prevRes.status).toBe(200);
      const prevJson = (await prevRes.json()) as { validation: { valid: boolean; stats: { errorCount: number } } };
      expect(prevJson.validation.valid).toBe(true);
      expect(prevJson.validation.stats.errorCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('remaps long solver item IDs to <=36-char UUIDs across versions, teachers, occupancy, and timestamps', () => {
    const q01 = loadQ01();
    const baseCtx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
    const run = runAgenticPipeline({ ctx: baseCtx, algorithm: 'csp_ga', seed: 42, maxIterations: 8 });
    expect(run.items.length).toBeGreaterThan(0);

    const syntheticLongItems = run.items.map((item, idx) =>
      idx === 0
        ? {
            ...item,
            id: `item:task:${'a1b2c3d4-e5f6-7890-abcd-ef1234567890'}:0:${'b1b2c3d4-e5f6-7890-abcd-ef1234567890'}`,
          }
        : item,
    );
    const firstOldId = run.items[0]!.id;
    const syntheticTeachers = run.itemTeachers.map((it) =>
      it.itemId === firstOldId ? { ...it, itemId: syntheticLongItems[0]!.id } : it,
    );

    const prep1 = prepareScheduleVersionPersistence({
      version: {
        id: 'ver:test:1',
        termId: baseCtx.term.id,
        name: 'Test V1',
        source: 'run',
        status: 'published',
        parentVersionId: null,
        createdBy: null,
        createdAt: null,
      },
      ctx: baseCtx,
      items: syntheticLongItems,
      itemTeachers: syntheticTeachers,
    });
    const prep2 = prepareScheduleVersionPersistence({
      version: {
        id: 'ver:test:2',
        termId: baseCtx.term.id,
        name: 'Test V2',
        source: 'run',
        status: 'published',
        parentVersionId: null,
        createdBy: null,
        createdAt: null,
      },
      ctx: baseCtx,
      items: syntheticLongItems,
      itemTeachers: syntheticTeachers,
    });

    const ids1 = new Set(prep1.items.map((i) => i.id));
    const ids2 = new Set(prep2.items.map((i) => i.id));
    expect(ids1.size).toBe(prep1.items.length);
    for (const item of prep1.items) {
      expect(item.id.length).toBeLessThanOrEqual(36);
      expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(ids2.has(item.id)).toBe(false);
    }
    expect(prep1.version.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(prep1.itemTeachers.length).toBe(syntheticTeachers.length);
    for (const it of prep1.itemTeachers) {
      expect(ids1.has(it.itemId)).toBe(true);
    }
    expect(prep1.occRows.length).toBeGreaterThan(0);
    for (const occ of prep1.occRows) {
      expect(ids1.has(occ.itemId)).toBe(true);
    }
  });
});
