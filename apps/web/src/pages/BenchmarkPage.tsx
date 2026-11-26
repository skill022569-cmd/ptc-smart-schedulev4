import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import type { BenchmarkResultRow } from '../types/ui';

export function BenchmarkPage() {
  const [results, setResults] = useState<BenchmarkResultRow[]>([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    setRunning(true);
    setErr('');
    try {
      const res = await api.runBenchmark({
        algorithms: ['greedy', 'csp_ga', 'csp_sa'],
        profiles: ['competition', 'teacher_first', 'room_first'],
        seeds: [101, 202, 303],
        maxIterations: 8,
      });
      setResults(res.results);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const chartData = results.map((r) => ({
    label: `${r.algorithm} (${r.profileName})`,
    fitness: r.summary.fitness.mean,
    teacherSat: r.summary.teacherSat,
    roomUtil: r.summary.roomUtil,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Benchmark &amp; Multi-Objective Comparison</h1>
          <p className="text-sm text-slate-500">เปรียบเทียบ Greedy vs CSP+GA vs CSP+SA หลาย Seed และโปรไฟล์เน้นครู vs เน้นห้อง (โจทย์ 23, 25)</p>
        </div>
        <button disabled={running} onClick={() => void run()} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          <BarChart3 className="h-4 w-4" /> {running ? 'กำลังรัน 3 Seed...' : 'รัน Benchmark (3 Seeds)'}
        </button>
      </div>

      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</div>}

      {results.length > 0 && (
        <>
          <div className="h-80 rounded-xl border border-slate-200 bg-white p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="fitness" name="Fitness (เฉลี่ย)" fill="#4f46e5" />
                <Bar dataKey="teacherSat" name="ความพึงพอใจครู (%)" fill="#0284c7" />
                <Bar dataKey="roomUtil" name="อัตราการใช้ห้อง (%)" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Algorithm</th>
                  <th className="px-4 py-2.5">Profile</th>
                  <th className="px-4 py-2.5">Hard (Mean ± SD)</th>
                  <th className="px-4 py-2.5">Fitness (Mean ± SD)</th>
                  <th className="px-4 py-2.5">Penalty (Mean ± SD)</th>
                  <th className="px-4 py-2.5">เวลา (ms)</th>
                  <th className="px-4 py-2.5">ครู / ห้อง (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {results.map((r, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2.5 font-mono font-bold">{r.algorithm}</td>
                    <td className="px-4 py-2.5">{r.profileName}</td>
                    <td className="px-4 py-2.5">{r.summary.hardCount.mean} ± {r.summary.hardCount.sd}</td>
                    <td className="px-4 py-2.5 font-semibold text-indigo-700">{r.summary.fitness.mean} ± {r.summary.fitness.sd}</td>
                    <td className="px-4 py-2.5">{r.summary.penalty.mean} ± {r.summary.penalty.sd}</td>
                    <td className="px-4 py-2.5">{r.summary.durationMs.mean} ± {r.summary.durationMs.sd}</td>
                    <td className="px-4 py-2.5">{r.summary.teacherSat}% / {r.summary.roomUtil}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
