import { useEffect, useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { PageSkeleton } from '../components/PageSkeleton';
import { api } from '../lib/api';
import type { ScheduleWorkspacePayload } from '../types/ui';

const STAFF_TYPE_TH: Record<string, string> = { teacher: 'ครูผู้สอน', guest_lecturer: 'ครูพิเศษ', staff: 'บุคลากรสนับสนุน' };

/** College staff directory with each person's weekly teaching load from the current timetable. */
export function StaffPage({ profile }: { profile: string }) {
  const [data, setData] = useState<ScheduleWorkspacePayload | null>(() => api.getCachedScheduleLatest(profile));
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');

  useEffect(() => {
    api.scheduleLatest(profile).then(setData, (e) => setErr(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ'));
  }, [profile]);

  const rows = useMemo(() => {
    if (!data) return [];
    const ctx = data.context;
    const durationOf = new Map(ctx.items.filter((i) => i.status === 'scheduled').map((i) => [i.id, i.duration]));
    const load = new Map<string, number>();
    for (const it of ctx.itemTeachers) load.set(it.staffId, (load.get(it.staffId) ?? 0) + (durationOf.get(it.itemId) ?? 0));
    const deptName = new Map(ctx.departments.map((d) => [d.id, d.name]));
    return ctx.staff
      .map((s) => ({ ...s, dept: (s.departmentId && deptName.get(s.departmentId)) || '-', load: load.get(s.id) ?? 0 }))
      .sort((a, b) => a.dept.localeCompare(b.dept, 'th') || a.fullName.localeCompare(b.fullName, 'th'));
  }, [data]);

  if (!data) return err ? <div className="rounded-xl border border-rose-200 bg-white p-6 text-sm text-rose-700">{err}</div> : <PageSkeleton cards={1} />;

  const depts = [...new Set(rows.map((r) => r.dept))];
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) => (!dept || r.dept === dept) && (!needle || `${r.fullName} ${r.employeeCode} ${r.position ?? ''}`.toLowerCase().includes(needle)),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <Users className="h-6 w-6 text-indigo-700" /> รายชื่อบุคลากร
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          บุคลากรทั้งหมด {rows.length} คน ใน {depts.length} แผนกวิชา พร้อมจำนวนคาบสอนต่อสัปดาห์จากตารางเรียนปัจจุบัน
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2">
        <label className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาชื่อ รหัส หรือตำแหน่ง"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"
          />
        </label>
        <select value={dept} onChange={(e) => setDept(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" aria-label="กรองตามแผนก">
          <option value="">ทุกแผนกวิชา</option>
          {depts.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-indigo-900 text-left text-white">
            <tr>
              <th className="px-4 py-2.5 font-semibold">รหัส</th>
              <th className="px-4 py-2.5 font-semibold">ชื่อ-นามสกุล</th>
              <th className="px-4 py-2.5 font-semibold">แผนกวิชา</th>
              <th className="px-4 py-2.5 font-semibold">ตำแหน่ง</th>
              <th className="px-4 py-2.5 font-semibold">ภาระสอน (คาบ/สัปดาห์)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((s) => {
              const max = s.maxWeeklyPeriods ?? 24;
              const pct = Math.min(100, Math.round((s.load / max) * 100));
              return (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono text-xs text-slate-500">{s.employeeCode}</td>
                  <td className="px-4 py-2 font-medium text-slate-900">{s.fullName}</td>
                  <td className="px-4 py-2 text-slate-600">{s.dept}</td>
                  <td className="px-4 py-2 text-slate-600">{s.position ?? STAFF_TYPE_TH[s.staffType ?? 'teacher']}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full ${s.load > max ? 'bg-rose-500' : 'bg-indigo-600'}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className={`text-xs ${s.load > max ? 'font-semibold text-rose-700' : 'text-slate-600'}`}>
                        {s.load} / {max}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  ไม่พบบุคลากรที่ตรงกับคำค้น
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
