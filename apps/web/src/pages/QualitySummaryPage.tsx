import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { ScheduleWorkspacePayload } from '../types/ui';

export function QualitySummaryPage({ profile }: { profile: string }) {
  const [data, setData] = useState<ScheduleWorkspacePayload | null>(null);

  useEffect(() => {
    void api.scheduleLatest(profile).then(setData);
  }, [profile]);

  if (!data) return <div className="rounded-xl bg-white p-8 text-center text-slate-500">กำลังโหลดผลตรวจ 4 ด้าน...</div>;
  const q = data.qualitySummary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">สรุปผลตรวจคุณภาพตาราง 4 ด้าน (Quality Summary)</h1>
          <p className="text-sm text-slate-500">เวอร์ชัน: {data.version?.name ?? 'ยังไม่มี'} · โปรไฟล์: {q.profileName}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-bold ${q.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
          {q.passed ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {q.passed ? 'ผ่านเกณฑ์หลักครบทั้ง 4 ด้าน' : 'ยังไม่ครบหรือมีข้อขัดแย้ง'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">1. Conflict Detection</div>
          <div className="mt-2 text-2xl font-bold">{q.conflictDetection.totalClashes} คาบชน</div>
          <div className="mt-1 text-xs text-slate-500">
            ครู {q.conflictDetection.teacherClashes} · ห้อง {q.conflictDetection.roomClashes} · กลุ่ม {q.conflictDetection.groupClashes}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">2. Constraint Validation</div>
          <div className="mt-2 text-2xl font-bold">{q.constraintValidation.failedCodes.length} ข้อที่ละเมิด</div>
          <div className="mt-1 text-xs text-slate-500">
            {q.constraintValidation.passed ? 'Hard Constraints ผ่านทั้งหมด' : q.constraintValidation.failedCodes.join(', ')}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">3. Schedule Completeness</div>
          <div className="mt-2 text-2xl font-bold">{q.scheduleCompleteness.completenessPct}%</div>
          <div className="mt-1 text-xs text-slate-500">
            {q.scheduleCompleteness.scheduledHours}/{q.scheduleCompleteness.requiredHours} คาบ · ค้างถาด {q.scheduleCompleteness.unplacedCount}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">4. Performance &amp; Fitness</div>
          <div className="mt-2 text-2xl font-bold">{q.performance.softBreakdown.fitness}</div>
          <div className="mt-1 text-xs text-slate-500">
            Penalty: {q.performance.softBreakdown.totalPenalty} · RAM: {q.performance.memoryMb} MB
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 font-bold text-slate-900">รายการตรวจ Hard Constraints (H01–H21)</h2>
          <div className="space-y-1.5 text-sm">
            {q.constraintValidation.codes.map((c) => (
              <div key={c.code} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <div>
                  <span className="font-mono font-semibold text-slate-800">{c.code}</span>{' '}
                  <span className="text-slate-600">{c.nameTh}</span>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  c.status === 'pass' ? 'bg-emerald-100 text-emerald-700' :
                  c.status === 'fail' ? 'bg-red-100 text-red-700' :
                  c.status === 'soft' ? 'bg-sky-100 text-sky-700' : 'bg-slate-200 text-slate-600'
                }`}>
                  {c.status.toUpperCase()} ({c.violations})
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 font-bold text-slate-900">คะแนน Soft Constraints (เรียงตามน้ำหนัก)</h2>
          <div className="space-y-1.5 text-sm">
            {q.performance.softBreakdown.items.map((s) => (
              <div key={s.code} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <div>
                  <span className="font-mono font-semibold text-indigo-700">{s.code}</span>{' '}
                  <span className="text-slate-700">{s.nameTh}</span>
                </div>
                <div className="text-right text-xs text-slate-600">
                  ดิบ {s.rawPenalty} × W {s.weight} = <span className="font-bold text-slate-900">{s.weightedPenalty}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
