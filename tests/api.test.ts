import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationContext,
  evaluateSchedule,
  type ScenarioDataset,
  type XaiExplanationEntry,
} from '../packages/shared/src';
import { createApp } from '../apps/server/src/app';
import { runAgenticPipeline } from '../apps/server/src/engine';
import { exportTimetableCsv } from '../apps/server/src/services/export/csv';
import { exportTimetableExcel } from '../apps/server/src/services/export/excel';
import { exportTimetablePdf } from '../apps/server/src/services/export/pdf';
import {
  buildSlotOccupancyRows,
  prepareScheduleVersionPersistence,
} from '../apps/server/src/services/occupancy.service';
import {
  evaluateWorkspaceCached,
  invalidateWorkspaceCache,
} from '../apps/server/src/services/schedule-loader.service';

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

  it('compacts persisted XAI to failing entries only (max 5) or null', () => {
    const q01 = loadQ01();
    const baseCtx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
    const run = runAgenticPipeline({ ctx: baseCtx, algorithm: 'greedy', seed: 7, maxIterations: 2 });
    expect(run.items.length).toBeGreaterThanOrEqual(3);

    const entry = (code: string, passed: boolean): XaiExplanationEntry =>
      ({ code, passed, messageTh: `${code}:${passed}` }) as unknown as XaiExplanationEntry;
    const mixed = [
      entry('H01', true),
      entry('H02', false),
      entry('H03', true),
      ...['H04', 'H05', 'H06', 'H07', 'H09', 'H10'].map((c) => entry(c, false)),
    ];
    const items = run.items.slice(0, 3).map((item, idx) => ({
      ...item,
      explanation: idx === 0 ? mixed : idx === 1 ? [entry('H01', true), entry('H02', true)] : null,
    }));
    const itemIds = new Set(items.map((i) => i.id));

    const prep = prepareScheduleVersionPersistence({
      version: {
        id: 'ver:xai:compact',
        termId: baseCtx.term.id,
        name: 'XAI compact',
        source: 'run',
        status: 'draft',
        parentVersionId: null,
        createdBy: null,
        createdAt: null,
      },
      ctx: baseCtx,
      items,
      itemTeachers: run.itemTeachers.filter((it) => itemIds.has(it.itemId)),
    });

    const first = prep.items[0]!.explanation!;
    expect(first).toHaveLength(5);
    expect(first.every((e) => !e.passed)).toBe(true);
    expect(first.map((e) => e.code)).toEqual(['H02', 'H04', 'H05', 'H06', 'H07']);
    expect(prep.items[1]!.explanation).toBeNull(); // all passed -> null
    expect(prep.items[2]!.explanation).toBeNull(); // none -> null
    // Inputs are not mutated.
    expect(items[0]!.explanation).toHaveLength(mixed.length);
  });

  it('exports invalidateWorkspaceCache and evaluates non-DB contexts fresh via evaluateWorkspaceCached', () => {
    expect(typeof invalidateWorkspaceCache).toBe('function');
    expect(() => invalidateWorkspaceCache()).not.toThrow();

    const q01 = loadQ01();
    const baseCtx = createEvaluationContext({ ...q01.tables, constraint_configs: [] }, { profileName: 'competition' });
    const run = runAgenticPipeline({ ctx: baseCtx, algorithm: 'greedy', seed: 7, maxIterations: 2 });
    const ctx = { ...baseCtx, items: run.items, itemTeachers: run.itemTeachers };

    const cached = evaluateWorkspaceCached(ctx, { includePassedExplanations: false });
    const direct = evaluateSchedule(ctx, { includePassedExplanations: false });
    expect(cached.report.hardCount).toBe(direct.hardCount);
    expect(cached.report.totalPenalty).toBe(direct.totalPenalty);
    expect(cached.qualitySummary.profileName).toBe('competition');

    // Locally mutated contexts must never be served a stale cached report.
    const mutated = { ...ctx, items: ctx.items.slice(1) };
    const again = evaluateWorkspaceCached(mutated, { includePassedExplanations: false });
    expect(again.report).not.toBe(cached.report);
  });

  it('GET /schedule/:versionId/items/:itemId/explain returns 404 for unknown version/item', async (testCtx) => {
    const app = createApp();
    const server = app.listen(0);
    try {
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}/api`;
      const health = await fetch(`${base}/health`).catch(() => null);
      if (!health || health.status !== 200) {
        testCtx.skip(); // DB not reachable from this environment
        return;
      }

      const unknownVersion = await fetch(`${base}/schedule/ver-does-not-exist/items/item-does-not-exist/explain`);
      expect(unknownVersion.status).toBe(404);

      const unknownItem = await fetch(`${base}/schedule/latest/items/item-does-not-exist/explain?profile=competition`);
      expect(unknownItem.status).toBe(404);
      const body = (await unknownItem.json()) as { error: string };
      expect(body.error).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
