import { readFile } from 'node:fs/promises';
import { Router, type Request, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import {
  BUILT_IN_PROFILES,
  CONSTRAINT_CATALOG,
  buildQualitySummary4D,
  evaluateSchedule,
  getProfileConfigs,
  type ChallengeRule,
  type Dataset7ColumnMappingOverrides,
  type Dataset7Files,
  type IssueReport,
  type ScenarioDataset,
  type ScheduleEvaluationContext,
  type ScheduleVersion,
  type SchedulingAlgorithm,
  type SchedulingRun,
} from '@ptc/shared';
import { db, pool, testConnection } from '../db/client';
import { resolveProjectFile } from '../db/env';
import { scenarioToDataset7Files } from '../db/scenario-builder';
import {
  accounts,
  auditLogs,
  challengeRules,
  importJobs,
  issueReports,
  scheduleExceptions,
  scheduleVersions,
  schedulingRuns,
} from '../db/schema';
import { seedScenarioIntoDb, type SeedScenarioCode } from '../db/seed';
import {
  diffScheduleVersions,
  evaluateChallengeImpact,
  proposeEmergencyFix,
  proposeFixOptions,
  runAgenticPipeline,
  runRepair,
} from '../engine';
import { verifyPassword } from '../lib/password';
import { isPublicDemoMode, signAuthToken } from '../middleware/auth';
import { exportCompetitionOutputCsv, exportTimetableCsv } from '../services/export/csv';
import { exportTimetableExcel } from '../services/export/excel';
import { exportTimetablePdf } from '../services/export/pdf';
import type { ExportViewMode } from '../services/export/shared';
import { DEFAULT_COLUMN_MAPPING, parseDataset7, validateDataset7 } from '../services/import';
import { saveScheduleVersionAtomic, updateScheduleItemsAtomic } from '../services/occupancy.service';
import { getItemHistory, getStaffProfile, saveStaffProfile } from '../services/staff-profile.service';
import { registerWeeklyRoutes } from './weekly';
import {
  commitDataset7ToDb,
  evaluateWorkspaceCached,
  invalidateWorkspaceCache,
  loadContextFromDb,
} from '../services/schedule-loader.service';
import { SCENARIOS_CATALOG_25 } from '../data/scenarios-catalog';

function strParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Same timestamp/date normalisation as `schedule-loader.service`. */
function toTimestampStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  return String(v);
}

function toDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v == null ? '' : String(v);
}

/**
 * Slim `context` payload for schedule views: no per-item XAI (fetch on demand via
 * `/items/:itemId/explain`), no encrypted phones, no `students`.
 */
function serializeScheduleContext(ctx: ScheduleEvaluationContext) {
  return {
    term: ctx.term,
    timeSlots: ctx.timeSlots,
    departments: ctx.departments,
    buildings: ctx.buildings,
    roomTypes: ctx.roomTypes,
    rooms: ctx.rooms,
    staff: ctx.staff.map((s) => ({ ...s, phoneEncrypted: null })),
    studentGroups: ctx.studentGroups,
    subgroups: ctx.subgroups,
    subjects: ctx.subjects,
    offerings: ctx.offerings,
    offeringGroups: ctx.offeringGroups,
    offeringTeachers: [],
    eligibilities: [],
    fixedBlocks: ctx.fixedBlocks,
    items: ctx.items.map((i) => ({ ...i, explanation: null })),
    itemTeachers: ctx.itemTeachers,
  };
}

function serializeScheduleReport(
  report: ReturnType<typeof evaluateWorkspaceCached>['report'],
  fullXai: boolean,
) {
  if (fullXai) return report;
  const hardItemIds = new Set<string>();
  for (const v of report.hardViolations) {
    for (const id of v.itemIds) hardItemIds.add(id);
  }
  const compactExplanations: typeof report.itemExplanations = {};
  for (const id of hardItemIds) {
    if (report.itemExplanations[id]) compactExplanations[id] = report.itemExplanations[id];
  }
  return {
    ...report,
    softPenalties: report.softPenalties.map((s) => ({ ...s, details: [] })),
    itemExplanations: compactExplanations,
  };
}

function parseTimestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const RunSchema = z.object({
  algorithm: z.enum(['greedy', 'csp_ga', 'csp_sa', 'cpsat']).default('csp_ga'),
  profileName: z.string().default('competition'),
  seed: z.coerce.number().int().default(2026),
  maxIterations: z.coerce.number().int().min(1).max(200).default(16),
  timeLimitSec: z.coerce.number().int().min(2).max(180).default(45),
  scenarioCode: z.string().nullable().optional(),
  versionName: z.string().optional(),
});

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const MoveItemSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7).nullable().optional(),
  startPeriod: z.number().int().min(1).max(12).nullable().optional(),
  roomId: z.string().nullable().optional(),
  isLocked: z.boolean().optional(),
  status: z.enum(['scheduled', 'unplaced_tray']).optional(),
  teacherIds: z.array(z.string()).optional(),
});

const ChallengeRuleSchema = z.object({
  category: z.enum(['time', 'room', 'subject', 'teacher']),
  ruleType: z.string().min(1),
  target: z.record(z.string(), z.unknown()).default({ all: true }),
  params: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(['hard', 'soft']).default('hard'),
  description: z.string().default(''),
});

const IssueSchema = z.object({
  category: z.enum(['teacher_leave', 'room_outage', 'schedule_conflict', 'system_bug']),
  affectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  affectedStaffId: z.string().nullable().optional(),
  affectedRoomId: z.string().nullable().optional(),
  description: z.string().default(''),
});

const BenchmarkSchema = z.object({
  algorithms: z.array(z.enum(['greedy', 'csp_ga', 'csp_sa'])).default(['greedy', 'csp_ga', 'csp_sa']),
  profiles: z.array(z.string()).default(['competition', 'teacher_first', 'room_first']),
  seeds: z.array(z.number().int()).default([101, 202, 303]),
  maxIterations: z.number().int().min(2).max(50).default(10),
  timeLimitSec: z.coerce.number().int().min(2).max(30).default(10),
});

function summarizeStd(nums: number[]): { mean: number; sd: number } {
  if (nums.length === 0) return { mean: 0, sd: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length;
  return {
    mean: Math.round(mean * 100) / 100,
    sd: Math.round(Math.sqrt(variance) * 100) / 100,
  };
}

export function createApiRouter(): Router {
  const router = Router();

  // ---- Health & Auth -------------------------------------------------------
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const dbInfo = await testConnection();
      res.json({
        ok: true,
        app: 'PTC Smart Schedule V4',
        database: dbInfo.database,
        dbVersion: dbInfo.version,
        tableCount: dbInfo.tableCount,
        publicDemoMode: isPublicDemoMode(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/auth/me', (req: Request, res: Response) => {
    res.json({ user: req.user ?? null, publicDemoMode: isPublicDemoMode() });
  });

  router.post('/auth/login', async (req: Request, res: Response) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid credentials payload', issues: parsed.error.issues });
      return;
    }
    const { username, password } = parsed.data;
    const found = await db.select().from(accounts).where(eq(accounts.username, username)).limit(1);
    const acc = found[0];
    if (!acc || !verifyPassword(password, acc.passwordHash)) {
      res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
      return;
    }
    const userPayload = {
      accountId: acc.id,
      username: acc.username,
      role: acc.role,
      staffId: acc.staffId,
      studentId: acc.studentId,
    };
    const token = signAuthToken(userPayload);
    res.json({ token, user: { ...userPayload, isPublicGuest: false } });
  });

  // ---- Dashboard & Reference Catalog --------------------------------------
  router.get('/dashboard', async (req: Request, res: Response) => {
    const profileName = strParam(req.query.profile as string | undefined) || 'competition';
    const ws = await loadContextFromDb({ profileName });
    const { report, qualitySummary: summary } = evaluateWorkspaceCached(ws.ctx, { includePassedExplanations: false });
    res.json({
      term: ws.ctx.term,
      activeVersion: ws.activeVersion,
      versionsCount: ws.versions.length,
      runsCount: ws.runs.length,
      latestRun: ws.runs[0] ?? null,
      counts: {
        departments: ws.ctx.departments.length,
        groups: ws.ctx.studentGroups.length,
        staff: ws.ctx.staff.length,
        rooms: ws.ctx.rooms.length,
        subjects: ws.ctx.subjects.length,
        offerings: ws.ctx.offerings.length,
        scheduledItems: ws.ctx.items.filter((i) => i.status === 'scheduled').length,
        unplacedItems: ws.ctx.items.filter((i) => i.status === 'unplaced_tray').length,
      },
      report: {
        profileName: report.profileName,
        hardCount: report.hardCount,
        totalPenalty: report.totalPenalty,
        fitness: report.fitness,
        multiObjective: report.multiObjective,
      },
      qualitySummary: summary,
      catalog: CONSTRAINT_CATALOG,
      profiles: BUILT_IN_PROFILES,
    });
  });

  // ---- Scenarios (Q01–Q25 catalog + 1-click load Q01/Q21) ------------------
  router.get('/scenarios', async (_req: Request, res: Response) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM departments) AS departments,
         (SELECT COUNT(*) FROM student_groups) AS student_groups,
         (SELECT COUNT(*) FROM staff) AS staff,
         (SELECT COUNT(*) FROM rooms) AS rooms,
         (SELECT COUNT(*) FROM subjects) AS subjects,
         (SELECT COUNT(*) FROM course_offerings) AS course_offerings`,
    );
    const c = rows[0] ?? {};
    res.json({
      scenarios: SCENARIOS_CATALOG_25,
      currentCounts: {
        departments: Number(c.departments ?? 0),
        groups: Number(c.student_groups ?? 0),
        staff: Number(c.staff ?? 0),
        rooms: Number(c.rooms ?? 0),
        offerings: Number(c.course_offerings ?? 0),
      },
    });
  });

  router.post('/scenarios/:code/load', async (req: Request, res: Response) => {
    const rawCode = strParam(req.params.code).toUpperCase();
    const item = SCENARIOS_CATALOG_25.find((s) => s.code === rawCode);
    const target: SeedScenarioCode = rawCode === 'Q21' ? 'Q21' : item?.loadableDataset ?? 'Q01';
    const seeded = await seedScenarioIntoDb(target);
    invalidateWorkspaceCache();
    const autoRun = req.body?.autoRun === true;
    let runResult = null;
    if (autoRun) {
      const ws = await loadContextFromDb({ profileName: String(req.body?.profileName ?? 'competition') });
      const pipe = runAgenticPipeline({
        ctx: ws.ctx,
        algorithm: 'csp_ga',
        seed: Number(req.body?.seed ?? 2026),
        maxIterations: target === 'Q21' ? 6 : 12,
        timeLimitSec: 40,
        versionId: `ver:${target}:${Date.now()}`,
      });
      await saveScheduleVersionAtomic({
        version: {
          id: pipe.versionId,
          termId: ws.ctx.term.id,
          name: `${target}_auto_${new Date().toISOString().slice(11, 19)}`,
          source: 'run',
          status: 'published',
          parentVersionId: null,
          createdBy: req.user?.accountId ?? null,
          createdAt: parseTimestamp(),
        },
        ctx: ws.ctx,
        items: pipe.items,
        itemTeachers: pipe.itemTeachers,
        auditAccountId: req.user?.accountId ?? null,
      });
      await db.insert(schedulingRuns).values({
        id: `run:${Date.now()}`,
        termId: ws.ctx.term.id,
        scenarioCode: rawCode,
        algorithm: pipe.algorithm,
        profileName: pipe.report.profileName,
        seed: pipe.seed,
        maxIterations: target === 'Q21' ? 6 : 12,
        timeLimitSec: 40,
        status: 'done',
        progressPct: 100,
        startedAt: parseTimestamp(),
        finishedAt: parseTimestamp(),
        durationMs: pipe.durationMs,
        hardViolations: pipe.report.hardCount,
        softScore: pipe.report.totalPenalty.toFixed(2),
        fitness: pipe.report.fitness.toFixed(4),
        unplacedCount: pipe.qualitySummary.scheduleCompleteness.unplacedCount,
        metrics: pipe.report.multiObjective as unknown as Record<string, unknown>,
        agentLog: pipe.agentLog,
        versionId: pipe.versionId,
      } as never);
      invalidateWorkspaceCache();
      runResult = { versionId: pipe.versionId, report: pipe.report, qualitySummary: pipe.qualitySummary };
    }
    res.json({
      ok: true,
      requestedCode: rawCode,
      loadedDataset: target,
      totalRows: seeded.totalRows,
      durationMs: seeded.durationMs,
      runResult,
    });
  });

  // ---- Data Import & Data Check --------------------------------------------
  router.get('/import/templates', async (_req: Request, res: Response) => {
    const file = resolveProjectFile('scenarios', 'Q01.json');
    const q01 = JSON.parse(await readFile(file, 'utf8')) as ScenarioDataset;
    const csvFiles = scenarioToDataset7Files(q01);
    res.json({
      files: csvFiles,
      defaultMapping: DEFAULT_COLUMN_MAPPING,
    });
  });

  router.post('/import/preview', (req: Request, res: Response) => {
    const files = (req.body?.files ?? {}) as Dataset7Files;
    const mapping = req.body?.mapping as Dataset7ColumnMappingOverrides | undefined;
    const bundle = parseDataset7(files, mapping);
    const validation = validateDataset7(bundle);
    res.json({ validation, defaultMapping: DEFAULT_COLUMN_MAPPING });
  });

  router.post('/import/commit', async (req: Request, res: Response) => {
    const files = (req.body?.files ?? {}) as Dataset7Files;
    const mapping = req.body?.mapping as Dataset7ColumnMappingOverrides | undefined;
    const bundle = parseDataset7(files, mapping);
    const validation = validateDataset7(bundle);
    if (!validation.valid && !req.body?.force) {
      res.status(400).json({ error: 'พบข้อผิดพลาดในข้อมูล กรุณาแก้ไขก่อนนำเข้า', validation });
      return;
    }
    const committed = await commitDataset7ToDb({
      bundle,
      fileName: String(req.body?.fileName ?? 'dataset7.zip'),
      issues: validation.issues,
      stats: validation.stats,
      createdBy: req.user?.accountId ?? null,
    });
    res.json({ ok: true, ...committed, validation });
  });

  // ---- Solver Runs & Agentic Pipeline --------------------------------------
  router.get('/runs', async (_req: Request, res: Response) => {
    const rows = await db.select().from(schedulingRuns).orderBy(desc(schedulingRuns.startedAt)).limit(50);
    const runs: SchedulingRun[] = rows.map((r) => ({
      ...r,
      softScore: r.softScore != null ? Number(r.softScore) : null,
      fitness: r.fitness != null ? Number(r.fitness) : null,
      startedAt: toTimestampStr(r.startedAt),
      finishedAt: toTimestampStr(r.finishedAt),
    }));
    res.json({ runs, profiles: BUILT_IN_PROFILES, catalog: getProfileConfigs('competition') });
  });

  router.post('/runs', async (req: Request, res: Response) => {
    const parsed = RunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'พารามิเตอร์ไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const opts = parsed.data;
    const ws = await loadContextFromDb({ profileName: opts.profileName });
    const runId = `run:${Date.now()}`;
    const versionId = `ver:${Date.now()}`;
    const pipe = runAgenticPipeline({
      ctx: ws.ctx,
      algorithm: opts.algorithm as SchedulingAlgorithm,
      seed: opts.seed,
      maxIterations: opts.maxIterations,
      timeLimitSec: opts.timeLimitSec,
      versionId,
    });

    const versionName =
      opts.versionName?.trim() || `${opts.algorithm.toUpperCase()} (${opts.profileName}) #${opts.seed}`;

    await saveScheduleVersionAtomic({
      version: {
        id: versionId,
        termId: ws.ctx.term.id,
        name: versionName,
        source: 'run',
        status: pipe.report.hardCount === 0 ? 'published' : 'draft',
        parentVersionId: ws.activeVersion?.id ?? null,
        createdBy: req.user?.accountId ?? null,
        createdAt: parseTimestamp(),
      },
      ctx: ws.ctx,
      items: pipe.items,
      itemTeachers: pipe.itemTeachers,
      auditAccountId: req.user?.accountId ?? null,
    });

    const runRow = {
      id: runId,
      termId: ws.ctx.term.id,
      scenarioCode: opts.scenarioCode ?? null,
      algorithm: pipe.algorithm,
      profileName: pipe.report.profileName,
      seed: pipe.seed,
      maxIterations: opts.maxIterations,
      timeLimitSec: opts.timeLimitSec,
      status: 'done' as const,
      progressPct: 100,
      startedAt: parseTimestamp(new Date(Date.now() - pipe.durationMs)),
      finishedAt: parseTimestamp(),
      durationMs: pipe.durationMs,
      hardViolations: pipe.report.hardCount,
      softScore: pipe.report.totalPenalty.toFixed(2),
      fitness: pipe.report.fitness.toFixed(4),
      unplacedCount: pipe.qualitySummary.scheduleCompleteness.unplacedCount,
      metrics: pipe.report.multiObjective as unknown as Record<string, unknown>,
      agentLog: pipe.agentLog,
      versionId,
    };
    await db.insert(schedulingRuns).values(runRow as never);
    invalidateWorkspaceCache();

    res.json({
      run: runRow,
      versionId,
      versionName,
      report: pipe.report,
      qualitySummary: pipe.qualitySummary,
      agentLog: pipe.agentLog,
    });
  });

  // ---- Schedule Workspace & Views ------------------------------------------
  router.get('/schedule/latest', async (req: Request, res: Response) => {
    const profileName = strParam(req.query.profile as string | undefined) || 'competition';
    const fullXai = req.query.fullXai === 'true';
    const ws = await loadContextFromDb({ profileName });
    const { report, qualitySummary } = evaluateWorkspaceCached(ws.ctx, {
      includePassedExplanations: fullXai,
    });
    res.json({
      version: ws.activeVersion,
      versions: ws.versions,
      context: serializeScheduleContext(ws.ctx),
      report: serializeScheduleReport(report, fullXai),
      qualitySummary,
    });
  });

  // On-demand full XAI (passed + failed checks) for a single item.
  router.get('/schedule/:versionId/items/:itemId/explain', async (req: Request, res: Response) => {
    const versionId = strParam(req.params.versionId);
    const itemId = strParam(req.params.itemId);
    const profileName = strParam(req.query.profile as string | undefined) || 'competition';
    const isLatest = versionId === 'latest';
    const ws = await loadContextFromDb({ versionId: isLatest ? undefined : versionId, profileName });
    const versionMatches = isLatest || ws.activeVersion?.id === versionId;
    if (!versionMatches || !ws.ctx.items.some((i) => i.id === itemId)) {
      res.status(404).json({ error: 'ไม่พบคาบเรียนที่ระบุในตารางสอนนี้' });
      return;
    }
    const { report } = evaluateWorkspaceCached(ws.ctx, { includePassedExplanations: true });
    res.json({ itemId, explanations: report.itemExplanations[itemId] ?? [] });
  });

  router.get('/schedule/:versionId', async (req: Request, res: Response) => {
    const versionId = strParam(req.params.versionId);
    const profileName = strParam(req.query.profile as string | undefined) || 'competition';
    const fullXai = req.query.fullXai === 'true';
    const ws = await loadContextFromDb({ versionId, profileName });
    if (!ws.activeVersion || ws.activeVersion.id !== versionId) {
      res.status(404).json({ error: 'ไม่พบเวอร์ชันตารางสอนที่ระบุ' });
      return;
    }
    const { report, qualitySummary } = evaluateWorkspaceCached(ws.ctx, {
      includePassedExplanations: fullXai,
    });
    res.json({
      version: ws.activeVersion,
      versions: ws.versions,
      context: serializeScheduleContext(ws.ctx),
      report: serializeScheduleReport(report, fullXai),
      qualitySummary,
    });
  });

  /** Apply item patches in one transaction; DB `uq_no_clash` turns any clash into HTTP 409. */
  const applyItemChanges = async (
    req: Request,
    res: Response,
    versionId: string,
    changes: Array<{ itemId: string; patch: z.infer<typeof MoveItemSchema> }>,
  ) => {
    const ws = await loadContextFromDb({ versionId });
    try {
      // No re-evaluation here: the editor updates optimistically; scores refresh on the next schedule load.
      const items = await updateScheduleItemsAtomic({ versionId, ctx: ws.ctx, changes, updatedBy: req.user?.accountId ?? null });
      res.json({ item: items[0], items });
    } catch (err) {
      const causeMsg = (err as { cause?: { message?: string } } | null)?.cause?.message ?? '';
      const msg = causeMsg || (err instanceof Error ? err.message : String(err));
      const isClash = msg.includes('uq_no_clash') || msg.includes('Duplicate entry');
      res.status(isClash ? 409 : 400).json({
        error: isClash ? 'ย้ายไม่ได้: ตารางจะชนกัน (ครู ห้อง หรือกลุ่มเรียนซ้อนคาบ)' : msg.slice(0, 300),
      });
    }
  };

  router.patch('/schedule/:versionId/items/:itemId', async (req: Request, res: Response) => {
    const parsed = MoveItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลการย้ายคาบไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    await applyItemChanges(req, res, strParam(req.params.versionId), [{ itemId: strParam(req.params.itemId), patch: parsed.data }]);
  });

  // Move/swap/undo several items atomically: { changes: [{ itemId, dayOfWeek, startPeriod, status, ... }] }
  router.post('/schedule/:versionId/items-batch', async (req: Request, res: Response) => {
    const parsed = z
      .object({ changes: z.array(MoveItemSchema.extend({ itemId: z.string().min(1) })).min(1).max(20) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลการย้ายคาบไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const changes = parsed.data.changes.map(({ itemId, ...patch }) => ({ itemId, patch }));
    await applyItemChanges(req, res, strParam(req.params.versionId), changes);
  });

  router.post('/schedule/:versionId/items/:itemId/fix-options', async (req: Request, res: Response) => {
    const versionId = strParam(req.params.versionId);
    const itemId = strParam(req.params.itemId);
    const profileName = String(req.body?.profileName ?? 'competition');
    const ws = await loadContextFromDb({ versionId, profileName });
    const options = proposeFixOptions(ws.ctx, itemId);
    res.json({ options });
  });

  // ---- Lucky Challenge Lab -------------------------------------------------
  router.get('/challenge/rules', async (_req: Request, res: Response) => {
    const rows = await db.select().from(challengeRules).orderBy(desc(challengeRules.createdAt));
    const rules: ChallengeRule[] = rows.map((r) => ({ ...r, createdAt: toTimestampStr(r.createdAt) }));
    res.json({ rules });
  });

  router.post('/challenge/rules', async (req: Request, res: Response) => {
    const parsed = ChallengeRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'รูปแบบเงื่อนไข Lucky Challenge ไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const ws = await loadContextFromDb();
    const rule: ChallengeRule = {
      id: `ch:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      termId: ws.ctx.term.id,
      category: parsed.data.category,
      ruleType: parsed.data.ruleType,
      target: parsed.data.target,
      params: parsed.data.params,
      mode: parsed.data.mode,
      description: parsed.data.description,
      isActive: true,
      createdAt: parseTimestamp(),
    };
    await db.insert(challengeRules).values(rule as never);
    invalidateWorkspaceCache();
    res.json({ rule });
  });

  router.delete('/challenge/rules/:id', async (req: Request, res: Response) => {
    const id = strParam(req.params.id);
    await db.delete(challengeRules).where(eq(challengeRules.id, id));
    invalidateWorkspaceCache();
    res.json({ ok: true });
  });

  router.post('/challenge/evaluate', async (req: Request, res: Response) => {
    const profileName = String(req.body?.profileName ?? 'competition');
    const ws = await loadContextFromDb({ versionId: req.body?.versionId, profileName });
    const impact = evaluateChallengeImpact(ws.ctx, ws.challengeRules);
    res.json({
      violationCount: impact.violationCount,
      violatedItemIds: impact.violatedItemIds,
      affectedGroupIds: impact.affectedGroupIds,
      affectedStaffIds: impact.affectedStaffIds,
      hardViolations: impact.report.hardViolations,
      hardCountsByCode: impact.report.hardCountsByCode,
    });
  });

  router.post('/challenge/apply', async (req: Request, res: Response) => {
    const profileName = String(req.body?.profileName ?? 'competition');
    const mode = req.body?.strategy === 'full_resolve' ? 'full_resolve' : 'repair';
    const ws = await loadContextFromDb({ versionId: req.body?.versionId, profileName });
    const impact = evaluateChallengeImpact(ws.ctx, ws.challengeRules);

    const newVersionId = `ver:ch:${Date.now()}`;
    let newItems;
    let newItemTeachers;
    let afterReport;
    let afterSummary;

    if (mode === 'full_resolve') {
      const pipe = runAgenticPipeline({
        ctx: { ...impact.modifiedCtx, items: [], itemTeachers: [] },
        algorithm: 'csp_ga',
        seed: Number(req.body?.seed ?? 2026),
        maxIterations: 12,
        versionId: newVersionId,
      });
      newItems = pipe.items;
      newItemTeachers = pipe.itemTeachers;
      afterReport = pipe.report;
      afterSummary = pipe.qualitySummary;
    } else {
      const repaired = runRepair(impact.modifiedCtx, {
        seed: Number(req.body?.seed ?? 2026),
        versionId: newVersionId,
        timeLimitMs: 20_000,
      });
      newItems = repaired.output.items;
      newItemTeachers = repaired.output.itemTeachers;
      afterReport = evaluateSchedule(
        { ...impact.modifiedCtx, items: newItems, itemTeachers: newItemTeachers },
        { includePassedExplanations: true },
      );
      afterSummary = buildQualitySummary4D(
        { ...impact.modifiedCtx, items: newItems, itemTeachers: newItemTeachers },
        afterReport,
      );
    }

    const itemsWithXai = newItems.map((i) => ({ ...i, explanation: afterReport.itemExplanations[i.id] ?? [] }));

    await saveScheduleVersionAtomic({
      version: {
        id: newVersionId,
        termId: ws.ctx.term.id,
        name: `LuckyChallenge_${new Date().toISOString().slice(11, 19)}`,
        source: mode === 'repair' ? 'repair' : 'run',
        status: afterReport.hardCount === 0 ? 'published' : 'draft',
        parentVersionId: ws.activeVersion?.id ?? null,
        createdBy: req.user?.accountId ?? null,
        createdAt: parseTimestamp(),
      },
      ctx: impact.modifiedCtx,
      items: itemsWithXai,
      itemTeachers: newItemTeachers,
      auditAccountId: req.user?.accountId ?? null,
      auditAction: 'apply_lucky_challenge',
    });
    invalidateWorkspaceCache();

    const afterCtx = { ...impact.modifiedCtx, items: itemsWithXai, itemTeachers: newItemTeachers };
    const diff = diffScheduleVersions(ws.ctx, afterCtx, impact.report, afterReport);

    res.json({
      versionId: newVersionId,
      diff,
      report: afterReport,
      qualitySummary: afterSummary,
    });
  });

  // ---- Emergency Issue Reports (Req 20) ------------------------------------
  router.get('/issues', async (_req: Request, res: Response) => {
    const rows = await db.select().from(issueReports).orderBy(desc(issueReports.createdAt)).limit(100);
    const issues: IssueReport[] = rows.map((i) => ({
      ...i,
      affectedDate: toDateStr(i.affectedDate),
      createdAt: toTimestampStr(i.createdAt),
    }));
    res.json({ issues });
  });

  router.post('/issues', async (req: Request, res: Response) => {
    const parsed = IssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลแจ้งเหตุไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const ws = await loadContextFromDb();
    const issueId = `iss:${Date.now()}`;
    const proposal = proposeEmergencyFix(ws.ctx, {
      id: issueId,
      category: parsed.data.category,
      affectedDate: parsed.data.affectedDate,
      affectedStaffId: parsed.data.affectedStaffId ?? null,
      affectedRoomId: parsed.data.affectedRoomId ?? null,
    });
    const row = {
      id: issueId,
      reporterId: req.user?.accountId ?? 'public-demo',
      category: parsed.data.category,
      affectedDate: parsed.data.affectedDate,
      affectedStaffId: parsed.data.affectedStaffId ?? null,
      affectedRoomId: parsed.data.affectedRoomId ?? null,
      description: parsed.data.description,
      status: 'proposed' as const,
      agentProposal: proposal as unknown as Record<string, unknown>,
    };
    await db.insert(issueReports).values(row as never);
    invalidateWorkspaceCache();
    res.json({ issue: row, proposal });
  });

  router.post('/issues/:id/apply', async (req: Request, res: Response) => {
    const id = strParam(req.params.id);
    const optionIndex = Number(req.body?.optionIndex ?? 0);
    const ws = await loadContextFromDb();
    // Direct lookup: `ws.issues` is capped at the 100 most recent reports.
    const issue =
      ws.issues.find((i) => i.id === id) ??
      (await db
        .select()
        .from(issueReports)
        .where(eq(issueReports.id, id))
        .limit(1)
        .then((rows) =>
          rows[0]
            ? ({ ...rows[0], affectedDate: toDateStr(rows[0].affectedDate), createdAt: toTimestampStr(rows[0].createdAt) } as IssueReport)
            : undefined,
        ));
    if (!issue || !ws.activeVersion) {
      res.status(404).json({ error: 'ไม่พบใบแจ้งเหตุหรือตารางสอนหลัก' });
      return;
    }
    const proposal = (issue.agentProposal ?? {}) as {
      options?: Array<{
        action: 'substitute' | 'room_change' | 'makeup' | 'cancel';
        details: Array<{ itemId: string; substituteStaffId?: string; newRoomId?: string; makeupPeriod?: number }>;
      }>;
    };
    const chosen = proposal.options?.[optionIndex] ?? proposal.options?.[0];
    if (!chosen) {
      res.status(400).json({ error: 'ไม่มีแผนแก้ไขให้เลือก' });
      return;
    }
    await db.transaction(async (tx) => {
      for (const d of chosen.details) {
        await tx.insert(scheduleExceptions).values({
          id: `exc:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
          versionId: ws.activeVersion!.id,
          issueId: issue.id,
          itemId: d.itemId,
          exceptionDate: issue.affectedDate,
          action: chosen.action,
          substituteStaffId: d.substituteStaffId ?? null,
          newRoomId: d.newRoomId ?? null,
          makeupDate: null,
          makeupPeriod: d.makeupPeriod ?? null,
        } as never);
      }
      await tx.update(issueReports).set({ status: 'applied' }).where(eq(issueReports.id, issue.id));
    });
    invalidateWorkspaceCache();
    res.json({ ok: true, appliedCount: chosen.details.length, action: chosen.action });
  });

  // ---- Benchmark (Multi-seed & Multi-Objective Q23/Q25) --------------------
  router.post('/benchmark', async (req: Request, res: Response) => {
    const parsed = BenchmarkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid benchmark params' });
      return;
    }
    const ws = await loadContextFromDb();
    const results: Array<{
      algorithm: string;
      profileName: string;
      runs: Array<{ seed: number; durationMs: number; hardCount: number; penalty: number; fitness: number; teacherSat: number; roomUtil: number }>;
      summary: {
        durationMs: { mean: number; sd: number };
        hardCount: { mean: number; sd: number };
        fitness: { mean: number; sd: number };
        penalty: { mean: number; sd: number };
        teacherSat: number;
        roomUtil: number;
      };
    }> = [];

    for (const profileName of parsed.data.profiles) {
      for (const algorithm of parsed.data.algorithms) {
        const runs = [];
        for (const seed of parsed.data.seeds) {
          const pipe = runAgenticPipeline({
            ctx: { ...ws.ctx, profileName },
            algorithm,
            seed,
            maxIterations: parsed.data.maxIterations,
            timeLimitSec: parsed.data.timeLimitSec,
            versionId: `bench:${algorithm}:${profileName}:${seed}`,
          });
          runs.push({
            seed,
            durationMs: pipe.durationMs,
            hardCount: pipe.report.hardCount,
            penalty: pipe.report.totalPenalty,
            fitness: pipe.report.fitness,
            teacherSat: Math.round(pipe.report.multiObjective.teacherSatisfaction * 100),
            roomUtil: Math.round(pipe.report.multiObjective.roomUtilization * 100),
          });
        }
        results.push({
          algorithm,
          profileName,
          runs,
          summary: {
            durationMs: summarizeStd(runs.map((r) => r.durationMs)),
            hardCount: summarizeStd(runs.map((r) => r.hardCount)),
            fitness: summarizeStd(runs.map((r) => r.fitness)),
            penalty: summarizeStd(runs.map((r) => r.penalty)),
            teacherSat: summarizeStd(runs.map((r) => r.teacherSat)).mean,
            roomUtil: summarizeStd(runs.map((r) => r.roomUtil)).mean,
          },
        });
      }
    }
    res.json({ results });
  });

  // ---- Versions, Export (CSV / Excel / PDF Sarabun) & Audit ----------------
  router.get('/versions', async (_req: Request, res: Response) => {
    const rows = await db.select().from(scheduleVersions).orderBy(desc(scheduleVersions.createdAt)).limit(50);
    const versions: ScheduleVersion[] = rows.map((v) => ({ ...v, createdAt: toTimestampStr(v.createdAt) }));
    res.json({ versions });
  });

  router.post('/versions/:id/publish', async (req: Request, res: Response) => {
    const id = strParam(req.params.id);
    await db.update(scheduleVersions).set({ status: 'published' }).where(eq(scheduleVersions.id, id));
    invalidateWorkspaceCache();
    res.json({ ok: true });
  });

  router.get('/versions/:id/json', async (req: Request, res: Response) => {
    const id = strParam(req.params.id);
    const ws = await loadContextFromDb({ versionId: id });
    res.setHeader('Content-Disposition', `attachment; filename="ptc-schedule-${id}.json"`);
    res.json({ version: ws.activeVersion, items: ws.ctx.items, itemTeachers: ws.ctx.itemTeachers });
  });

  router.get('/export/:versionId/:format', async (req: Request, res: Response) => {
    const versionId = strParam(req.params.versionId);
    const format = strParam(req.params.format).toLowerCase();
    const view = (strParam(req.query.view as string | undefined) || 'master') as ExportViewMode;
    const targetId = strParam(req.query.targetId as string | undefined) || undefined;
    const ws = await loadContextFromDb({ versionId });
    const vName = ws.activeVersion?.name ?? versionId;

    if (format === 'output') {
      const [job] = await db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(1);
      const stats = job?.stats as { timeslotIds?: Record<string, string> } | null | undefined;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="output.csv"');
      res.send(exportCompetitionOutputCsv(ws.ctx, stats?.timeslotIds));
      return;
    }
    if (format === 'csv') {
      const buf = exportTimetableCsv(ws.ctx, { view, targetId });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ptc-timetable-${view}.csv"`);
      res.send(buf);
      return;
    }
    if (format === 'excel' || format === 'xlsx') {
      const buf = await exportTimetableExcel(ws.ctx, { view, targetId, versionName: vName });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="ptc-timetable-${view}.xlsx"`);
      res.send(buf);
      return;
    }
    if (format === 'pdf') {
      const buf = await exportTimetablePdf(ws.ctx, { view, targetId, versionName: vName });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="ptc-timetable-${view}.pdf"`);
      res.send(buf);
      return;
    }
    res.status(400).json({ error: 'Unsupported export format (use output, csv, excel, or pdf)' });
  });

  // ---- Staff profiles (personal background) + timetable change history ------
  router.get('/staff/:code/profile', async (req: Request, res: Response) => {
    const code = strParam(req.params.code);
    const ws = await loadContextFromDb({});
    const staffRow = ws.ctx.staff.find((s) => s.employeeCode === code);
    if (!staffRow) {
      res.status(404).json({ error: 'ไม่พบบุคลากรรหัสนี้' });
      return;
    }
    const itemIds = ws.ctx.itemTeachers.filter((t) => t.staffId === staffRow.id).map((t) => t.itemId);
    const [profile, history] = await Promise.all([getStaffProfile(code), getItemHistory(itemIds)]);
    res.json({ profile, history });
  });

  router.put('/staff/:code/profile', async (req: Request, res: Response) => {
    const text = (max: number) => z.string().max(max).nullable().optional();
    const parsed = z
      .object({
        nickname: text(50),
        email: z.union([z.literal(''), z.string().email().max(120)]).nullable().optional(),
        education: text(2000),
        workHistory: text(2000),
        expertise: text(1000),
        bio: text(2000),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลโปรไฟล์ไม่ถูกต้อง (ตรวจรูปแบบอีเมลและความยาวข้อความ)', issues: parsed.error.issues });
      return;
    }
    const code = strParam(req.params.code);
    const ws = await loadContextFromDb({});
    if (!ws.ctx.staff.some((s) => s.employeeCode === code)) {
      res.status(404).json({ error: 'ไม่พบบุคลากรรหัสนี้' });
      return;
    }
    res.json({ profile: await saveStaffProfile(code, parsed.data) });
  });

  registerWeeklyRoutes(router, strParam);

  router.get('/audit-logs', async (_req: Request, res: Response) => {
    const rows = await db.select().from(auditLogs).limit(100);
    res.json({ logs: rows });
  });

  return router;
}
