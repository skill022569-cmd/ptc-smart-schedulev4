import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Layers, Play, RefreshCw, Sparkles, Users } from 'lucide-react';
import { api } from '../lib/api';
import type { DashboardData } from '../types/ui';

interface Props {
  profile: string;
  onNavigate: (tab: string) => void;
}

export function DashboardPage({ profile, onNavigate }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.dashboard(profile));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [profile]);

  const quickSolve = async () => {
    setBusy('กำลังรันจัดตารางอัตโนมัติ (CSP+GA)...');
    try {
      await api.runSolver({ algorithm: 'csp_ga', profileName: profile, seed: 2026, maxIterations: 10, timeLimitSec: 40 });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (loading && !data) {
    return <div className="rounded-xl bg-white p-8 text-center text-slate-500 shadow-sm">กำลังโหลดข้อมูลแดชบอร์ด...</div>;
  }

  const hardZero = (data?.report.hardCount ?? 0) === 0 && (data?.counts.scheduledItems ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">ภาพรวมระบบ (Dashboard)</h1>
          <p className="text-sm text-slate-500">
            ภาคเรียนที่ {data?.term.semester ?? 2}/{data?.term.academicYear ?? 2569} · โปรไฟล์{' '}
            <span className="font-semibold text-indigo-700">{profile}</span> · เวอร์ชัน{' '}
            <span className="font-medium">{data?.activeVersion?.name ?? 'ยังไม่มีตารางที่จัดแล้ว'}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" /> รีเฟรช
          </button>
          <button
            disabled={Boolean(busy)}
            onClick={() => void quickSolve()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Play className="h-4 w-4" /> {busy || 'จัดตารางใหม่ทันที'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Hard Violations</span>
            {hardZero ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900">{data?.report.hardCount ?? 0}</div>
          <div className="mt-1 text-xs text-slate-500">
            {hardZero ? 'ผ่านเงื่อนไขบังคับ 100%' : 'ต้องจัดตารางหรือกดแก้ขัดแย้ง'}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">ความครบชั่วโมงรายวิชา</span>
            <Layers className="h-5 w-5 text-indigo-600" />
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900">
            {data?.qualitySummary.scheduleCompleteness.completenessPct ?? 0}%
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {data?.qualitySummary.scheduleCompleteness.scheduledHours ?? 0} /{' '}
            {data?.qualitySummary.scheduleCompleteness.requiredHours ?? 0} คาบ (ถาดรอจัด {data?.counts.unplacedItems ?? 0})
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">ความพึงพอใจครู (S05/S06)</span>
            <Users className="h-5 w-5 text-sky-600" />
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900">
            {Math.round((data?.report.multiObjective.teacherSatisfaction ?? 0) * 100)}%
          </div>
          <div className="mt-1 text-xs text-slate-500">
            อัตราการใช้ห้อง {Math.round((data?.report.multiObjective.roomUtilization ?? 0) * 100)}%
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Fitness Score</span>
            <Activity className="h-5 w-5 text-violet-600" />
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900">{data?.report.fitness ?? 0}</div>
          <div className="mt-1 text-xs text-slate-500">Soft Penalty: {data?.report.totalPenalty ?? 0}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="font-semibold text-slate-900">ขนาดชุดข้อมูลในฐานข้อมูล TiDB ปัจจุบัน</h2>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            {[
              ['แผนกวิชา', data?.counts.departments ?? 0],
              ['กลุ่มเรียน', data?.counts.groups ?? 0],
              ['ครูผู้สอน', data?.counts.staff ?? 0],
              ['ห้องเรียน', data?.counts.rooms ?? 0],
              ['รายวิชา', data?.counts.subjects ?? 0],
              ['Offerings', data?.counts.offerings ?? 0],
            ].map(([label, val]) => (
              <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{val}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="font-semibold text-slate-900">ทางลัดการทำงานสำหรับกรรมการ</h2>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button onClick={() => onNavigate('import')} className="rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50/40">
              <div className="font-semibold text-slate-800">1. นำเข้า 7 CSV &amp; Data Check</div>
              <div className="text-xs text-slate-500">ตรวจความสัมพันธ์ข้ามไฟล์ + แก้ Column Mapping</div>
            </button>
            <button onClick={() => onNavigate('quality')} className="rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50/40">
              <div className="font-semibold text-slate-800">2. สรุปผลตรวจ 4 ด้าน</div>
              <div className="text-xs text-slate-500">พิสูจน์ Hard 10 ข้อ = 0 และชั่วโมงครบ 100%</div>
            </button>
            <button onClick={() => onNavigate('challenge')} className="rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50/40">
              <div className="flex items-center gap-1 font-semibold text-slate-800"><Sparkles className="h-4 w-4 text-amber-500" /> 3. Lucky Challenge Lab</div>
              <div className="text-xs text-slate-500">เพิ่มเงื่อนไข 4 หมวด + Repair &amp; Before/After</div>
            </button>
            <button onClick={() => onNavigate('views')} className="rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50/40">
              <div className="font-semibold text-slate-800">4. ดูตาราง &amp; Export PDF/Excel</div>
              <div className="text-xs text-slate-500">มุมมองกลุ่ม/ครู/ห้อง/รวม + PDF ฟอนต์ Sarabun</div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
