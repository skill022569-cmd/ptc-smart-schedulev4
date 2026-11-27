import { useEffect, useState } from 'react';
import { Download, RefreshCw, Search } from 'lucide-react';
import { DAY_NAMES_TH, formatSlotTimeTh } from '@ptc/shared';
import { PageSkeleton } from '../components/PageSkeleton';
import { api } from '../lib/api';
import type { ScheduleWorkspacePayload } from '../types/ui';

type ViewKind = 'group' | 'teacher' | 'room' | 'master';

export function TimetableViewsPage({ profile }: { profile: string }) {
  const cachedInit = api.getCachedScheduleLatest(profile);
  const [data, setData] = useState<ScheduleWorkspacePayload | null>(() => cachedInit);
  const [loading, setLoading] = useState(() => !cachedInit);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewKind>('group');
  const [targetId, setTargetId] = useState(() => cachedInit?.context.studentGroups[0]?.id ?? '');
  const [query, setQuery] = useState('');

  const load = async (force = false) => {
    const cached = !force ? api.getCachedScheduleLatest(profile) : null;
    if (cached) setData(cached);
    setLoading(!cached);
    setError('');
    try {
      const res = await api.scheduleLatest(profile, force);
      setData(res);
      setTargetId((prev) => prev || res.context.studentGroups[0]?.id || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ไม่สามารถโหลดตารางสอนได้');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [profile]);

  if (loading && !data) return <PageSkeleton cards={2} />;
  if (error && !data) {
    return (
      <div className="rounded-xl border border-rose-200 bg-white p-6 text-center">
        <p className="text-sm font-medium text-rose-700">{error}</p>
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
  if (!data) return <PageSkeleton cards={2} />;

  const offById = new Map(data.context.offerings.map((o) => [o.id, o]));
  const subjById = new Map(data.context.subjects.map((s) => [s.id, s]));
  const roomById = new Map(data.context.rooms.map((r) => [r.id, r]));
  const staffById = new Map(data.context.staff.map((s) => [s.id, s]));
  const groupById = new Map(data.context.studentGroups.map((g) => [g.id, g]));
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

  const switchView = (next: ViewKind) => {
    setView(next);
    if (next === 'group') setTargetId(data.context.studentGroups[0]?.id ?? '');
    else if (next === 'teacher') setTargetId(data.context.staff[0]?.id ?? '');
    else if (next === 'room') setTargetId(data.context.rooms[0]?.id ?? '');
    else setTargetId('');
  };

  const rows = data.context.items
    .filter((item) => {
      if (item.status !== 'scheduled' || !item.dayOfWeek || !item.startPeriod) return false;
      const gIds = gByOff.get(item.offeringId) ?? [];
      const tIds = tByItem.get(item.id) ?? [];
      if (view === 'group' && targetId && !gIds.includes(targetId)) return false;
      if (view === 'teacher' && targetId && !tIds.includes(targetId)) return false;
      if (view === 'room' && targetId && item.roomId !== targetId) return false;
      if (query.trim()) {
        const off = offById.get(item.offeringId);
        const subj = off ? subjById.get(off.subjectId) : undefined;
        const text = `${subj?.subjectCode ?? ''} ${subj?.subjectName ?? ''} ${tIds.map((t) => staffById.get(t)?.fullName ?? '').join(' ')}`.toLowerCase();
        if (!text.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0) || (a.startPeriod ?? 0) - (b.startPeriod ?? 0));

  const studentGapTotal = data.report.softPenalties.find((s) => s.code === 'S01')?.rawPenalty ?? 0;
  const teacherGapTotal = data.report.softPenalties.find((s) => s.code === 'S08')?.rawPenalty ?? 0;
  const vId = data.version?.id;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">ตารางเรียนและส่งออกรายงาน</h1>
          <p className="text-sm text-slate-500">
            คาบว่างรวม: กลุ่มเรียน {studentGapTotal} คาบ · ครู {teacherGapTotal} คาบ (หัวข้อ 1.3)
          </p>
        </div>
        {vId && (
          <div className="flex flex-wrap gap-2">
            <a
              href={api.exportUrl(vId, 'output')}
              title="ไฟล์ผลลัพธ์ตามรูปแบบกรรมการ: group_id,timeslot_id,day,period,subject_id,teacher_id,room_id"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-700 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-800"
            >
              <Download className="h-3.5 w-3.5" /> output.csv (ส่งกรรมการ)
            </a>
            <a href={api.exportUrl(vId, 'csv', view, targetId)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Download className="h-3.5 w-3.5" /> CSV (ภาษาไทย)
            </a>
            <a href={api.exportUrl(vId, 'excel', view, targetId)} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100">
              <Download className="h-3.5 w-3.5" /> Excel (.xlsx)
            </a>
            <a href={api.exportUrl(vId, 'pdf', view, targetId)} className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700">
              <Download className="h-3.5 w-3.5" /> PDF (Sarabun)
            </a>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex rounded-lg bg-slate-100 p-1 text-xs font-semibold">
          {([
            ['group', 'รายกลุ่ม'],
            ['teacher', 'รายครู'],
            ['room', 'รายห้อง'],
            ['master', 'ตารางเรียนรวม'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => switchView(k)}
              className={`rounded-md px-3 py-1.5 ${view === k ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {view === 'group' && (
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
            {data.context.studentGroups.map((g) => <option key={g.id} value={g.id}>{g.groupCode}</option>)}
          </select>
        )}
        {view === 'teacher' && (
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
            {data.context.staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        )}
        {view === 'room' && (
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
            {data.context.rooms.map((r) => <option key={r.id} value={r.id}>{r.roomCode} (จุ {r.capacity})</option>)}
          </select>
        )}

        <div className="relative ml-auto min-w-52 flex-1 sm:flex-none">
          <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาวิชาหรือชื่อครู..."
            className="w-full rounded-lg border border-slate-300 py-1.5 pr-3 pl-9 text-sm"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5">วัน / เวลา</th>
              <th className="px-4 py-2.5">กลุ่มเรียน</th>
              <th className="px-4 py-2.5">รหัสวิชา / ชื่อวิชา</th>
              <th className="px-4 py-2.5">ครูผู้สอน</th>
              <th className="px-4 py-2.5">ห้อง</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const off = offById.get(r.offeringId);
              const subj = off ? subjById.get(off.subjectId) : undefined;
              const gNames = (gByOff.get(r.offeringId) ?? []).map((g) => groupById.get(g)?.groupCode ?? '').join(', ');
              const tNames = (tByItem.get(r.id) ?? []).map((t) => staffById.get(t)?.fullName ?? '').join(', ');
              const room = r.roomId ? roomById.get(r.roomId)?.roomCode ?? '-' : '-';
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-800">
                    {DAY_NAMES_TH[r.dayOfWeek!]} · {formatSlotTimeTh(r.dayOfWeek!, r.startPeriod!, r.duration, data.context.timeSlots)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{gNames}</td>
                  <td className="px-4 py-2.5">{subj?.subjectCode} {subj?.subjectName}</td>
                  <td className="px-4 py-2.5 text-slate-600">{tNames}</td>
                  <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700">{room}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  ยังไม่มีข้อมูลตารางสอน — ไปที่หน้า Run Center หรือ Scenarios เพื่อสั่งจัดตารางก่อน
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
