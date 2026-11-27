/**
 * Dated weekly timetable API: date-specific moves / cancellations / makeups (schedule_exceptions),
 * swap & permanent-move requests with approval (change_requests), and weekly lesson units (lesson_plans).
 * The two new tables are created on first use. Every placement is re-checked here with the same
 * shared planner the page uses, so a request cannot create a clash. Exceptions live outside the
 * cached master snapshot, so writing them does not invalidate it.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { and, eq } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import {
  datedPlacementProblem,
  mondayOf,
  planCellActions,
  weekOccurrences,
  weekPlanningContext,
  type Occurrence,
  type ScheduleException,
} from '@ptc/shared';
import { db, pool } from '../db/client';
import { scheduleExceptions } from '../db/schema';
import { updateScheduleItemsAtomic } from '../services/occupancy.service';
import { loadContextFromDb } from '../services/schedule-loader.service';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

let ensured: Promise<unknown> | null = null;
const ensureTables = () =>
  (ensured ??= Promise.all([
    pool.query(`CREATE TABLE IF NOT EXISTS change_requests (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      kind VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL,
      payload JSON NOT NULL,
      requested_by VARCHAR(60) NOT NULL,
      peer_code VARCHAR(20) NULL,
      note TEXT NULL,
      decided_by VARCHAR(60) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TIMESTAMP NULL
    ) DEFAULT CHARSET=utf8mb4`),
    pool.query(`CREATE TABLE IF NOT EXISTS lesson_plans (
      subject_code VARCHAR(30) NOT NULL,
      week_no INT NOT NULL,
      unit VARCHAR(300) NOT NULL,
      PRIMARY KEY (subject_code, week_no)
    ) DEFAULT CHARSET=utf8mb4`),
  ]).catch((e) => {
    ensured = null;
    throw e;
  }));

async function loadWeekState() {
  const ws = await loadContextFromDb({});
  const versionId = ws.activeVersion?.id;
  if (!versionId) throw Object.assign(new Error('ยังไม่มีตารางหลักที่เผยแพร่'), { status: 400 });
  const rows = await db.select().from(scheduleExceptions).where(eq(scheduleExceptions.versionId, versionId));
  const exceptions = rows as unknown as ScheduleException[];
  return { ws, ctx: ws.ctx, versionId, exceptions };
}

type State = Awaited<ReturnType<typeof loadWeekState>>;
/** The class as it belongs to its original date (listed in that week even if moved/made up elsewhere). */
const occurrenceOf = (s: State, itemId: string, date: string) =>
  weekOccurrences(s.ctx.items, s.ctx.itemTeachers, s.exceptions, mondayOf(date)).find((o) => o.id === `${itemId}@${date}`);

/** Replace the move/cancel exception of one dated class (inside a transaction). */
async function putException(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  versionId: string,
  itemId: string,
  date: string,
  slot: { date: string; period: number } | null,
) {
  await tx
    .delete(scheduleExceptions)
    .where(and(eq(scheduleExceptions.versionId, versionId), eq(scheduleExceptions.itemId, itemId), eq(scheduleExceptions.exceptionDate, date)));
  await tx.insert(scheduleExceptions).values({
    id: randomUUID(),
    versionId,
    issueId: null,
    itemId,
    exceptionDate: date,
    action: slot ? 'makeup' : 'cancel',
    substituteStaffId: null,
    newRoomId: null,
    makeupDate: slot?.date ?? null,
    makeupPeriod: slot?.period ?? null,
  } as never);
}

const fail = (res: Response, e: unknown) => {
  const status = (e as { status?: number }).status ?? 400;
  res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
};

/** Apply a same-week swap of two dated classes after checking both sides are free. */
async function applySwap(s: State, a: { itemId: string; date: string }, b: { itemId: string; date: string }) {
  if (mondayOf(a.date) !== mondayOf(b.date)) throw new Error('สลับได้เฉพาะคาบในสัปดาห์เดียวกัน');
  const week = weekOccurrences(s.ctx.items, s.ctx.itemTeachers, s.exceptions, mondayOf(a.date));
  const oa = week.find((o) => o.id === `${a.itemId}@${a.date}`);
  const ob = week.find((o) => o.id === `${b.itemId}@${b.date}`);
  if (!oa?.date || !ob?.date || !oa.period || !ob.period) throw new Error('คาบที่จะสลับไม่ได้อยู่ในตารางสัปดาห์นี้แล้ว');
  const swap = planCellActions(weekPlanningContext(s.ctx, week), oa.id).swaps.find((x) => x.otherItemId === ob.id);
  if (!swap?.ok) throw new Error(swap?.reason ?? 'สลับไม่ได้');
  await db.transaction(async (tx) => {
    await putException(tx, s.versionId, a.itemId, a.date, { date: ob.date!, period: ob.period! });
    await putException(tx, s.versionId, b.itemId, b.date, { date: oa.date!, period: oa.period! });
  });
}

/** Apply a permanent move in the master timetable after re-checking it. */
async function applyPermanentMove(s: State, itemId: string, day: number, period: number) {
  const move = planCellActions(s.ctx, itemId).moves.find((m) => m.day === day && m.period === period);
  if (!move?.ok) throw new Error(move?.reason ?? 'ย้ายไม่ได้');
  await updateScheduleItemsAtomic({
    versionId: s.versionId,
    ctx: s.ctx,
    changes: [{ itemId, patch: { dayOfWeek: day, startPeriod: period, status: 'scheduled' } }],
  });
}

export function registerWeeklyRoutes(router: Router, strParam: (v: string | string[] | undefined) => string) {
  router.get('/weekly/data', async (_req: Request, res: Response) => {
    try {
      await ensureTables();
      const s = await loadWeekState();
      const [reqRows] = await pool.query<RowDataPacket[]>('SELECT * FROM change_requests ORDER BY created_at DESC LIMIT 200');
      const [planRows] = await pool.query<RowDataPacket[]>('SELECT * FROM lesson_plans');
      res.json({
        versionId: s.versionId,
        termStart: s.ctx.term.startDate,
        exceptions: s.exceptions,
        requests: reqRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
          requestedBy: r.requested_by,
          peerCode: r.peer_code,
          note: r.note,
          decidedBy: r.decided_by,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
          decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        })),
        lessonPlans: planRows.map((r) => ({ subjectCode: r.subject_code, weekNo: Number(r.week_no), unit: r.unit })),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  // Move one dated class to another date/period (weekend allowed), or cancel it (owed until made up).
  router.post('/weekly/exceptions', async (req: Request, res: Response) => {
    const parsed = z
      .object({ itemId: z.string().min(1), date: ISO, to: z.object({ date: ISO, period: z.number().int().min(1).max(12) }).nullable() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const { itemId, date, to } = parsed.data;
    try {
      const s = await loadWeekState();
      const occ = occurrenceOf(s, itemId, date);
      if (!occ) throw new Error('ไม่พบคาบเรียนนี้ในวันที่ระบุ');
      if (occ.item.isLocked) throw new Error('คาบนี้ถูกล็อกไว้ ย้ายหรืองดไม่ได้');
      if (to) {
        const others = s.exceptions.filter((e) => !(e.itemId === itemId && e.exceptionDate === date));
        const problem = datedPlacementProblem(s.ctx, others, occ, to.date, to.period);
        if (problem) throw new Error(problem);
      }
      await db.transaction((tx) => putException(tx, s.versionId, itemId, date, to));
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Back to the master timetable for that date.
  router.delete('/weekly/exceptions', async (req: Request, res: Response) => {
    const itemId = strParam(req.query.itemId as string | undefined);
    const date = strParam(req.query.date as string | undefined);
    try {
      const s = await loadWeekState();
      const occ = occurrenceOf(s, itemId, date);
      if (!occ) throw new Error('ไม่พบคาบเรียนนี้ในวันที่ระบุ');
      // Restoring must not collide with what now sits in the original slot. If a class that was itself
      // moved (e.g. the other half of a swap) sits there, restore it too — all in one go.
      const restore = [occ];
      const keyOf = (o: Occurrence) => `${o.item.id}@${o.originalDate}`;
      for (;;) {
        const keys = new Set(restore.map(keyOf));
        const others = s.exceptions.filter((e) => !keys.has(`${e.itemId}@${e.exceptionDate}`));
        const blocked = restore
          .map((o) => ({ o, problem: datedPlacementProblem(s.ctx, others, o, o.originalDate, o.item.startPeriod!) }))
          .find((x) => x.problem);
        if (!blocked) break;
        const { o } = blocked;
        const end = o.item.startPeriod! + o.item.duration;
        const blocker = weekOccurrences(s.ctx.items, s.ctx.itemTeachers, others, mondayOf(o.originalDate)).find(
          (w) =>
            w.exception &&
            !keys.has(keyOf(w)) &&
            w.date === o.originalDate &&
            w.period! < end &&
            o.item.startPeriod! < w.period! + w.item.duration,
        );
        if (!blocker || restore.length >= 6) throw new Error(`คืนตามตารางหลักไม่ได้: ${blocked.problem}`);
        restore.push(blocker);
      }
      await db.transaction(async (tx) => {
        for (const o of restore) {
          await tx
            .delete(scheduleExceptions)
            .where(and(eq(scheduleExceptions.versionId, s.versionId), eq(scheduleExceptions.itemId, o.item.id), eq(scheduleExceptions.exceptionDate, o.originalDate)));
        }
      });
      res.json({ ok: true, restored: restore.map(keyOf) });
    } catch (e) {
      fail(res, e);
    }
  });

  const Dated = z.object({ itemId: z.string().min(1), date: ISO });
  router.post('/weekly/swap', async (req: Request, res: Response) => {
    const parsed = z.object({ a: Dated, b: Dated }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
      return;
    }
    try {
      await applySwap(await loadWeekState(), parsed.data.a, parsed.data.b);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Requests: a teacher asks a colleague to swap this week (peer accepts), or asks for a permanent move (admin approves).
  router.post('/weekly/requests', async (req: Request, res: Response) => {
    const parsed = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('swap_week'), a: Dated, b: Dated, peerCode: z.string().min(1).max(20) }),
        z.object({ kind: z.literal('move_permanent'), itemId: z.string().min(1), day: z.number().int().min(1).max(7), period: z.number().int().min(1).max(12) }),
      ])
      .and(z.object({ requestedBy: z.string().min(1).max(60), note: z.string().max(500).optional() }))
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลคำขอไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    try {
      await ensureTables();
      const s = await loadWeekState();
      // Check now so nobody is asked to approve something impossible.
      if (d.kind === 'swap_week') {
        const week = weekOccurrences(s.ctx.items, s.ctx.itemTeachers, s.exceptions, mondayOf(d.a.date));
        const sw = planCellActions(weekPlanningContext(s.ctx, week), `${d.a.itemId}@${d.a.date}`).swaps.find(
          (x) => x.otherItemId === `${d.b.itemId}@${d.b.date}`,
        );
        if (!sw?.ok) throw new Error(sw?.reason ?? 'สลับไม่ได้');
      } else {
        const mv = planCellActions(s.ctx, d.itemId).moves.find((m) => m.day === d.day && m.period === d.period);
        if (!mv?.ok) throw new Error(mv?.reason ?? 'ย้ายไม่ได้');
      }
      const { kind, requestedBy, note, ...payload } = d;
      const id = randomUUID();
      await pool.query(
        'INSERT INTO change_requests (id, kind, status, payload, requested_by, peer_code, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, kind, kind === 'swap_week' ? 'pending_peer' : 'pending_admin', JSON.stringify(payload), requestedBy, d.kind === 'swap_week' ? d.peerCode : null, note ?? null],
      );
      res.json({ ok: true, id });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/weekly/requests/:id/decide', async (req: Request, res: Response) => {
    const parsed = z.object({ accept: z.boolean(), by: z.string().min(1).max(60) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
      return;
    }
    const id = strParam(req.params.id);
    try {
      await ensureTables();
      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM change_requests WHERE id = ?', [id]);
      const r = rows[0];
      if (!r) throw Object.assign(new Error('ไม่พบคำขอ'), { status: 404 });
      if (r.status !== 'pending_peer' && r.status !== 'pending_admin') throw new Error('คำขอนี้ถูกตัดสินแล้ว');
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      if (parsed.data.accept) {
        const s = await loadWeekState();
        if (r.kind === 'swap_week') await applySwap(s, payload.a, payload.b);
        else await applyPermanentMove(s, payload.itemId, payload.day, payload.period); // invalidates the cache itself
      }
      await pool.query('UPDATE change_requests SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?', [
        parsed.data.accept ? 'approved' : 'rejected',
        parsed.data.by,
        id,
      ]);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Weekly lesson units of one subject (shared by every group taking it).
  router.put('/weekly/lesson-plans/:subjectCode', async (req: Request, res: Response) => {
    const parsed = z
      .object({ weeks: z.array(z.object({ weekNo: z.number().int().min(1).max(40), unit: z.string().max(300) })).max(40) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลแผนการสอนไม่ถูกต้อง' });
      return;
    }
    const code = strParam(req.params.subjectCode);
    try {
      await ensureTables();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM lesson_plans WHERE subject_code = ?', [code]);
        const weeks = parsed.data.weeks.filter((w) => w.unit.trim());
        if (weeks.length) {
          await conn.query('INSERT INTO lesson_plans (subject_code, week_no, unit) VALUES ?', [weeks.map((w) => [code, w.weekNo, w.unit.trim()])]);
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
}
