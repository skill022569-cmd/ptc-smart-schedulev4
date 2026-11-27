import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ArrowRightLeft, Inbox, Lock, MoveRight, Redo2, RefreshCw, Undo2, Unlock, X } from 'lucide-react';
import { DAY_NAMES_TH, planCellActions, type AccountRole, type ScheduleItem } from '@ptc/shared';
import { PageSkeleton } from '../components/PageSkeleton';
import { api, type ItemChange } from '../lib/api';
import type { ScheduleWorkspacePayload } from '../types/ui';

type View = 'group' | 'teacher' | 'room';
interface HistoryEntry {
  label: string;
  before: ItemChange[];
  after: ItemChange[];
  at: Date;
}

const SUBJECT_COLORS = [
  'bg-sky-50 border-sky-200',
  'bg-violet-50 border-violet-200',
  'bg-emerald-50 border-emerald-200',
  'bg-amber-50 border-amber-200',
  'bg-rose-50 border-rose-200',
  'bg-teal-50 border-teal-200',
  'bg-orange-50 border-orange-200',
  'bg-lime-50 border-lime-200',
];
const colorOf = (id: string) => SUBJECT_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SUBJECT_COLORS.length]!;
const DAY_SHORT: Record<number, string> = { 1: 'จ.', 2: 'อ.', 3: 'พ.', 4: 'พฤ.', 5: 'ศ.', 6: 'ส.', 7: 'อา.' };
const posOf = (i: ScheduleItem): ItemChange => ({
  itemId: i.id,
  dayOfWeek: i.dayOfWeek,
  startPeriod: i.startPeriod,
  status: i.status === 'unplaced_tray' ? 'unplaced_tray' : 'scheduled',
});

function Card({
  dragId,
  item,
  title,
  lines,
  color,
  state,
  hint,
  editable,
  continued,
  onClick,
}: {
  dragId: string;
  item: ScheduleItem;
  title: string;
  lines: string[];
  color: string;
  state: 'selected' | 'swap' | 'blocked' | 'normal';
  hint?: string;
  editable: boolean;
  continued?: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    data: { itemId: item.id },
    disabled: !editable || Boolean(item.isLocked),
  });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const ring =
    state === 'selected'
      ? 'ring-2 ring-indigo-600 border-indigo-600'
      : state === 'swap'
        ? 'ring-2 ring-sky-500 border-sky-400 bg-sky-100'
        : state === 'blocked'
          ? 'opacity-45'
          : '';
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      title={hint}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`rounded-md border p-1.5 text-left text-[11px] leading-snug shadow-xs transition ${color} ${ring} ${
        editable && !item.isLocked ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${isDragging ? 'z-50 opacity-80 shadow-lg' : ''} ${continued ? 'border-dashed' : ''}`}
    >
      <div className="flex items-start justify-between gap-1 font-semibold text-slate-800">
        <span className="line-clamp-2">{title}</span>
        {item.isLocked && <Lock className="mt-0.5 h-3 w-3 shrink-0 text-gold-600" aria-label="ล็อกไว้" />}
      </div>
      {lines.map((l) => (
        <div key={l} className="truncate text-slate-500">
          {l}
        </div>
      ))}
    </div>
  );
}

function Cell({
  id,
  tone,
  hint,
  onClick,
  children,
}: {
  id: string;
  tone: 'move' | 'blocked' | 'lunch' | 'none';
  hint?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const bg =
    tone === 'move'
      ? 'bg-emerald-50 hover:bg-emerald-100 cursor-pointer'
      : tone === 'blocked'
        ? 'bg-slate-100'
        : tone === 'lunch'
          ? 'bg-[repeating-linear-gradient(45deg,#fef9e7,#fef9e7_6px,#fdf2d0_6px,#fdf2d0_12px)]'
          : 'bg-white';
  return (
    <td
      ref={setNodeRef}
      title={hint}
      onClick={onClick}
      className={`h-20 min-w-32 border border-slate-200 p-1 align-top transition ${bg} ${isOver ? 'ring-2 ring-inset ring-indigo-500' : ''}`}
    >
      <div className="space-y-1">
        {children}
        {tone === 'move' && !children && <div className="pt-5 text-center text-[11px] font-semibold text-emerald-700">ย้ายมาที่นี่</div>}
      </div>
    </td>
  );
}

function Tray({ children, active }: { children: React.ReactNode; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'tray' });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-24 space-y-1.5 rounded-lg border-2 border-dashed p-2 transition ${
        isOver ? 'border-gold-500 bg-gold-100' : active ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200 bg-slate-50'
      }`}
    >
      {children}
    </div>
  );
}

export function WorkspacePage({ profile, role }: { profile: string; role: AccountRole }) {
  const canEdit = role === 'admin' || role === 'scheduler';
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [data, setData] = useState<ScheduleWorkspacePayload | null>(() => api.getCachedScheduleLatest(profile));
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(role === 'teacher' ? 'teacher' : 'group');
  const [targetId, setTargetId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pos, setPos] = useState(0);

  const load = async (force = false) => {
    setErr('');
    try {
      setData(await api.scheduleLatest(profile, force));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'โหลดตารางไม่สำเร็จ');
    }
  };
  useEffect(() => {
    void load();
  }, [profile]);

  const ctx = data?.context;
  const maps = useMemo(() => {
    if (!ctx) return null;
    const gByOff = new Map<string, string[]>();
    for (const og of ctx.offeringGroups) gByOff.set(og.offeringId, [...(gByOff.get(og.offeringId) ?? []), og.groupId]);
    const tByItem = new Map<string, string[]>();
    for (const it of ctx.itemTeachers) tByItem.set(it.itemId, [...(tByItem.get(it.itemId) ?? []), it.staffId]);
    return {
      gByOff,
      tByItem,
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

  const plan = useMemo(() => (ctx && selectedId ? planCellActions(ctx, selectedId) : null), [ctx, selectedId]);

  if (!data || !ctx || !maps) {
    return err ? (
      <div className="rounded-xl border border-rose-200 bg-white p-6 text-center text-sm text-rose-700">
        {err}
        <button type="button" onClick={() => void load(true)} className="ml-3 underline">
          ลองใหม่
        </button>
      </div>
    ) : (
      <PageSkeleton cards={2} />
    );
  }

  const versionId = data.version?.id;
  const inView = (i: ScheduleItem) =>
    view === 'group'
      ? (maps.gByOff.get(i.offeringId) ?? []).includes(target)
      : view === 'teacher'
        ? (maps.tByItem.get(i.id) ?? []).includes(target)
        : i.roomId === target;
  const subjectOf = (i: ScheduleItem) => maps.subj.get(maps.off.get(i.offeringId)?.subjectId ?? '');
  const teachersOf = (i: ScheduleItem) => (maps.tByItem.get(i.id) ?? []).map((t) => maps.staff.get(t)?.fullName ?? '').join(', ');
  const groupsOf = (i: ScheduleItem) => (maps.gByOff.get(i.offeringId) ?? []).map((g) => maps.group.get(g)?.groupCode ?? '').join(', ');
  const roomOf = (i: ScheduleItem) => (i.roomId ? `ห้อง ${maps.room.get(i.roomId)?.roomCode ?? ''}` : 'ไม่ระบุห้อง');
  const linesOf = (i: ScheduleItem) =>
    [view !== 'teacher' ? teachersOf(i) : '', view !== 'group' ? groupsOf(i) : '', view !== 'room' ? roomOf(i) : ''].filter(Boolean);
  const slotText = (day: number | null, p: number | null, d = 1) =>
    day && p ? `${DAY_NAMES_TH[day]} คาบ ${p}${d > 1 ? `–${p + d - 1}` : ''}` : 'ถาดรอจัด';

  const placed = ctx.items.filter((i) => i.status === 'scheduled' && i.dayOfWeek != null && i.startPeriod != null && inView(i));
  const tray = ctx.items.filter((i) => i.status === 'unplaced_tray');
  const trayHere = tray.filter(inView);
  const days = [...new Set(ctx.timeSlots.flatMap((t) => t.openDays ?? []))].sort((a, b) => a - b);
  const periods = [...ctx.timeSlots].sort((a, b) => a.period - b.period);
  const lunch = view === 'group' ? maps.group.get(target)?.lunchPeriod : undefined;
  const selected = selectedId ? (ctx.items.find((i) => i.id === selectedId) ?? null) : null;
  const moveAt = new Map((plan?.moves ?? []).map((m) => [`${m.day}:${m.period}`, m]));
  const swapWith = new Map((plan?.swaps ?? []).map((s) => [s.otherItemId, s]));

  const apply = async (label: string, before: ItemChange[], after: ItemChange[], record = true): Promise<boolean> => {
    if (!versionId) return false;
    setBusy(true);
    setErr('');
    try {
      await api.moveItems(versionId, after);
      if (record) {
        setHistory((h) => [...h.slice(0, pos), { label, before, after, at: new Date() }]);
        setPos((p) => p + 1);
      }
      setMsg(label);
      setSelectedId(null);
      await load(true);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const moveTo = (item: ScheduleItem, day: number, period: number) => {
    const opt = moveAt.get(`${day}:${period}`);
    if (selectedId !== item.id) return;
    if (!opt?.ok) {
      setErr(opt?.reason ?? 'ย้ายไปช่องนี้ไม่ได้');
      return;
    }
    void apply(
      `ย้าย ${subjectOf(item)?.subjectCode ?? ''} (${groupsOf(item)}) จาก ${slotText(item.dayOfWeek, item.startPeriod, item.duration)} → ${slotText(day, period, item.duration)}`,
      [posOf(item)],
      [{ itemId: item.id, dayOfWeek: day, startPeriod: period, status: 'scheduled' }],
    );
  };
  const swap = (a: ScheduleItem, b: ScheduleItem) =>
    void apply(
      `สลับ ${subjectOf(a)?.subjectCode ?? ''} (${slotText(a.dayOfWeek, a.startPeriod)}) ⇄ ${subjectOf(b)?.subjectCode ?? ''} (${slotText(b.dayOfWeek, b.startPeriod)})`,
      [posOf(a), posOf(b)],
      [
        { itemId: a.id, dayOfWeek: b.dayOfWeek, startPeriod: b.startPeriod, status: 'scheduled' },
        { itemId: b.id, dayOfWeek: a.dayOfWeek, startPeriod: a.startPeriod, status: 'scheduled' },
      ],
    );
  const toTray = (item: ScheduleItem) =>
    void apply(
      `นำ ${subjectOf(item)?.subjectCode ?? ''} (${groupsOf(item)}) ออกจาก ${slotText(item.dayOfWeek, item.startPeriod, item.duration)} ไปไว้ที่ถาดรอจัด`,
      [posOf(item)],
      [{ itemId: item.id, dayOfWeek: null, startPeriod: null, status: 'unplaced_tray' }],
    );
  const undo = () => {
    const e = history[pos - 1];
    if (!e) return;
    void apply(`ย้อนกลับ: ${e.label}`, [], e.before, false).then((ok) => ok && setPos(pos - 1));
  };
  const redo = () => {
    const e = history[pos];
    if (!e) return;
    void apply(`ทำซ้ำ: ${e.label}`, [], e.after, false).then((ok) => ok && setPos(pos + 1));
  };
  const toggleLock = async (item: ScheduleItem) => {
    if (!versionId) return;
    setBusy(true);
    try {
      await api.moveItem(versionId, item.id, { isLocked: !item.isLocked });
      setMsg(item.isLocked ? 'ปลดล็อกคาบแล้ว' : 'ล็อกคาบแล้ว (ย้าย/สลับไม่ได้)');
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCardClick = (item: ScheduleItem) => {
    setErr('');
    const s = selected && swapWith.get(item.id);
    if (canEdit && selected && s) {
      if (s.ok) swap(selected, item);
      else setErr(s.reason ?? 'สลับไม่ได้');
      return;
    }
    setSelectedId(selectedId === item.id ? null : item.id);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const itemId = (e.active.data.current as { itemId?: string } | undefined)?.itemId;
    const item = itemId ? ctx.items.find((i) => i.id === itemId) : undefined;
    if (!item || !e.over) return;
    const over = String(e.over.id);
    if (over === 'tray') {
      if (item.status !== 'unplaced_tray') toTray(item);
      return;
    }
    const [, d, p] = over.split(':');
    moveTo(item, Number(d), Number(p));
  };

  const cardState = (i: ScheduleItem): { state: 'selected' | 'swap' | 'blocked' | 'normal'; hint?: string } => {
    if (i.id === selectedId) return { state: 'selected' };
    const s = swapWith.get(i.id);
    if (!selected || !s) return { state: 'normal', hint: i.isLocked ? 'คาบนี้ถูกล็อก' : undefined };
    return s.ok ? { state: 'swap', hint: 'คลิกเพื่อสลับคาบกัน' } : { state: 'blocked', hint: s.reason };
  };

  const okMoves = (plan?.moves ?? []).filter((m) => m.ok);
  const okSwaps = (plan?.swaps ?? []).filter((s) => s.ok);
  const blocked = [...(plan?.swaps ?? []).filter((s) => !s.ok)];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">จัดการตารางเรียน</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            {canEdit
              ? 'คลิกคาบเรียน 1 ครั้ง ระบบจะหาช่องที่ย้ายได้ (สีเขียว) และคาบที่สลับกันได้ (กรอบสีฟ้า) ให้ทันที แล้วคลิกอีกครั้งเพื่อย้ายหรือสลับ ระบบไม่ยอมให้ตารางชนกันเด็ดขาด'
              : 'โหมดดูอย่างเดียว: บัญชีของคุณดูตารางได้แต่แก้ไขไม่ได้ (ผู้ดูแลระบบและผู้จัดตารางเท่านั้นที่แก้ไขได้)'}
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pos === 0 || busy}
              onClick={undo}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" /> ย้อนกลับ
            </button>
            <button
              type="button"
              disabled={pos >= history.length || busy}
              onClick={redo}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" /> ทำซ้ำ
            </button>
            <button
              type="button"
              onClick={() => void load(true)}
              className="rounded-lg border border-slate-300 bg-white p-2 hover:bg-slate-50"
              aria-label="โหลดใหม่"
            >
              <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
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
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === v ? 'bg-white text-indigo-800 shadow-xs' : 'text-slate-600'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={target}
          onChange={(e) => {
            setTargetId(e.target.value);
            setSelectedId(null);
          }}
          className="min-w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium"
          aria-label="เลือกตารางที่จะดู"
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex flex-wrap gap-3 px-2 text-xs text-slate-600">
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-emerald-300 bg-emerald-100" /> ย้ายไปได้</span>
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm ring-2 ring-sky-500" /> สลับได้</span>
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-slate-200" /> ทำไม่ได้ (ชี้เพื่อดูเหตุผล)</span>
          <span className="flex items-center gap-1"><Lock className="h-3 w-3 text-gold-600" /> ล็อก</span>
        </div>
      </div>

      {msg && !err && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">✓ {msg}</div>}
      {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      <DndContext sensors={sensors} onDragStart={(e) => setSelectedId((e.active.data.current as { itemId: string }).itemId)} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-indigo-900 text-white">
                  <th className="sticky left-0 z-10 bg-indigo-900 px-3 py-2 text-left font-semibold">วัน</th>
                  {periods.map((t) => (
                    <th key={t.period} className={`px-2 py-2 text-center font-semibold ${t.period === lunch ? 'bg-gold-500 text-indigo-950' : ''}`}>
                      คาบ {t.period}
                      <div className="text-[10px] font-normal opacity-80">
                        {t.period === lunch ? 'พักกลางวัน' : `${t.startTime.slice(0, 5)}–${t.endTime.slice(0, 5)}`}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day}>
                    <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-3 text-left font-bold text-slate-700">
                      {DAY_NAMES_TH[day]}
                    </th>
                    {periods.map(({ period }) => {
                      const here = placed.filter((i) => i.dayOfWeek === day && period >= i.startPeriod! && period < i.startPeriod! + i.duration);
                      const m = moveAt.get(`${day}:${period}`);
                      const tone = canEdit && selected && m ? (m.ok ? 'move' : 'blocked') : period === lunch ? 'lunch' : 'none';
                      return (
                        <Cell
                          key={period}
                          id={`cell:${day}:${period}`}
                          tone={tone}
                          hint={m && !m.ok ? m.reason : undefined}
                          onClick={canEdit && selected && m?.ok ? () => moveTo(selected, day, period) : undefined}
                        >
                          {here.map((i) => {
                            const subj = subjectOf(i);
                            const { state, hint } = cardState(i);
                            return (
                              <Card
                                key={i.id}
                                dragId={`${i.id}@${day}:${period}`}
                                item={i}
                                title={`${subj?.subjectCode ?? ''} ${subj?.subjectName ?? ''}`}
                                lines={period === i.startPeriod ? linesOf(i) : ['(ต่อ)']}
                                color={colorOf(subj?.id ?? i.offeringId)}
                                state={state}
                                hint={hint}
                                editable={canEdit}
                                continued={period !== i.startPeriod}
                                onClick={() => onCardClick(i)}
                              />
                            );
                          })}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="space-y-4">
            {selected && (
              <section className="rounded-xl border-2 border-indigo-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-indigo-700">คาบที่เลือก</div>
                    <div className="font-bold text-slate-900">
                      {subjectOf(selected)?.subjectCode} {subjectOf(selected)?.subjectName}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {slotText(selected.dayOfWeek, selected.startPeriod, selected.duration)} · {groupsOf(selected)} · {teachersOf(selected)} · {roomOf(selected)}
                    </div>
                  </div>
                  <button type="button" onClick={() => setSelectedId(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="ยกเลิกการเลือก">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {canEdit && (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void toggleLock(selected)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
                      >
                        {selected.isLocked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                        {selected.isLocked ? 'ปลดล็อก' : 'ล็อกคาบนี้'}
                      </button>
                      {selected.status !== 'unplaced_tray' && !selected.isLocked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => toTray(selected)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
                        >
                          <Inbox className="h-3.5 w-3.5" /> เอาออกไปถาดรอจัด
                        </button>
                      )}
                    </div>

                    <h3 className="mt-4 flex items-center gap-1.5 text-sm font-bold text-emerald-800">
                      <MoveRight className="h-4 w-4" /> ย้ายไปคาบว่าง ({okMoves.length})
                    </h3>
                    {okMoves.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">ไม่มีคาบที่ครู กลุ่มเรียน และห้องว่างพร้อมกัน</p>
                    ) : (
                      <div className="mt-1.5 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                        {okMoves.map((m) => (
                          <button
                            key={`${m.day}:${m.period}`}
                            type="button"
                            disabled={busy}
                            onClick={() => moveTo(selected, m.day, m.period)}
                            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                          >
                            {DAY_SHORT[m.day]} คาบ {m.period}
                          </button>
                        ))}
                      </div>
                    )}

                    <h3 className="mt-4 flex items-center gap-1.5 text-sm font-bold text-sky-800">
                      <ArrowRightLeft className="h-4 w-4" /> สลับกับคาบอื่น ({okSwaps.length})
                    </h3>
                    {okSwaps.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">ไม่มีคาบที่สลับกันได้ทั้ง 2 ฝั่ง</p>
                    ) : (
                      <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto">
                        {okSwaps.map((s) => {
                          const o = ctx.items.find((i) => i.id === s.otherItemId)!;
                          return (
                            <button
                              key={s.otherItemId}
                              type="button"
                              disabled={busy}
                              onClick={() => swap(selected, o)}
                              className="block w-full rounded-md border border-sky-300 bg-sky-50 px-2 py-1.5 text-left text-xs hover:bg-sky-100"
                            >
                              <span className="font-semibold text-sky-900">{slotText(s.day, s.period, o.duration)}</span>
                              <span className="text-slate-600"> · {subjectOf(o)?.subjectCode} · {teachersOf(o)}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {blocked.length > 0 && (
                      <details className="mt-3 text-xs text-slate-500">
                        <summary className="cursor-pointer">ทำไมสลับกับคาบอื่นไม่ได้ ({blocked.length})</summary>
                        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
                          {blocked.map((b) => (
                            <li key={b.otherItemId} className="rounded bg-slate-100 px-2 py-1">
                              {slotText(b.day, b.period)}: {b.reason}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </section>
            )}

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="flex items-center gap-1.5 font-bold text-slate-900">
                <Inbox className="h-4 w-4 text-indigo-700" /> ถาดคาบรอจัด ({trayHere.length}
                {tray.length !== trayHere.length ? ` จากทั้งหมด ${tray.length}` : ''})
              </h2>
              <p className="mb-2 mt-0.5 text-xs text-slate-500">
                {canEdit ? 'ลากคาบออกจากตารางมาวางที่นี่เพื่อเว้นที่ให้วิชาอื่น แล้วค่อยลากกลับลงช่องที่ว่าง' : 'คาบที่ยังไม่ได้ลงตาราง'}
              </p>
              <Tray active={Boolean(selected) && selected?.status !== 'unplaced_tray'}>
                {trayHere.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-400">ไม่มีคาบรอจัด</p>
                ) : (
                  trayHere.map((i) => {
                    const subj = subjectOf(i);
                    return (
                      <Card
                        key={i.id}
                        dragId={`tray:${i.id}`}
                        item={i}
                        title={`${subj?.subjectCode ?? ''} ${subj?.subjectName ?? ''}`}
                        lines={[`${i.duration} คาบ · ${groupsOf(i)}`, teachersOf(i)]}
                        color={colorOf(subj?.id ?? i.offeringId)}
                        state={i.id === selectedId ? 'selected' : 'normal'}
                        editable={canEdit}
                        onClick={() => onCardClick(i)}
                      />
                    );
                  })
                )}
              </Tray>
            </section>

            {canEdit && (
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="font-bold text-slate-900">ประวัติการย้าย/สลับ ({history.length})</h2>
                {history.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-400">ยังไม่มีการเปลี่ยนแปลงในรอบนี้</p>
                ) : (
                  <ol className="mt-2 max-h-64 space-y-1.5 overflow-y-auto text-xs">
                    {history
                      .map((h, idx) => ({ h, idx }))
                      .reverse()
                      .map(({ h, idx }) => (
                        <li key={idx} className={`rounded-md border-l-4 px-2 py-1.5 ${idx < pos ? 'border-indigo-500 bg-slate-50' : 'border-slate-200 text-slate-400 line-through'}`}>
                          <div>{h.label}</div>
                          <div className="text-[10px] text-slate-400">{h.at.toLocaleTimeString('th-TH')}</div>
                        </li>
                      ))}
                  </ol>
                )}
              </section>
            )}
          </aside>
        </div>
      </DndContext>
    </div>
  );
}
