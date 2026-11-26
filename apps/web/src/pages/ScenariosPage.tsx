import { useEffect, useState } from 'react';
import { Database, Play } from 'lucide-react';
import { api } from '../lib/api';
import type { ScenarioCatalogItem } from '../types/ui';

export function ScenariosPage({ profile, onLoaded }: { profile: string; onLoaded: () => void }) {
  const [items, setItems] = useState<ScenarioCatalogItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busyCode, setBusyCode] = useState('');
  const [msg, setMsg] = useState('');

  const refresh = async () => {
    const res = await api.scenarios();
    setItems(res.scenarios);
    setCounts(res.currentCounts);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const loadAndRun = async (code: string, autoRun: boolean) => {
    setBusyCode(code);
    setMsg('');
    try {
      const res = await api.loadScenario(code, autoRun, profile);
      setMsg(`โหลดชุดข้อมูล ${res.loadedDataset} (${res.totalRows} แถว) สำเร็จใน ${res.durationMs} ms${autoRun ? ' และจัดตารางอัตโนมัติแล้ว' : ''}`);
      await refresh();
      onLoaded();
    } catch (e) {
      setMsg(`เกิดข้อผิดพลาด: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyCode('');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ชุดข้อมูลทดสอบ Q01–Q25 (Scenarios)</h1>
        <p className="text-sm text-slate-500">
          ฐานข้อมูลปัจจุบัน: {counts.departments ?? 0} แผนก · {counts.groups ?? 0} กลุ่ม · {counts.staff ?? 0} ครู · {counts.rooms ?? 0} ห้อง · {counts.offerings ?? 0} Offerings
        </p>
      </div>

      {msg && <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">{msg}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="font-bold text-slate-900">Q01 — แผนกเดียว 4 กลุ่ม (ทดสอบเร็ว)</div>
          <p className="mt-1 text-sm text-slate-500">1 แผนก, 4 กลุ่มเรียน, 8 ครู, 6 ห้อง, 39 Offerings — เหมาะกับซ้อม Lucky Challenge</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button disabled={Boolean(busyCode)} onClick={() => void loadAndRun('Q01', false)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <Database className="h-4 w-4" /> โหลดข้อมูล Q01
            </button>
            <button disabled={Boolean(busyCode)} onClick={() => void loadAndRun('Q01', true)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              <Play className="h-4 w-4" /> {busyCode === 'Q01' ? 'กำลังดำเนินการ...' : 'โหลด Q01 + จัดตารางเลย'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="font-bold text-slate-900">Q21 — วิทยาลัยขนาดใหญ่ 10 แผนก (Benchmark 60 กลุ่ม)</div>
          <p className="mt-1 text-sm text-slate-500">10 แผนก, 60 กลุ่ม, 120 ครู, 70 ห้อง, 564 Offerings — พิสูจน์ความเร็ว &lt; 3 นาที</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button disabled={Boolean(busyCode)} onClick={() => void loadAndRun('Q21', false)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
              <Database className="h-4 w-4" /> โหลดข้อมูล Q21
            </button>
            <button disabled={Boolean(busyCode)} onClick={() => void loadAndRun('Q21', true)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              <Play className="h-4 w-4" /> {busyCode === 'Q21' ? 'กำลังดำเนินการ...' : 'โหลด Q21 + จัดตารางเลย'}
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-xs">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">รหัส</th>
              <th className="px-4 py-3">โจทย์จำลอง 25 ข้อ (คลังฝึก Lucky Challenge)</th>
              <th className="px-4 py-3">ส่วนของระบบ</th>
              <th className="px-4 py-3">สิ่งที่สาธิต</th>
              <th className="px-4 py-3 text-right">ทดลอง</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((s) => (
              <tr key={s.code} className="hover:bg-slate-50/70">
                <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700">{s.code}</td>
                <td className="px-4 py-2.5 font-medium text-slate-900">{s.title}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{s.focus}</td>
                <td className="px-4 py-2.5 text-slate-600">{s.demonstration}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    disabled={Boolean(busyCode)}
                    onClick={() => void loadAndRun(s.code, true)}
                    className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-indigo-600 hover:text-white disabled:opacity-50"
                  >
                    {busyCode === s.code ? '...' : `รัน (${s.loadableDataset})`}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
