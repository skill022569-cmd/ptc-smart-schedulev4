import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, BookOpen, CalendarClock, Check, ChevronLeft, ChevronRight, Inbox, MoveRight, RotateCcw, Send, X, XCircle } from 'lucide-react';
import {
  DAY_NAMES_TH,
  addDays,
  dayOfWeekOf,
  mondayOf,
  owedOccurrences,
  planCellActions,
  termWeekOf,
  toIsoDate,
  weekOccurrences,
  weekPlanningContext,
  type AccountRole,
  type Occurrence,
  type ScheduleException,
} from '@ptc/shared';
import { PageSkeleton } from '../components/PageSkeleton';
import { api, getDemoStaff, setDemoStaff, type ChangeRequest, type WeeklyData } from '../lib/api';
import type { ScheduleWorkspacePayload } from '../types/ui';

type View = 'group' | 'teacher' | 'room';
const DAY_SHORT: Record<number, string> = { 1: 'จ.', 2: 'อ.', 3: 'พ.', 4: 'พฤ.', 5: 'ศ.', 6: 'ส.', 7: 'อา.' };
const thDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const COLORS = ['bg-sky-50 border-sky-200', 'bg-violet-50 border-violet-200', 'bg-emerald-50 border-emerald-200', 'bg-amber-50 border-amber-200', 'bg-rose-50 border-rose-200', 'bg-teal-50 border-teal-200', 'bg-orange-50 border-orange-200', 'bg-lime-50 border-lime-200'];
const colorOf = (id: string) => COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;
const BADGE: Record<string, { text: string; cls: string } | undefined> = {
  moved: { text: 'ย้ายเฉพาะสัปดาห์นี้', cls: 'bg-sky-100 text-sky-800' },
  makeup: { text: 'สอนชดเชย', cls: 'bg-gold-100 text-gold-600' },
};

/**
 * Real-calendar weekly timetable. The master timetable stays as published; edits here are dated
 * exceptions (this week only), cancellations become owed classes that can be made up on any free
 * slot — including Saturday/Sunday — and teachers send swap / permanent-move requests for approval.
 */
export function WeeklyPage({
  profile,
  role,
  jwtStaffId,
  onRequestsChanged,
}: {
  profile: string;
  role: AccountRole;
  jwtStaffId: string | null;
  onRequestsChanged: () => void;
}) {
  const isAdmin = role === 'admin' || role === 'scheduler';
  const [data, setData] = useState<ScheduleWorkspacePayload | null>(() => api.getCachedScheduleLatest(profile));
  const [weekly, setWeekly] = useState<WeeklyData | null>(null);
  const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
  const [weekStart, setWeekStart] = useState(() => mondayOf(toIsoDate(new Date())));
  const [view, setView] = useState<View>(role === 'teacher' ? 'teacher' : 'group');
  const [targetId, setTargetId] = useState('');
  const [meCode, setMeCode] = useState(getDemoStaff);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [showPermanent, setShowPermanent] = useState(false);
  const [unitDraft, setUnitDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const loadWeekly = async () => {
    try {
      const w = await api.weeklyData();
      setWeekly(w);
      setExceptions(w.exceptions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'โหลดข้อมูลรายสัปดาห์ไม่สำเร็จ');
    }
  };
  useEffect(() => {
    api.scheduleLatest(profile).then(setData, (e) => setErr(e instanceof Error ? e.message : 'โหลดตารางไม่สำเร็จ'));
    void loadWeekly();
  }, [profile]);

  const ctx = data?.context;
  const me = ctx?.staff.find((s) => (jwtStaffId ? s.id === jwtStaffId : s.employeeCode === meCode)) ?? null;
  useEffect(() => {
    if (role === 'teacher' && view === 'teacher' && me) setTargetId(me.id);
  }, [role, me?.id]);

  const maps = useMemo(() => {
    if (!ctx) return null;
    const gByOff = new Map<string, string[]>();
    for (const og of ctx.offeringGroups) gByOff.set(og.offeringId, [...(gByOff.get(og.offeringId) ?? []), og.groupId]);
    return {
      gByOff,
      off: new Map(ctx.offerings.map((o) => [o.id, o])),
      subj: new Map(ctx.subjects.map((s) => [s.id, s])),
      staff: new Map(ctx.staff.map((s) => [s.id, s])),
      room: new Map(ctx.rooms.map((r) => [r.id, r])),
      group: new Map(ctx.studentGroups.map((g) => [g.id, g])),
    };
  }, [ctx]);

  const targets = useMemo(() => {
    if (!ctx) return [];
    if (view === 'teacher') return ctx.staff.map((s) => ({ id: s.id, label: s.fullName }));
    if (view === 'room') return ctx.rooms.map((r) => ({ id: r.id, label: `ห้อง ${r.roomCode}` }));
    return ctx.studentGroups.map((g) => ({ id: g.id, label: `${g.groupCode} (${g.level})` }));
  }, [ctx, view]);
  const target = targets.some((t) => t.id === targetId) ? targetId : (targets[0]?.id ?? '');

  const weekEnd = addDays(weekStart, 6);
  const inWeek = (iso: string | null) => !!iso && iso >= weekStart && iso <= weekEnd;
  const occs = useMemo(() => (ctx ? weekOccurrences(ctx.items, ctx.itemTeachers, exceptions, weekStart) : []), [ctx, exceptions, weekStart]);
  const owedAll = useMemo(() => (ctx ? owedOccurrences(ctx.items, ctx.itemTeachers, exceptions) : []), [ctx, exceptions]);
  const thisWeek = useMemo(() => occs.filter((o) => inWeek(o.date)), [occs]);
  const placing = placingId ? (owedAll.find((o) => o.id === placingId) ?? null) : null;
  const planCtx = useMemo(() => (ctx ? weekPlanningContext(ctx, thisWeek, placing ? [placing] : []) : null), [ctx, thisWeek, placing]);
  const activeId = placing?.id ?? selectedId;
  const plan = useMemo(() => (planCtx && activeId ? planCellActions(planCtx, activeId) : null), [planCtx, activeId]);

  if (!data || !ctx || !maps || !weekly) {
    return err ? <div className="rounded-xl border border-rose-200 bg-white p-6 text-sm text-rose-700">{err}</div> : <PageSkeleton cards={2} />;
  }

  const groupsOf = (o: Occurrence) => maps.gByOff.get(o.item.offeringId) ?? [];
  const inView = (o: Occurrence) =>
    view === 'group' ? groupsOf(o).includes(target) : view === 'teacher' ? o.teacherIds.includes(target) : o.roomId === target;
  const subjectOf = (o: Occurrence) => maps.subj.get(maps.off.get(o.item.offeringId)?.subjectId ?? '');
  const teachers = (o: Occurrence) => o.teacherIds.map((t) => maps.staff.get(t)?.fullName ?? '').join(', ');
  const groupsText = (o: Occurrence) => groupsOf(o).map((g) => maps.group.get(g)?.groupCode ?? '').join(', ');
  const roomText = (o: Occurrence) => (o.roomId ? `ห้อง ${maps.room.get(o.roomId)?.roomCode ?? ''}` : 'ไม่ระบุห้อง');
  const slotText = (date: string | null, p: number | null) => (date && p ? `${DAY_SHORT[dayOfWeekOf(date)]} ${thDate(date)} คาบ ${p}` : 'ยังไม่ได้สอน');
  const weekNo = termWeekOf(weekly.termStart, weekStart);
  const unitOf = (o: Occurrence) => {
    const code = subjectOf(o)?.subjectCode;
    const w = termWeekOf(weekly.termStart, o.originalDate);
    return weekly.lessonPlans.find((l) => l.subjectCode === code && l.weekNo === w)?.unit;
  };
  const canAct = (o: Occurrence) => isAdmin || (role === 'teacher' && !!me && o.teacherIds.includes(me.id));
  const actor = me?.employeeCode ?? role;

  const placed = thisWeek.filter(inView);
  const awayHere = occs.filter((o) => inView(o) && inWeek(o.originalDate) && !inWeek(o.date));
  const owed = owedAll.filter(inView);
  const selected = selectedId ? (occs.find((o) => o.id === selectedId) ?? null) : null;
  const moveAt = new Map((plan?.moves ?? []).map((m) => [`${m.day}:${m.period}`, m]));
  const swapWith = new Map((plan?.swaps ?? []).map((s) => [s.otherItemId, s]));
  const periods = [...ctx.timeSlots].sort((a, b) => a.period - b.period);
  const lunch = view === 'group' ? maps.group.get(target)?.lunchPeriod : undefined;

  // ---- actions (screen updates first, server confirms; a refusal reloads the server copy) ----
  const localSet = (o: Occurrence, to: { date: string; period: number } | null) =>
    setExceptions((xs) => [
      ...xs.filter((e) => !(e.itemId === o.item.id && e.exceptionDate === o.originalDate)),
      {
        id: `tmp:${o.id}`,
        versionId: weekly.versionId,
        issueId: null,
        itemId: o.item.id,
        exceptionDate: o.originalDate,
        action: to ? 'makeup' : 'cancel',
        substituteStaffId: null,
        newRoomId: null,
        makeupDate: to?.date ?? null,
        makeupPeriod: to?.period ?? null,
      },
    ]);
  const run = async (label: string, send: () => Promise<unknown>) => {
    setErr('');
    setMsg(label);
    setSelectedId(null);
    setPlacingId(null);
    setShowPermanent(false);
    try {
      await send();
    } catch (e) {
      setMsg('');
      setErr(e instanceof Error ? e.message : String(e));
    }
    await loadWeekly();
    onRequestsChanged();
  };
  const moveTo = (o: Occurrence, date: string, period: number) => {
    localSet(o, { date, period });
    const what = `${subjectOf(o)?.subjectCode ?? ''} (${groupsText(o)})`;
    void run(
      o.kind === 'away' || !o.date ? `ลงสอนชดเชย ${what} ใน ${slotText(date, period)}` : `ย้าย ${what} เฉพาะสัปดาห์นี้ → ${slotText(date, period)}`,
      () => api.setDatedSlot(o.item.id, o.originalDate, { date, period }),
    );
  };
  const cancel = (o: Occurrence) => {
    localSet(o, null);
    void run(`งดสอน ${subjectOf(o)?.subjectCode ?? ''} ${slotText(o.date, o.period)} → บันทึกเป็นคาบค้างสอน`, () =>
      api.setDatedSlot(o.item.id, o.originalDate, null),
    );
  };
  const restore = (o: Occurrence) => {
    setExceptions((xs) => xs.filter((e) => !(e.itemId === o.item.id && e.exceptionDate === o.originalDate)));
    void run(`คืน ${subjectOf(o)?.subjectCode ?? ''} กลับตามตารางหลัก`, () => api.restoreDated(o.item.id, o.originalDate));
  };
  const swap = (a: Occurrence, b: Occurrence) => {
    const peer = b.teacherIds.map((t) => maps.staff.get(t)).find(Boolean);
    const direct = isAdmin || (me && b.teacherIds.includes(me.id));
    const A = { itemId: a.item.id, date: a.originalDate };
    const B = { itemId: b.item.id, date: b.originalDate };
    if (direct) {
      localSet(a, { date: b.date!, period: b.period! });
      localSet(b, { date: a.date!, period: a.period! });
      void run(`สลับ ${subjectOf(a)?.subjectCode} ⇄ ${subjectOf(b)?.subjectCode} เฉพาะสัปดาห์นี้`, () => api.swapDated(A, B));
    } else if (peer) {
      void run(`ส่งคำขอสลับคาบถึง ${peer.fullName} แล้ว — รอครูท่านนั้นกดยอมรับ`, () =>
        api.createRequest({ kind: 'swap_week', a: A, b: B, peerCode: peer.employeeCode, requestedBy: actor }),
      );
    }
  };
  const permanent = (o: Occurrence, day: number, period: number) => {
    const text = `${subjectOf(o)?.subjectCode} → ${DAY_NAMES_TH[day]} คาบ ${period} (ทุกสัปดาห์)`;
    if (isAdmin) {
      void run(`ย้ายถาวร ${text}`, () =>
        api.moveItems(weekly.versionId, [{ itemId: o.item.id, dayOfWeek: day, startPeriod: period, status: 'scheduled' }]).then(() =>
          api.scheduleLatest(profile, true).then(setData),
        ),
      );
    } else {
      void run(`ส่งคำขอย้ายถาวร ${text} ถึงผู้จัดตารางแล้ว`, () =>
        api.createRequest({ kind: 'move_permanent', itemId: o.item.id, day, period, requestedBy: actor }),
      );
    }
  };
  const saveUnit = (o: Occurrence, unit: string) => {
    const code = subjectOf(o)?.subjectCode;
    if (!code) return;
    const w = termWeekOf(weekly.termStart, o.originalDate);
    const weeks = [...weekly.lessonPlans.filter((l) => l.subjectCode === code && l.weekNo !== w), { subjectCode: code, weekNo: w, unit }];
    setUnitDraft(null);
    setWeekly({ ...weekly, lessonPlans: [...weekly.lessonPlans.filter((l) => l.subjectCode !== code), ...weeks.filter((x) => x.unit.trim())] });
    void run(`บันทึกหน่วยการเรียนสัปดาห์ที่ ${w} แล้ว`, () => api.saveLessonPlan(code, weeks.map(({ weekNo, unit: u }) => ({ weekNo, unit: u }))));
  };

  // ---- requests ----
  const describe = (r: ChangeRequest) => {
    const occOf = (d?: { itemId: string; date: string }) => {
      const it = d && ctx.items.find((i) => i.id === d.itemId);
      const s = it && maps.subj.get(maps.off.get(it.offeringId)?.subjectId ?? '');
      return s && d ? `${s.subjectCode} ${s.subjectName} (${DAY_SHORT[dayOfWeekOf(d.date)]} ${thDate(d.date)})` : 'คาบเรียน';
    };
    if (r.kind === 'swap_week') return `สลับ ${occOf(r.payload.a)} ⇄ ${occOf(r.payload.b)}`;
    const it = ctx.items.find((i) => i.id === r.payload.itemId);
    const s = it && maps.subj.get(maps.off.get(it.offeringId)?.subjectId ?? '');
    return `ย้ายถาวร ${s?.subjectCode ?? ''} ${s?.subjectName ?? ''} → ${DAY_NAMES_TH[r.payload.day ?? 1]} คาบ ${r.payload.period}`;
  };
  const nameOf = (code: string | null) => ctx.staff.find((s) => s.employeeCode === code)?.fullName ?? code ?? '';
  const forMe = weekly.requests.filter(
    (r) => (r.status === 'pending_peer' && (isAdmin || r.peerCode === me?.employeeCode)) || (r.status === 'pending_admin' && isAdmin),
  );
  const mine = weekly.requests.filter((r) => me && r.requestedBy === me.employeeCode).slice(0, 8);
  const STATUS: Record<ChangeRequest['status'], string> = {
    pending_peer: 'รอครูอีกฝ่ายยอมรับ',
    pending_admin: 'รอผู้จัดตารางอนุมัติ',
    approved: 'อนุมัติแล้ว ✓',
    rejected: 'ไม่อนุมัติ',
  };
  const decide = (r: ChangeRequest, accept: boolean) =>
    void run(accept ? 'อนุมัติคำขอแล้ว ตารางถูกปรับตามคำขอ' : 'ปฏิเสธคำขอแล้ว', () => api.decideRequest(r.id, accept, actor));

  // ---- grid ----
  const days = [1, 2, 3, 4, 5, 6, 7];
  const blocksOf = (day: number) => {
    const date = addDays(weekStart, day - 1);
    const onDay = placed.filter((o) => o.date === date);
    const ps = periods.map((t) => t.period);
    const out: Array<{ period: number; span: number; here: Occurrence[] }> = [];
    for (let k = 0; k < ps.length; ) {
      const p = ps[k]!;
      const want = Math.max(1, ...onDay.filter((o) => o.period === p).map((o) => o.item.duration));
      let span = 1;
      while (span < want && ps[k + span] === p + span && !onDay.some((o) => o.period === p + span)) span++;
      out.push({ period: p, span, here: onDay.filter((o) => o.period! <= p && p < o.period! + o.item.duration) });
      k += span;
    }
    return out;
  };
  const clickCell = (day: number, period: number) => {
    const m = moveAt.get(`${day}:${period}`);
    const o = placing ?? selected;
    if (!o || !m) return;
    if (!m.ok) setErr(m.reason ?? 'ลงช่องนี้ไม่ได้');
    else moveTo(o, addDays(weekStart, day - 1), period);
  };
  const clickCard = (o: Occurrence) => {
    setErr('');
    const s = selected && swapWith.get(o.id);
    if (selected && s && canAct(selected)) {
      if (s.ok) swap(selected, o);
      else setErr(s.reason ?? 'สลับไม่ได้');
      return;
    }
    setPlacingId(null);
    setShowPermanent(false);
    setUnitDraft(null);
    setSelectedId(selectedId === o.id ? null : o.id);
  };

  const okMoves = (plan?.moves ?? []).filter((m) => m.ok);
  const okSwaps = (plan?.swaps ?? []).filter((s) => s.ok);
  const permanentMoves = showPermanent && selected ? planCellActions(ctx, selected.item.id).moves.filter((m) => m.ok) : [];
  const today = toIsoDate(new Date());

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">ตารางเรียนรายสัปดาห์ & สอนชดเชย</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            ปรับได้อิสระเฉพาะสัปดาห์ โดยตารางหลักไม่เปลี่ยน · งดสอนแล้วระบบจะนับเป็นคาบค้างสอนจนกว่าจะลงชดเชย (เสาร์–อาทิตย์ได้) · สลับกับครูท่านอื่นต้องให้ท่านนั้นยอมรับก่อน
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
          <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} className="rounded-lg p-2 hover:bg-slate-100" aria-label="สัปดาห์ก่อน">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-48 px-2 text-center">
            <div className="text-sm font-bold text-indigo-800">สัปดาห์ที่ {weekNo}</div>
            <div className="text-xs text-slate-500">
              {thDate(weekStart)} – {thDate(weekEnd)}
            </div>
          </div>
          <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))} className="rounded-lg p-2 hover:bg-slate-100" aria-label="สัปดาห์ถัดไป">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setWeekStart(mondayOf(today))} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
            สัปดาห์นี้
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
        <div className="flex rounded-lg bg-slate-100 p-1">
          {(
            [
              ['group', 'ตามกลุ่มเรียน'],
              ['teacher', 'ตามครู'],
              ['room', 'ตามห้องเรียน'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === v ? 'bg-white text-indigo-800 shadow-xs' : 'text-slate-600'}`}>
              {label}
            </button>
          ))}
        </div>
        <select value={target} onChange={(e) => setTargetId(e.target.value)} className="min-w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium" aria-label="เลือกตารางที่จะดู">
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {role === 'teacher' && !jwtStaffId && (
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-600">
            ใช้งานในนามครู
            <select
              value={meCode}
              onChange={(e) => {
                setMeCode(e.target.value);
                setDemoStaff(e.target.value);
                onRequestsChanged();
              }}
              className="rounded-lg border border-gold-500 bg-gold-100 px-2 py-1.5 text-sm font-medium"
            >
              <option value="">— เลือกชื่อของคุณ —</option>
              {ctx.staff.map((s) => (
                <option key={s.id} value={s.employeeCode}>
                  {s.fullName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {msg && !err && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">✓ {msg}</div>}
      {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {placing && (
        <div className="flex items-center justify-between rounded-lg border border-gold-500 bg-gold-100 px-3 py-2 text-sm text-slate-800">
          <span>
            กำลังลงชดเชย <b>{subjectOf(placing)?.subjectCode} {subjectOf(placing)?.subjectName}</b> ({groupsText(placing)}) — คลิกช่องสีเขียวในสัปดาห์นี้ (รวมเสาร์–อาทิตย์) หรือเลื่อนไปสัปดาห์อื่น
          </span>
          <button type="button" onClick={() => setPlacingId(null)} className="rounded p-1 hover:bg-white/60" aria-label="ยกเลิกการลงชดเชย">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_21rem]">
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-indigo-900 text-white">
                <th className="sticky left-0 z-10 bg-indigo-900 px-3 py-2 text-left font-semibold">วัน</th>
                {periods.map((t) => (
                  <th key={t.period} className={`px-2 py-2 text-center font-semibold ${t.period === lunch ? 'bg-gold-500 text-indigo-950' : ''}`}>
                    คาบ {t.period}
                    <div className="text-[10px] font-normal opacity-80">{t.period === lunch ? 'พักกลางวัน' : `${t.startTime.slice(0, 5)}–${t.endTime.slice(0, 5)}`}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => {
                const date = addDays(weekStart, day - 1);
                const weekend = day >= 6;
                return (
                  <tr key={day} className={weekend ? 'bg-slate-50/70' : ''}>
                    <th className={`sticky left-0 z-10 border border-slate-200 px-3 text-left ${weekend ? 'bg-gold-100' : 'bg-slate-50'} ${date === today ? 'text-indigo-800' : 'text-slate-700'}`}>
                      <div className="font-bold">{DAY_NAMES_TH[day]}</div>
                      <div className="text-[10px] font-normal text-slate-500">{thDate(date)}</div>
                      {weekend && <div className="text-[10px] font-normal text-gold-600">วันสอนชดเชย</div>}
                    </th>
                    {blocksOf(day).map(({ period, span, here }) => {
                      const m = moveAt.get(`${day}:${period}`);
                      const actionable = !!m && !!(placing ?? (selected && canAct(selected)));
                      const tone = actionable ? (m!.ok ? 'bg-emerald-50 hover:bg-emerald-100 cursor-pointer' : 'bg-slate-100') : period === lunch && span === 1 ? 'bg-gold-100/50' : '';
                      return (
                        <td
                          key={period}
                          colSpan={span}
                          title={actionable && !m!.ok ? m!.reason : undefined}
                          onClick={() => actionable && clickCell(day, period)}
                          className={`h-16 min-w-28 border border-slate-200 p-1 align-top ${tone}`}
                        >
                          <div className="flex h-full flex-col gap-1">
                            {here.map((o) => {
                              const s = subjectOf(o);
                              const sw = swapWith.get(o.id);
                              const ring =
                                o.id === selectedId
                                  ? 'ring-2 ring-indigo-600 border-indigo-600'
                                  : selected && sw && canAct(selected)
                                    ? sw.ok
                                      ? 'ring-2 ring-sky-500 border-sky-400'
                                      : 'opacity-45'
                                    : '';
                              const unit = unitOf(o);
                              const badge = BADGE[o.kind];
                              return (
                                <button
                                  key={o.id}
                                  type="button"
                                  title={selected && sw && !sw.ok ? sw.reason : undefined}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    clickCard(o);
                                  }}
                                  className={`flex min-h-14 flex-1 flex-col items-center justify-center rounded-md border px-2 py-1 text-center text-[11px] leading-snug ${colorOf(s?.id ?? o.item.offeringId)} ${ring}`}
                                >
                                  {badge && <span className={`mb-0.5 rounded px-1.5 text-[10px] font-semibold ${badge.cls}`}>{badge.text}</span>}
                                  <span className="font-semibold text-slate-800">
                                    {s?.subjectCode} {s?.subjectName}
                                  </span>
                                  <span className="text-slate-500">
                                    {[view !== 'teacher' ? teachers(o) : '', view !== 'group' ? groupsText(o) : '', view !== 'room' ? roomText(o) : ''].filter(Boolean).join(' · ')}
                                  </span>
                                  {unit && <span className="mt-0.5 text-[10px] text-indigo-700">📘 {unit}</span>}
                                </button>
                              );
                            })}
                            {actionable && m!.ok && here.length === 0 && <span className="pt-3 text-center text-[10px] font-semibold text-emerald-700">ลงที่นี่</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="space-y-4">
          {selected && (
            <section className="rounded-xl border-2 border-indigo-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-indigo-700">คาบที่เลือก · {slotText(selected.date, selected.period)}</div>
                  <div className="font-bold text-slate-900">
                    {subjectOf(selected)?.subjectCode} {subjectOf(selected)?.subjectName}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {groupsText(selected)} · {teachers(selected)} · {roomText(selected)} · {selected.item.duration} คาบ
                  </div>
                </div>
                <button type="button" onClick={() => setSelectedId(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="ยกเลิกการเลือก">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-3 rounded-lg bg-indigo-50/60 p-2 text-xs">
                <div className="flex items-center gap-1 font-semibold text-indigo-800">
                  <BookOpen className="h-3.5 w-3.5" /> หน่วยการเรียน สัปดาห์ที่ {termWeekOf(weekly.termStart, selected.originalDate)}
                </div>
                {unitDraft === null ? (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-slate-700">{unitOf(selected) ?? 'ยังไม่ได้กำหนด'}</span>
                    {canAct(selected) && (
                      <button type="button" onClick={() => setUnitDraft(unitOf(selected) ?? '')} className="shrink-0 text-indigo-700 underline">
                        แก้ไข
                      </button>
                    )}
                  </div>
                ) : (
                  <form
                    className="mt-1 flex gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveUnit(selected, unitDraft);
                    }}
                  >
                    <input
                      autoFocus
                      value={unitDraft}
                      onChange={(e) => setUnitDraft(e.target.value)}
                      maxLength={300}
                      placeholder="เช่น หน่วยที่ 3 ตัวแปรและชนิดข้อมูล"
                      className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1"
                    />
                    <button type="submit" className="rounded bg-indigo-700 px-2 text-white" aria-label="บันทึกหน่วยการเรียน">
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </form>
                )}
                <p className="mt-1 text-[10px] text-slate-500">เนื้อหาผูกกับสัปดาห์เดิมของคาบ — ย้ายหรือชดเชยแล้วเนื้อหาตามไปด้วย</p>
              </div>

              {!canAct(selected) ? (
                <p className="mt-3 text-xs text-slate-500">
                  {role === 'teacher' && !me ? 'เลือก "ใช้งานในนามครู" ด้านบนก่อน' : 'คุณดูได้อย่างเดียว — ปรับได้เฉพาะคาบที่ตนเองสอน หรือผู้จัดตาราง'}
                </p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.exception && (
                      <button type="button" onClick={() => restore(selected)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
                        <RotateCcw className="h-3.5 w-3.5" /> คืนตามตารางหลัก
                      </button>
                    )}
                    {!selected.item.isLocked && (
                      <button type="button" onClick={() => cancel(selected)} className="inline-flex items-center gap-1 rounded-md border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50">
                        <XCircle className="h-3.5 w-3.5" /> งดสอน (ครูไม่ว่าง) → คาบค้าง
                      </button>
                    )}
                    <button type="button" onClick={() => setShowPermanent(!showPermanent)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
                      <CalendarClock className="h-3.5 w-3.5" /> {isAdmin ? 'ย้ายถาวร' : 'ขอย้ายถาวร'}
                    </button>
                  </div>

                  {showPermanent && (
                    <div className="mt-2 rounded-lg border border-slate-200 p-2">
                      <div className="text-xs font-semibold text-slate-700">
                        {isAdmin ? 'ย้ายในตารางหลัก (มีผลทุกสัปดาห์):' : 'เลือกช่องที่ต้องการ — คำขอจะส่งถึงผู้จัดตารางเพื่ออนุมัติ:'}
                      </div>
                      <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                        {permanentMoves.length === 0 && <span className="text-xs text-slate-500">ไม่มีช่องว่างในตารางหลัก</span>}
                        {permanentMoves.map((m) => (
                          <button key={`${m.day}:${m.period}`} type="button" onClick={() => permanent(selected, m.day, m.period)} className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] hover:bg-slate-50">
                            {DAY_SHORT[m.day]} คาบ {m.period}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <h3 className="mt-4 flex items-center gap-1.5 text-sm font-bold text-emerald-800">
                    <MoveRight className="h-4 w-4" /> ย้ายเฉพาะสัปดาห์นี้ ({okMoves.length})
                  </h3>
                  <div className="mt-1.5 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                    {okMoves.length === 0 && <span className="text-xs text-slate-500">ไม่มีช่องที่ครู กลุ่ม และห้องว่างพร้อมกัน</span>}
                    {okMoves.map((m) => (
                      <button
                        key={`${m.day}:${m.period}`}
                        type="button"
                        onClick={() => moveTo(selected, addDays(weekStart, m.day - 1), m.period)}
                        className={`rounded-md border px-2 py-1 text-xs font-medium ${m.day >= 6 ? 'border-gold-500 bg-gold-100 text-slate-800' : 'border-emerald-300 bg-emerald-50 text-emerald-800'} hover:brightness-95`}
                      >
                        {DAY_SHORT[m.day]} คาบ {m.period}
                      </button>
                    ))}
                  </div>

                  <h3 className="mt-4 flex items-center gap-1.5 text-sm font-bold text-sky-800">
                    <ArrowRightLeft className="h-4 w-4" /> สลับกับคาบอื่นในสัปดาห์นี้ ({okSwaps.length})
                  </h3>
                  <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                    {okSwaps.length === 0 && <span className="text-xs text-slate-500">ไม่มีคาบที่สลับกันได้ทั้งสองฝั่ง</span>}
                    {okSwaps.map((s) => {
                      const o = occs.find((x) => x.id === s.otherItemId)!;
                      const needsPeer = !isAdmin && !(me && o.teacherIds.includes(me.id));
                      return (
                        <button key={s.otherItemId} type="button" onClick={() => swap(selected, o)} className="flex w-full items-center justify-between gap-2 rounded-md border border-sky-300 bg-sky-50 px-2 py-1.5 text-left text-xs hover:bg-sky-100">
                          <span>
                            <b className="text-sky-900">{slotText(o.date, o.period)}</b> · {subjectOf(o)?.subjectCode} · {teachers(o)}
                          </span>
                          {needsPeer && <Send className="h-3.5 w-3.5 shrink-0 text-sky-700" aria-label="ส่งคำขอ" />}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="flex items-center gap-1.5 font-bold text-slate-900">
              <Send className="h-4 w-4 text-indigo-700" /> คำขอที่รอคุณ ({forMe.length})
            </h2>
            {forMe.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">ไม่มีคำขอรอดำเนินการ</p>
            ) : (
              <ul className="mt-2 space-y-2 text-xs">
                {forMe.map((r) => (
                  <li key={r.id} className="rounded-lg border border-gold-500 bg-gold-100/60 p-2">
                    <div className="font-medium text-slate-800">{describe(r)}</div>
                    <div className="mt-0.5 text-slate-500">
                      จาก {nameOf(r.requestedBy)} · {STATUS[r.status]}
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      <button type="button" onClick={() => decide(r, true)} className="rounded bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700">
                        {r.status === 'pending_peer' ? 'ยอมรับสลับ' : 'อนุมัติ'}
                      </button>
                      <button type="button" onClick={() => decide(r, false)} className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50">
                        ปฏิเสธ
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {mine.length > 0 && (
              <>
                <h3 className="mt-3 text-xs font-semibold text-slate-600">คำขอที่ฉันส่ง</h3>
                <ul className="mt-1 space-y-1 text-[11px] text-slate-600">
                  {mine.map((r) => (
                    <li key={r.id} className="rounded bg-slate-50 px-2 py-1">
                      {describe(r)} — <b>{STATUS[r.status]}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="flex items-center gap-1.5 font-bold text-slate-900">
              <Inbox className="h-4 w-4 text-indigo-700" /> คาบค้างสอน ({owed.length})
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">คาบที่งดสอนแล้วยังไม่ได้ชดเชย — กด "ลงชดเชย" แล้วเลือกช่องว่าง (เสาร์–อาทิตย์ได้)</p>
            {owed.length === 0 ? (
              <p className="mt-2 text-xs text-emerald-700">ไม่มีคาบค้าง ✓</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-xs">
                {owed.map((o) => (
                  <li key={o.id} className={`rounded-lg border p-2 ${o.id === placingId ? 'border-gold-500 bg-gold-100' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="font-medium text-slate-800">
                      {subjectOf(o)?.subjectCode} {subjectOf(o)?.subjectName}
                    </div>
                    <div className="text-slate-500">
                      {groupsText(o)} · เดิม {DAY_SHORT[dayOfWeekOf(o.originalDate)]} {thDate(o.originalDate)} · {o.item.duration} คาบ
                      {unitOf(o) && <> · 📘 {unitOf(o)}</>}
                    </div>
                    {canAct(o) && (
                      <div className="mt-1 flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(null);
                            setPlacingId(o.id === placingId ? null : o.id);
                          }}
                          className="rounded bg-indigo-700 px-2 py-0.5 font-semibold text-white hover:bg-indigo-800"
                        >
                          {o.id === placingId ? 'ยกเลิก' : 'ลงชดเชย'}
                        </button>
                        <button type="button" onClick={() => restore(o)} className="text-slate-500 underline">
                          ยกเลิกการงดสอน
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {awayHere.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-bold text-slate-900">ไม่ได้สอนตามเวลาเดิมในสัปดาห์นี้ ({awayHere.length})</h2>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {awayHere.map((o) => (
                  <li key={o.id} className="rounded bg-slate-50 px-2 py-1">
                    {subjectOf(o)?.subjectCode} ({DAY_SHORT[dayOfWeekOf(o.originalDate)]} คาบ {o.item.startPeriod}) → {o.date ? slotText(o.date, o.period) : 'งดสอน (ค้างสอน)'}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
