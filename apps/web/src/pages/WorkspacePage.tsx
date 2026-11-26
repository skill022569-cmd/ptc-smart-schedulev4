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
import { Lock, RefreshCw, Unlock, Wand2 } from 'lucide-react';
import { DAY_NAMES_TH, OccupancyIndex, type ScheduleItem, type XaiExplanationEntry } from '@ptc/shared';
import { PageSkeleton } from '../components/PageSkeleton';
import { api } from '../lib/api';
import type { FixOption, ScheduleWorkspacePayload } from '../types/ui';

function DraggableCard({
  item,
  label,
  subLabel,
  selected,
  onSelect,
}: {
  item: ScheduleItem;
  label: string;
  subLabel: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onSelect();
        }
      }}
      className={`cursor-grab rounded-lg border p-2 text-xs shadow-xs transition active:cursor-grabbing ${
        selected ? 'border-indigo-600 bg-indigo-50 ring-2 ring-indigo-200' : 'border-slate-200 bg-white hover:border-indigo-300'
      } ${isDragging ? 'z-50 opacity-75' : ''}`}
    >
      <div className="flex items-center justify-between gap-1 font-semibold text-slate-800">
        <span className="truncate">{label}</span>
        {item.isLocked && <Lock className="h-3 w-3 shrink-0 text-amber-600" />}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-slate-500">{subLabel}</div>
    </div>
  );
}

function DroppableCell({
  id,
  highlight,
  children,
}: {
  id: string;
  highlight: 'ok' | 'clash' | 'none';
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const bg =
    highlight === 'ok'
      ? 'bg-emerald-50 border-emerald-300'
      : highlight === 'clash'
        ? 'bg-red-50 border-red-300'
        : 'bg-white border-slate-200';
  return (
    <td ref={setNodeRef} className={`min-w-28 border p-1.5 align-top transition ${bg} ${isOver ? 'ring-2 ring-indigo-500' : ''}`}>
      <div className="space-y-1">{children}</div>
    </td>
  );
}

export function WorkspacePage({ profile }: { profile: string }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const cachedInit = api.getCachedScheduleLatest(profile);
  const [data, setData] = useState<ScheduleWorkspacePayload | null>(() => cachedInit);
  const [loading, setLoading] = useState(() => !cachedInit);
  const [groupId, setGroupId] = useState(() => cachedInit?.context.studentGroups[0]?.id ?? '');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [fetchedXai, setFetchedXai] = useState<XaiExplanationEntry[] | null>(null);
  const [xaiLoading, setXaiLoading] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [fixOptions, setFixOptions] = useState<FixOption[] | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = async (force = false) => {
    const cached = !force ? api.getCachedScheduleLatest(profile) : null;
    if (cached) setData(cached);
    setLoading(!cached);
    setErr('');
    try {
      const res = await api.scheduleLatest(profile, force);
      setData(res);
      setGroupId((prev) => prev || res.context.studentGroups[0]?.id || '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'ไม่สามารถโหลดพื้นที่จัดตารางได้');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [profile]);

  useEffect(() => {
    const vId = data?.version?.id;
    if (!selectedItemId || !vId) {
      setFetchedXai(null);
      return;
    }
    let cancelled = false;
    setXaiLoading(true);
    void api
      .explainItem(vId, selectedItemId, profile)
      .then((res) => {
        if (!cancelled) setFetchedXai(res.explanations);
      })
      .catch(() => {
        if (!cancelled) setFetchedXai(null);
      })
      .finally(() => {
        if (!cancelled) setXaiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedItemId, data?.version?.id, profile]);

  const occupancy = useMemo(() => {
    if (!data) return null;
    const occ = new OccupancyIndex(data.context.subgroups);
    const roomById = new Map(data.context.rooms.map((r) => [r.id, r]));
    const groupById = new Map(data.context.studentGroups.map((g) => [g.id, g]));
    const subById = new Map(data.context.subgroups.map((sg) => [sg.id, sg]));
    const gByOff = new Map<string, string[]>();
    for (const og of data.context.offeringGroups) {
      const l = gByOff.get(og.offeringId) ?? [];
      l.push(og.groupId);
      gByOff.set(og.offeringId, l);
    }
    const tByItem = new Map<string, string[]>();
    for (const it of data.context.itemTeachers) {
      const l = tByItem.get(it.itemId) ?? [];
      l.push(it.staffId);
      tByItem.set(it.itemId, l);
    }
    for (const item of data.context.items) {
      if (item.status === 'unplaced_tray' || item.dayOfWeek == null || item.startPeriod == null) continue;
      const gIds = gByOff.get(item.offeringId) ?? [];
      const studentCount = item.subgroupId
        ? subById.get(item.subgroupId)?.studentCount ?? 0
        : gIds.reduce((s, gid) => s + (groupById.get(gid)?.studentCount ?? 0), 0);
      occ.addItem({
        itemId: item.id,
        day: item.dayOfWeek,
        startPeriod: item.startPeriod,
        duration: item.duration,
        teacherIds: tByItem.get(item.id) ?? [],
        groupIds: gIds,
        subgroupId: item.subgroupId,
        room: item.roomId ? roomById.get(item.roomId) ?? null : null,
        studentCount,
      });
    }
    return { occ, roomById, groupById, subById, gByOff, tByItem };
  }, [data]);

  if (loading && (!data || !occupancy)) return <PageSkeleton cards={2} />;
  if (err && (!data || !occupancy)) {
    return (
      <div className="rounded-xl border border-rose-200 bg-white p-6 text-center">
        <p className="text-sm font-medium text-rose-700">{err}</p>
        <button
          type="button"
          onClick={() => void load(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
        >
          <RefreshCw className="h-3.5 w-3.5" /> ลองใหม่
        </button>
      </div>
    );
  }
  if (!data || !occupancy) return <PageSkeleton cards={2} />;

  const offById = new Map(data.context.offerings.map((o) => [o.id, o]));
  const subjById = new Map(data.context.subjects.map((s) => [s.id, s]));
  const staffById = new Map(data.context.staff.map((s) => [s.id, s]));
  const selectedGroup = data.context.studentGroups.find((g) => g.id === groupId);

  const visibleItems = data.context.items.filter((i) => {
    const gIds = occupancy.gByOff.get(i.offeringId) ?? [];
    return i.status === 'scheduled' && gIds.includes(groupId);
  });
  const unplacedItems = data.context.items.filter((i) => i.status === 'unplaced_tray');

  const days = [1, 2, 3, 4, 5];
  const periods = data.context.timeSlots.map((t) => t.period).sort((a, b) => a - b);
  const openSlotSet = new Set(
    data.context.timeSlots.flatMap((t) => (t.openDays ?? []).map((d) => `${d}:${t.period}`)),
  );
  const isSlotWindowOpen = (day: number, startPeriod: number, duration: number): boolean => {
    for (let k = 0; k < duration; k++) {
      if (!openSlotSet.has(`${day}:${startPeriod + k}`)) return false;
    }
    return true;
  };

  const draggingItem = activeDragId ? data.context.items.find((i) => i.id === activeDragId) ?? null : null;

  const cellHighlight = (day: number, period: number): 'ok' | 'clash' | 'none' => {
    if (!draggingItem) return 'none';
    if (!isSlotWindowOpen(day, period, draggingItem.duration)) return 'clash';
    const gIds = occupancy.gByOff.get(draggingItem.offeringId) ?? [];
    const clashes = occupancy.occ.findClashes({
      itemId: draggingItem.id,
      day,
      startPeriod: period,
      duration: draggingItem.duration,
      teacherIds: occupancy.tByItem.get(draggingItem.id) ?? [],
      groupIds: gIds,
      subgroupId: draggingItem.subgroupId,
      room: draggingItem.roomId ? occupancy.roomById.get(draggingItem.roomId) ?? null : null,
    });
    return clashes.length === 0 ? 'ok' : 'clash';
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    if (!event.over || !data.version) return;
    const itemId = String(event.active.id);
    const overId = String(event.over.id);
    if (!overId.startsWith('cell:')) return;
    const [, dStr, pStr] = overId.split(':');
    const dayOfWeek = Number(dStr);
    const startPeriod = Number(pStr);
    const dragged = data.context.items.find((i) => i.id === itemId);
    if (dragged && dragged.status === 'scheduled' && dragged.dayOfWeek === dayOfWeek && dragged.startPeriod === startPeriod) {
      setSelectedItemId(itemId);
      setFixOptions(null);
      return;
    }
    if (dragged && !isSlotWindowOpen(dayOfWeek, startPeriod, dragged.duration)) {
      setErr(`ไม่สามารถวาง ${dragged.duration} คาบติดกันในวัน/คาบที่เลือกได้ (เกินเวลาเปิดสอนของวันนั้น)`);
      return;
    }
    setErr('');
    setMsg('');
    try {
      const res = await api.moveItem(data.version.id, itemId, { dayOfWeek, startPeriod, status: 'scheduled' });
      setMsg(`ย้ายคาบสำเร็จ (Hard Violations: ${res.report.hardCount}, Fitness: ${res.report.fitness})`);
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleLock = async (item: ScheduleItem) => {
    if (!data.version) return;
    setErr('');
    try {
      await api.moveItem(data.version.id, item.id, { isLocked: !item.isLocked });
      setMsg(item.isLocked ? 'ปลดล็อกคาบสอนแล้ว' : 'ปักหมุดคาบสอน (Lock) แล้ว');
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const openFix = async (item: ScheduleItem) => {
    if (!data.version) return;
    setErr('');
    try {
      const res = await api.fixOptions(data.version.id, item.id, profile);
      setFixOptions(res.options);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const applyFixOption = async (opt: FixOption) => {
    if (!data.version || !opt.changes[0]) return;
    setErr('');
    try {
      const ch = opt.changes[0];
      await api.moveItem(data.version.id, ch.itemId, {
        dayOfWeek: ch.day,
        startPeriod: ch.startPeriod,
        roomId: ch.roomId,
        status: 'scheduled',
      });
      setFixOptions(null);
      setMsg(`ใช้ตัวเลือก "${opt.labelTh}" สำเร็จ!`);
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedItem = selectedItemId ? data.context.items.find((i) => i.id === selectedItemId) ?? null : null;
  const selectedXai = selectedItem
    ? fetchedXai ?? data.report.itemExplanations[selectedItem.id] ?? selectedItem.explanation ?? []
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">พื้นที่จัดตารางลากวาง (Scheduler Workspace &amp; XAI)</h1>
          <p className="text-sm text-slate-500">ลากการ์ดเพื่อย้ายคาบ (สีเขียว = ว่าง / สีแดง = ชน) คลิกการ์ดเพื่อดูเหตุผล XAI หรือกดแก้ไข 1-Click</p>
        </div>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium">
          {data.context.studentGroups.map((g) => (
            <option key={g.id} value={g.id}>
              กลุ่ม {g.groupCode} ({g.level})
            </option>
          ))}
        </select>
      </div>

      {msg && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{msg}</div>}
      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white xl:col-span-3">
          <DndContext sensors={sensors} onDragStart={(e) => setActiveDragId(String(e.active.id))} onDragEnd={(e) => void handleDragEnd(e)}>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-100 text-slate-700">
                  <th className="border border-slate-200 px-3 py-2 text-left">วัน / คาบ</th>
                  {periods.map((p) => {
                    const ts = data.context.timeSlots.find((t) => t.period === p);
                    const isLunch = selectedGroup?.lunchPeriod === p;
                    return (
                      <th key={p} className={`border border-slate-200 px-2 py-2 text-center ${isLunch ? 'bg-amber-50 text-amber-800' : ''}`}>
                        <div>คาบ {p}</div>
                        <div className="text-[10px] font-normal text-slate-500">{ts?.startTime.slice(0, 5)}–{ts?.endTime.slice(0, 5)}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day}>
                    <td className="border border-slate-200 bg-slate-50 px-3 py-3 font-bold text-slate-700">
                      {DAY_NAMES_TH[day]}
                    </td>
                    {periods.map((period) => {
                      const cellItems = visibleItems.filter((i) => i.dayOfWeek === day && i.startPeriod === period);
                      return (
                        <DroppableCell key={period} id={`cell:${day}:${period}`} highlight={cellHighlight(day, period)}>
                          {cellItems.map((item) => {
                            const off = offById.get(item.offeringId);
                            const subj = off ? subjById.get(off.subjectId) : undefined;
                            const room = item.roomId ? occupancy.roomById.get(item.roomId)?.roomCode : '-';
                            const tNames = (occupancy.tByItem.get(item.id) ?? []).map((tid) => staffById.get(tid)?.fullName ?? '').join(', ');
                            return (
                              <DraggableCard
                                key={item.id}
                                item={item}
                                label={`${subj?.subjectCode ?? ''} (${item.duration}ชม.)`}
                                subLabel={`${room} · ${tNames}`}
                                selected={selectedItemId === item.id}
                                onSelect={() => {
                                  setSelectedItemId(item.id);
                                  setFixOptions(null);
                                }}
                              />
                            );
                          })}
                        </DroppableCell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </DndContext>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-bold text-slate-900">ช่องพักรายวิชา (Unplaced Tray: {unplacedItems.length})</h2>
            {unplacedItems.length === 0 ? (
              <p className="mt-2 text-xs text-emerald-700">จัดลงตารางครบทุกวิชาแล้ว</p>
            ) : (
              <div className="mt-2 space-y-2">
                {unplacedItems.map((u) => {
                  const off = offById.get(u.offeringId);
                  const subj = off ? subjById.get(off.subjectId) : undefined;
                  return (
                    <button key={u.id} onClick={() => setSelectedItemId(u.id)} className="w-full rounded-lg border border-red-200 bg-red-50 p-2 text-left text-xs">
                      <div className="font-semibold text-red-900">{subj?.subjectCode} {subj?.subjectName}</div>
                      <div className="text-red-700">{u.duration} คาบ · คลิกเพื่อดูทางแก้</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-bold text-slate-900">XAI อธิบายเหตุผล</h2>
            {!selectedItem ? (
              <p className="mt-2 text-xs text-slate-500">คลิกการ์ดวิชาในตารางเพื่อดูเหตุผลและเครื่องมือ 1-Click Fix</p>
            ) : (
              <div className="mt-2 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => void toggleLock(selectedItem)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
                    {selectedItem.isLocked ? <><Unlock className="h-3.5 w-3.5" /> ปลดล็อก</> : <><Lock className="h-3.5 w-3.5" /> ปักหมุด (Lock)</>}
                  </button>
                  <button onClick={() => void openFix(selectedItem)} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700">
                    <Wand2 className="h-3.5 w-3.5" /> ตัวเลือก 1-Click Fix
                  </button>
                </div>

                {fixOptions && (
                  <div className="space-y-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 p-2.5">
                    <div className="text-xs font-bold text-indigo-900">ตัวเลือกที่ผ่าน Validator (Hard = 0):</div>
                    {fixOptions.length === 0 ? (
                      <div className="text-xs text-slate-600">ไม่พบตำแหน่งย้ายเดี่ยว ลองใช้ Repair Agent ในหน้า Challenge Lab</div>
                    ) : (
                      fixOptions.map((opt) => (
                        <button key={opt.optionIndex} onClick={() => void applyFixOption(opt)} className="w-full rounded bg-white p-2 text-left text-xs shadow-xs hover:bg-indigo-100">
                          <div className="font-semibold text-indigo-800">{opt.labelTh}</div>
                          <div className="text-[11px] text-slate-500">ย้าย {opt.movedItemsCount} คาบ · ΔPenalty {opt.deltaPenalty}</div>
                        </button>
                      ))
                    )}
                  </div>
                )}

                <div className="max-h-64 space-y-1.5 overflow-y-auto text-xs">
                  {xaiLoading && <div className="text-slate-400">กำลังโหลดเหตุผล XAI รายคาบ...</div>}
                  {selectedXai.filter((e) => !e.passed).map((e, i) => (
                    <div key={`f-${i}`} className="rounded bg-amber-50 p-2 text-amber-900">
                      <span className="font-mono font-bold">{e.code}</span>: {e.messageTh}
                    </div>
                  ))}
                  {selectedXai.filter((e) => e.passed).slice(0, 6).map((e, i) => (
                    <div key={`p-${i}`} className="rounded bg-emerald-50 p-2 text-emerald-900">
                      <span className="font-mono font-bold">{e.code}</span>: {e.messageTh}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
