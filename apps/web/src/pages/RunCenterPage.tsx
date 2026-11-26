import { useEffect, useState } from 'react';
import { Bot, Play } from 'lucide-react';
import { api } from '../lib/api';
import type { RunResponse, SchedulingAlgorithm, SchedulingRun } from '../types/ui';

export function RunCenterPage({
  profile,
  onProfileChange,
  onCompleted,
}: {
  profile: string;
  onProfileChange: (p: string) => void;
  onCompleted: () => void;
}) {
  const cachedRuns = api.getCachedRuns();
  const [algorithm, setAlgorithm] = useState<SchedulingAlgorithm>('csp_ga');
  const [seed, setSeed] = useState(2026);
  const [maxIterations, setMaxIterations] = useState(12);
  const [runs, setRuns] = useState<SchedulingRun[]>(() => cachedRuns?.runs ?? []);
  const [profiles, setProfiles] = useState<string[]>(
    () => cachedRuns?.profiles ?? ['competition', 'default', 'teacher_first', 'room_first'],
  );
  const [latest, setLatest] = useState<RunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const loadRuns = async (force = false) => {
    try {
      const res = await api.runs(force);
      setRuns(res.runs);
      if (res.profiles.length > 0) setProfiles(res.profiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError('');
    try {
      const res = await api.runSolver({
        algorithm,
        profileName: profile,
        seed,
        maxIterations,
        timeLimitSec: 45,
      });
      setLatest(res);
      await loadRuns(true);
      onCompleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ศูนย์สั่งรันจัดตาราง (Run Center &amp; Agentic Pipeline)</h1>
        <p className="text-sm text-slate-500">รัน 4 Agent (Planner → Solver → Validator → Repair) พร้อม Seed คงที่ (ข้อกำหนด 1.4)</p>
      </div>

      <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">อัลกอริทึม</span>
          <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as SchedulingAlgorithm)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            <option value="csp_ga">CSP + GA (แนะนำ)</option>
            <option value="csp_sa">CSP + Simulated Annealing</option>
            <option value="greedy">Greedy (Baseline)</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">โปรไฟล์เงื่อนไข</span>
          <select value={profile} onChange={(e) => onProfileChange(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            {profiles.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">Seed (เลขสุ่มคงที่)</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">จำนวนรอบ (Iterations)</span>
          <input type="number" min={2} max={50} value={maxIterations} onChange={(e) => setMaxIterations(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>

        <div className="flex items-end">
          <button
            disabled={running}
            onClick={() => void handleRun()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Play className="h-4 w-4" /> {running ? 'กำลังประมวลผล...' : 'เริ่มจัดตาราง'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {latest && (
        <div className="rounded-xl border border-emerald-200 bg-white p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-bold text-slate-900">
              <Bot className="h-5 w-5 text-indigo-600" /> บันทึกการทำงาน 4 Agent ({latest.versionName})
            </h2>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              Hard: {latest.report.hardCount} · Fitness: {latest.report.fitness} · {latest.run.durationMs} ms
            </span>
          </div>
          <div className="mt-4 space-y-2">
            {latest.agentLog.map((entry, idx) => (
              <div key={idx} className="flex flex-col gap-1 rounded-lg bg-slate-50 px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
                <span className="w-24 shrink-0 font-mono text-xs font-bold uppercase text-indigo-700">{entry.agent}</span>
                <span className="text-slate-800">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-800">ประวัติการรันในฐานข้อมูล TiDB</div>
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Algorithm</th>
              <th className="px-4 py-2.5">Profile</th>
              <th className="px-4 py-2.5">Seed</th>
              <th className="px-4 py-2.5">Hard</th>
              <th className="px-4 py-2.5">Fitness</th>
              <th className="px-4 py-2.5">Unplaced</th>
              <th className="px-4 py-2.5">เวลา (ms)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 font-mono font-semibold">{r.algorithm}</td>
                <td className="px-4 py-2.5">{r.profileName}</td>
                <td className="px-4 py-2.5 font-mono">{r.seed}</td>
                <td className="px-4 py-2.5 font-semibold">{r.hardViolations ?? '-'}</td>
                <td className="px-4 py-2.5 font-semibold text-indigo-700">{r.fitness ?? '-'}</td>
                <td className="px-4 py-2.5">{r.unplacedCount ?? 0}</td>
                <td className="px-4 py-2.5">{r.durationMs ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
