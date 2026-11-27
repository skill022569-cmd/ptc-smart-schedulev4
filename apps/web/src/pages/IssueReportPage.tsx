import { useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { api } from '../lib/api';
import type { IssueCategory, IssueReport, ScheduleWorkspacePayload } from '../types/ui';

export function IssueReportPage({ profile }: { profile: string }) {
  const cachedWs = api.getCachedScheduleLatest(profile);
  const cachedIssues = api.getCachedIssues();
  const [ws, setWs] = useState<ScheduleWorkspacePayload | null>(() => cachedWs);
  const [issues, setIssues] = useState<IssueReport[]>(() => cachedIssues?.issues ?? []);
  const [category, setCategory] = useState<IssueCategory>('teacher_leave');
  const [affectedDate, setAffectedDate] = useState('2026-11-25');
  const [affectedStaffId, setAffectedStaffId] = useState(() => cachedWs?.context.staff[0]?.id ?? '');
  const [affectedRoomId, setAffectedRoomId] = useState(() => cachedWs?.context.rooms[0]?.id ?? '');
  const [description, setDescription] = useState('ครูลาป่วยกระทันหัน ขอให้ Repair Agent หาครูแทน');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = async (force = false) => {
    try {
      const [sRes, iRes] = await Promise.all([api.scheduleLatest(profile, force), api.issues(force)]);
      setWs(sRes);
      setIssues(iRes.issues);
      if (!affectedStaffId && sRes.context.staff[0]) setAffectedStaffId(sRes.context.staff[0].id);
      if (!affectedRoomId && sRes.context.rooms[0]) setAffectedRoomId(sRes.context.rooms[0].id);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, [profile]);

  const submitIssue = async () => {
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api.createIssue({
        category,
        affectedDate,
        affectedStaffId: category === 'teacher_leave' ? affectedStaffId : null,
        affectedRoomId: category === 'room_outage' ? affectedRoomId : null,
        description,
      });
      setMsg('สร้างรายการแจ้งเหตุและให้ Repair Agent เสนอแผนแก้ไขรายวันแล้ว');
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyOption = async (issueId: string, optionIndex: number) => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.applyIssue(issueId, optionIndex);
      setMsg(`บันทึกแผนแก้ไขรายวันที่ (${res.action}, กระทบ ${res.appliedCount} คาบ) โดยไม่กระทบตารางหลักแล้ว`);
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">แจ้งปัญหาและปรับตารางรายวัน</h1>
        <p className="text-sm text-slate-500">จัดการครูลา/ห้องเสียเฉพาะวันที่ผ่านตาราง `schedule_exceptions` โดยไม่แตะต้องตารางหลัก</p>
      </div>

      {err && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{err}</div>}
      {msg && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{msg}</div>}

      <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="font-medium text-slate-700">ประเภทเหตุฉุกเฉิน</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as IssueCategory)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            <option value="teacher_leave">ครูลา / ไปราชการ</option>
            <option value="room_outage">ห้องเรียน / แล็บเสีย</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="font-medium text-slate-700">วันที่เกิดเหตุ</span>
          <input type="date" value={affectedDate} onChange={(e) => setAffectedDate(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>

        {category === 'teacher_leave' ? (
          <label className="text-sm">
            <span className="font-medium text-slate-700">ครูที่ลา</span>
            <select value={affectedStaffId} onChange={(e) => setAffectedStaffId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
              {ws?.context.staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
          </label>
        ) : (
          <label className="text-sm">
            <span className="font-medium text-slate-700">ห้องที่มีปัญหา</span>
            <select value={affectedRoomId} onChange={(e) => setAffectedRoomId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
              {ws?.context.rooms.map((r) => <option key={r.id} value={r.id}>{r.roomCode}</option>)}
            </select>
          </label>
        )}

        <div className="flex items-end">
          <button disabled={busy} onClick={() => void submitIssue()} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
            <AlertTriangle className="h-4 w-4" /> {busy ? 'กำลังวิเคราะห์...' : 'แจ้งเหตุ & ขอแผน Repair'}
          </button>
        </div>

        <label className="text-sm sm:col-span-2 lg:col-span-4">
          <span className="font-medium text-slate-700">รายละเอียด</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
      </div>

      <div className="space-y-3">
        {issues.map((iss) => {
          const prop = (iss.agentProposal ?? {}) as {
            affectedItemCount?: number;
            options?: Array<{ action: string; labelTh: string; movedItemsCount: number }>;
          };
          return (
            <div key={iss.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono text-xs font-bold uppercase text-amber-700">[{iss.category}]</span>{' '}
                  <span className="font-semibold text-slate-900">วันที่ {iss.affectedDate}</span> — {iss.description}
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold">{iss.status} (กระทบ {prop.affectedItemCount ?? 0} คาบ)</span>
              </div>
              {iss.status !== 'applied' && (prop.options?.length ?? 0) > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {prop.options!.map((opt, idx) => (
                    <button key={idx} onClick={() => void applyOption(iss.id, idx)} className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100">
                      <Check className="h-3.5 w-3.5" /> {opt.labelTh}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
