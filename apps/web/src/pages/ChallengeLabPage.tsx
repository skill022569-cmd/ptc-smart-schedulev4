import { useEffect, useState } from 'react';
import { Plus, Sparkles, Trash2, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import type { ChallengeApplyResponse, ChallengeCategory, ChallengeImpactResponse, ChallengeRule } from '../types/ui';

const RULE_OPTIONS: Record<ChallengeCategory, Array<{ type: string; label: string; defaultParams: string }>> = {
  time: [
    { type: 'block_slots', label: 'ล็อกคาบกิจกรรม (H08)', defaultParams: '{"days":[3],"periods":[7,8]}' },
    { type: 'group_lunch', label: 'พักกลางวันเหลื่อมเวลา (H06)', defaultParams: '{"lunch_period":4}' },
    { type: 'group_days', label: 'จำกัดวันเรียน เช่น ทวิภาคี (H10)', defaultParams: '{"days":[1,2,3]}' },
    { type: 'add_slots', label: 'เพิ่มภาคค่ำ/เสาร์-อาทิตย์ (H16)', defaultParams: '{"days":[1,2,3,4,5],"periods":[10,11],"max_days":2}' },
  ],
  room: [
    { type: 'room_closed', label: 'ปิดห้อง/แล็บไฟดับ (H07)', defaultParams: '{"days":[3],"periods":[1,2,3,4]}' },
    { type: 'room_capacity', label: 'เปลี่ยนความจุห้อง (H04)', defaultParams: '{"capacity":25}' },
    { type: 'room_type_strict', label: 'บังคับห้องตรงประเภทเป็น Hard (H05)', defaultParams: '{}' },
    { type: 'building_gap', label: 'ย้ายอาคารต้องเว้นคาบ (H12)', defaultParams: '{"gap":1}' },
  ],
  subject: [
    { type: 'consecutive', label: 'บังคับเรียนคาบติดกันเป็น Hard (H09)', defaultParams: '{}' },
    { type: 'spread_days', label: 'กระจายวันไม่ซ้ำ (S02)', defaultParams: '{"weight":15}' },
    { type: 'time_of_day', label: 'บังคับช่วงเช้า/บ่าย (S03)', defaultParams: '{"preference":"morning","weight":12}' },
  ],
  teacher: [
    { type: 'teacher_day_off', label: 'วันหยุดเตรียมสอนของครู (H15)', defaultParams: '{"day":5}' },
    { type: 'teacher_limits', label: 'จำกัดคาบสอนต่อวัน/ติดกัน (H13/H14)', defaultParams: '{"max_daily":6,"max_consecutive":3}' },
    { type: 'teacher_window', label: 'ครูพิเศษสอนได้เฉพาะบางคาบ (H07)', defaultParams: '{"days":[2,4],"periods":[6,7,8]}' },
  ],
};

export function ChallengeLabPage({ profile, onApplied }: { profile: string; onApplied: () => void }) {
  const [rules, setRules] = useState<ChallengeRule[]>(() => api.getCachedChallengeRules()?.rules ?? []);
  const [category, setCategory] = useState<ChallengeCategory>('time');
  const [ruleType, setRuleType] = useState('block_slots');
  const [description, setDescription] = useState('ล็อกพุธบ่ายทำกิจกรรม อวท.');
  const [paramsText, setParamsText] = useState('{"days":[3],"periods":[7,8]}');
  const [impact, setImpact] = useState<ChallengeImpactResponse | null>(null);
  const [applied, setApplied] = useState<ChallengeApplyResponse | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const refresh = async (force = false) => {
    try {
      const [res, imp] = await Promise.all([api.challengeRules(force), api.evaluateChallenge(profile)]);
      setRules(res.rules);
      setImpact(imp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, [profile]);

  const onCategoryChange = (cat: ChallengeCategory) => {
    setCategory(cat);
    const first = RULE_OPTIONS[cat][0]!;
    setRuleType(first.type);
    setParamsText(first.defaultParams);
    setDescription(first.label);
  };

  const addRule = async () => {
    setErr('');
    try {
      await api.addChallengeRule({
        category,
        ruleType,
        target: { all: true },
        params: JSON.parse(paramsText) as Record<string, unknown>,
        mode: 'hard',
        description,
      });
      await refresh(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const applyStrategy = async (strategy: 'repair' | 'full_resolve') => {
    setBusy(strategy);
    setErr('');
    try {
      const res = await api.applyChallenge(strategy, profile);
      setApplied(res);
      await refresh(true);
      onApplied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Lucky Challenge Lab (Rule Builder &amp; Before/After)</h1>
        <p className="text-sm text-slate-500">เพิ่มเงื่อนไขฉลาก 4 หมวดโดยไม่ต้องแก้โค้ด ตรวจผลกระทบทันที แล้วสั่ง Repair หรือจัดใหม่ (หัวข้อ 3)</p>
      </div>

      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</div>}

      <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="flex items-center gap-1.5 font-bold text-slate-900">
            <Sparkles className="h-4 w-4 text-amber-500" /> สร้างเงื่อนไขใหม่ (Rule Builder)
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="font-medium text-slate-700">หมวด</span>
              <select value={category} onChange={(e) => onCategoryChange(e.target.value as ChallengeCategory)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
                <option value="time">1. วันและเวลา</option>
                <option value="room">2. ห้องเรียน</option>
                <option value="subject">3. รายวิชา</option>
                <option value="teacher">4. ครูผู้สอน</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="font-medium text-slate-700">ชนิดเงื่อนไข</span>
              <select
                value={ruleType}
                onChange={(e) => {
                  const opt = RULE_OPTIONS[category].find((o) => o.type === e.target.value);
                  setRuleType(e.target.value);
                  if (opt) {
                    setParamsText(opt.defaultParams);
                    setDescription(opt.label);
                  }
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {RULE_OPTIONS[category].map((o) => <option key={o.type} value={o.type}>{o.label}</option>)}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">คำอธิบายตามฉลาก</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">พารามิเตอร์ JSON</span>
            <input value={paramsText} onChange={(e) => setParamsText(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 font-mono text-xs px-3 py-2" />
          </label>
          <button onClick={() => void addRule()} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            <Plus className="h-4 w-4" /> เพิ่มเงื่อนไข &amp; ตรวจผลกระทบ
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-900">เงื่อนไขที่เปิดใช้อยู่ ({rules.length})</h2>
            <div className="flex gap-2">
              <button disabled={Boolean(busy)} onClick={() => void applyStrategy('repair')} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                <Wrench className="h-3.5 w-3.5" /> {busy === 'repair' ? 'กำลัง Repair...' : 'Repair (ย้ายน้อยสุด)'}
              </button>
              <button disabled={Boolean(busy)} onClick={() => void applyStrategy('full_resolve')} className="rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">
                {busy === 'full_resolve' ? 'กำลังจัดใหม่...' : 'จัดใหม่ทั้งหมด'}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <div>
                  <span className="font-mono font-bold text-indigo-700">[{r.category}] {r.ruleType}</span>
                  <div className="text-slate-600">{r.description}</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void api
                      .deleteChallengeRule(r.id)
                      .then(() => refresh(true))
                      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
                  }
                  className="text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          {impact && (
            <div className={`rounded-lg border p-3 text-sm ${impact.violationCount === 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              ผลกระทบต่อตารางปัจจุบัน: ละเมิด <strong>{impact.violationCount}</strong> รายการ ({impact.violatedItemIds.length} คาบ · {impact.affectedGroupIds.length} กลุ่ม)
            </div>
          )}
        </div>
      </div>

      {applied && (
        <div className="rounded-xl border border-emerald-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-slate-900">รายงาน Before / After หลังรับเงื่อนไข Lucky Challenge</h2>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
              Hard: {applied.diff.beforeHardCount} → {applied.diff.afterHardCount} · ย้าย {applied.diff.movedCount} คาบ
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">คาบที่ย้าย</div><div className="text-xl font-bold">{applied.diff.movedCount}</div></div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Fitness</div><div className="text-xl font-bold">{applied.diff.beforeFitness} → {applied.diff.afterFitness}</div></div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">กลุ่มที่กระทบ</div><div className="text-xl font-bold">{applied.diff.affectedGroupCount}</div></div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">ครูที่กระทบ</div><div className="text-xl font-bold">{applied.diff.affectedTeacherCount}</div></div>
          </div>
          <div className="max-h-60 space-y-1.5 overflow-y-auto text-xs">
            {applied.diff.movedItems.map((m) => (
              <div key={m.itemId} className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
                {m.reasonTh}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
