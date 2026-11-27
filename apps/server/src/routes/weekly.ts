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
  placementProblem,
  planCellActions,
  weekOccurrences,
  weekPlanningContext,
  type Occurrence,
  type ScheduleException,
} from '@ptc/shared';
import { db, pool } from '../db/client';
import { rooms as roomsTable, scheduleExceptions } from '../db/schema';
import { updateScheduleItemsAtomic } from '../services/occupancy.service';
import { invalidateWorkspaceCache, loadContextFromDb } from '../services/schedule-loader.service';

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
  roomId: string | null = null,
  masterPeriod: number | null = null,
) {
  // Same date & period with another room = a room change for that day only.
  const roomOnly = !!slot && !!roomId && slot.date === date && slot.period === masterPeriod;
  await tx
    .delete(scheduleExceptions)
    .where(and(eq(scheduleExceptions.versionId, versionId), eq(scheduleExceptions.itemId, itemId), eq(scheduleExceptions.exceptionDate, date)));
  await tx.insert(scheduleExceptions).values({
    id: randomUUID(),
    versionId,
    issueId: null,
    itemId,
    exceptionDate: date,
    action: roomOnly ? 'room_change' : slot ? 'makeup' : 'cancel',
    substituteStaffId: null,
    newRoomId: slot ? roomId : null,
    makeupDate: roomOnly ? null : (slot?.date ?? null),
    makeupPeriod: roomOnly ? null : (slot?.period ?? null),
  } as never);
}

const fail = (res: Response, e: unknown) => {
  const status = (e as { status?: number }).status ?? 400;
  res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
};

/** Only admin / scheduler change the timetable directly; teachers send requests they approve. */
const MANAGERS = ['admin', 'scheduler'];
const isManager = (req: Request) => MANAGERS.includes(req.user?.role ?? '');
const deny = (res: Response, message: string) => res.status(403).json({ error: message });
const MANAGER_ONLY = 'เฉพาะผู้ดูแลระบบหรือผู้จัดตารางเท่านั้น — ครูโปรดส่งคำขอให้ผู้จัดตารางอนุมัติ';

/** Move one dated class (or cancel it when `to` is null) after checking the target is free. */
async function applyDatedMove(
  s: State,
  itemId: string,
  date: string,
  to: { date: string; period: number } | null,
  roomId: string | null = null,
  dryRun = false,
) {
  const occ = occurrenceOf(s, itemId, date);
  if (!occ) throw new Error('ไม่พบคาบเรียนนี้ในวันที่ระบุ');
  if (occ.item.isLocked) throw new Error('คาบนี้ถูกล็อกไว้ ย้ายหรืองดไม่ได้');
  if (to) {
    const others = s.exceptions.filter((e) => !(e.itemId === itemId && e.exceptionDate === date));
    const problem = datedPlacementProblem(s.ctx, others, occ, to.date, to.period, roomId);
    if (problem) throw new Error(problem);
  }
  if (!dryRun) await db.transaction((tx) => putException(tx, s.versionId, itemId, date, to, roomId, occ.item.startPeriod));
}

/** Apply a same-week swap of two dated classes after checking both sides are free. */
async function applySwap(s: State, a: { itemId: string; date: string }, b: { itemId: string; date: string }, dryRun = false) {
  if (mondayOf(a.date) !== mondayOf(b.date)) throw new Error('สลับได้เฉพาะคาบในสัปดาห์เดียวกัน');
  const week = weekOccurrences(s.ctx.items, s.ctx.itemTeachers, s.exceptions, mondayOf(a.date));
  const oa = week.find((o) => o.id === `${a.itemId}@${a.date}`);
  const ob = week.find((o) => o.id === `${b.itemId}@${b.date}`);
  if (!oa?.date || !ob?.date || !oa.period || !ob.period) throw new Error('คาบที่จะสลับไม่ได้อยู่ในตารางสัปดาห์นี้แล้ว');
  const swap = planCellActions(weekPlanningContext(s.ctx, week), oa.id).swaps.find((x) => x.otherItemId === ob.id);
  if (!swap?.ok) throw new Error(swap?.reason ?? 'สลับไม่ได้');
  if (dryRun) return;
  await db.transaction(async (tx) => {
    await putException(tx, s.versionId, a.itemId, a.date, { date: ob.date!, period: ob.period! });
    await putException(tx, s.versionId, b.itemId, b.date, { date: oa.date!, period: oa.period! });
  });
}

/** Apply a permanent move in the master timetable after re-checking it. */
async function applyPermanentMove(s: State, itemId: string, day: number, period: number, roomId: string | null = null, dryRun = false) {
  const problem = placementProblem(s.ctx, itemId, day, period, roomId ?? undefined);
  if (problem) throw new Error(problem);
  if (dryRun) return;
  await updateScheduleItemsAtomic({
    versionId: s.versionId,
    ctx: s.ctx,
    changes: [{ itemId, patch: { dayOfWeek: day, startPeriod: period, status: 'scheduled', ...(roomId ? { roomId } : {}) } }],
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
      .object({
        itemId: z.string().min(1),
        date: ISO,
        to: z.object({ date: ISO, period: z.number().int().min(1).max(12) }).nullable(),
        roomId: z.string().min(1).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    if (!isManager(req)) return void deny(res, MANAGER_ONLY);
    const { itemId, date, to, roomId } = parsed.data;
    try {
      await applyDatedMove(await loadWeekState(), itemId, date, to, roomId ?? null);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Back to the master timetable for that date.
  router.delete('/weekly/exceptions', async (req: Request, res: Response) => {
    if (!isManager(req)) return void deny(res, MANAGER_ONLY);
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
    if (!isManager(req)) return void deny(res, MANAGER_ONLY);
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

  // Requests: every timetable change a teacher wants (move / makeup / cancel / swap this week, or a
  // permanent move) waits for an admin or scheduler. Checked now so nobody approves something impossible,
  // and checked again on approval because the timetable may have changed meanwhile.
  const To = z.object({ date: ISO, period: z.number().int().min(1).max(12) });
  const RequestBody = z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('move_week'), itemId: z.string().min(1), date: ISO, to: To, roomId: z.string().min(1).nullable().optional() }),
      z.object({ kind: z.literal('cancel_week'), itemId: z.string().min(1), date: ISO }),
      z.object({ kind: z.literal('swap_week'), a: Dated, b: Dated }),
      z.object({
        kind: z.literal('move_permanent'),
        itemId: z.string().min(1),
        day: z.number().int().min(1).max(7),
        period: z.number().int().min(1).max(12),
        roomId: z.string().min(1).nullable().optional(),
      }),
    ])
    .and(z.object({ requestedBy: z.string().min(1).max(60), note: z.string().max(500).optional() }));
  type Payload = {
    itemId?: string;
    date?: string;
    to?: { date: string; period: number };
    roomId?: string | null;
    a?: { itemId: string; date: string };
    b?: { itemId: string; date: string };
    day?: number;
    period?: number;
  };
  const applyRequest = (s: State, kind: string, p: Payload, dryRun: boolean) => {
    if (kind === 'move_week') return applyDatedMove(s, p.itemId!, p.date!, p.to!, p.roomId ?? null, dryRun);
    if (kind === 'cancel_week') return applyDatedMove(s, p.itemId!, p.date!, null, null, dryRun);
    if (kind === 'swap_week') return applySwap(s, p.a!, p.b!, dryRun);
    return applyPermanentMove(s, p.itemId!, p.day!, p.period!, p.roomId ?? null, dryRun); // invalidates the cache itself
  };

  router.post('/weekly/requests', async (req: Request, res: Response) => {
    if (!['admin', 'scheduler', 'teacher'].includes(req.user?.role ?? '')) return void deny(res, 'บัญชีนี้ส่งคำขอปรับตารางไม่ได้');
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลคำขอไม่ถูกต้อง', issues: parsed.error.issues });
      return;
    }
    const { kind, requestedBy, note, ...payload } = parsed.data;
    try {
      await ensureTables();
      await applyRequest(await loadWeekState(), kind, payload, true);
      const id = randomUUID();
      await pool.query(
        'INSERT INTO change_requests (id, kind, status, payload, requested_by, peer_code, note) VALUES (?, ?, ?, ?, ?, NULL, ?)',
        [id, kind, 'pending_admin', JSON.stringify(payload), requestedBy, note ?? null],
      );
      res.json({ ok: true, id });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/weekly/requests/:id/decide', async (req: Request, res: Response) => {
    if (!isManager(req)) return void deny(res, 'เฉพาะผู้ดูแลระบบหรือผู้จัดตารางเท่านั้นที่อนุมัติคำขอได้');
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
      if (!String(r.status).startsWith('pending')) throw new Error('คำขอนี้ถูกตัดสินแล้ว');
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      if (parsed.data.accept) await applyRequest(await loadWeekState(), String(r.kind), payload, false);
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

  // Add a classroom or a shared space (hall / the college dome) so classes can be moved there.
  router.post('/rooms', async (req: Request, res: Response) => {
    if (!isManager(req)) return void deny(res, 'เฉพาะผู้ดูแลระบบหรือผู้จัดตารางเท่านั้นที่เพิ่มห้องได้');
    const parsed = z
      .object({ roomCode: z.string().trim().min(1).max(30), capacity: z.number().int().min(1).max(5000), shared: z.boolean() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ข้อมูลห้องไม่ถูกต้อง (ชื่อห้อง 1–30 ตัวอักษร, ความจุ 1–5000)' });
      return;
    }
    const { roomCode, capacity, shared } = parsed.data;
    try {
      const { ctx } = await loadWeekState();
      if (ctx.rooms.some((r) => r.roomCode === roomCode)) throw new Error(`มีห้อง "${roomCode}" อยู่แล้ว`);
      const type = ctx.roomTypes.find((t) => t.code === (shared ? 'activity_yard' : 'theory')) ?? ctx.roomTypes[0];
      const building = ctx.buildings[0];
      if (!type || !building) throw new Error('ยังไม่มีข้อมูลอาคารหรือประเภทห้องในระบบ');
      const id = randomUUID();
      await db.insert(roomsTable).values({
        id,
        roomCode,
        buildingId: building.id,
        roomTypeId: type.id,
        capacity,
        allowMultiGroup: shared,
        features: null,
        unavailableSlots: null,
      } as never);
      invalidateWorkspaceCache();
      res.json({ ok: true, id });
    } catch (e) {
      fail(res, e);
    }
  });

  // Weekly lesson units of one subject (shared by every group taking it).
  router.put('/weekly/lesson-plans/:subjectCode', async (req: Request, res: Response) => {
    if (!['admin', 'scheduler', 'teacher'].includes(req.user?.role ?? '')) return void deny(res, 'บัญชีนี้แก้แผนการสอนไม่ได้');
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
