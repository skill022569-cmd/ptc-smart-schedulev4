import { useEffect, useMemo, useState } from 'react';
import { BookOpen, GraduationCap, History, Mail, Pencil, Save, X } from 'lucide-react';
import { DAY_NAMES_TH, type Staff } from '@ptc/shared';
import { api, type StaffHistoryEntry, type StaffProfile } from '../lib/api';
import type { ScheduleWorkspacePayload } from '../types/ui';

type Ctx = ScheduleWorkspacePayload['context'];
type Editable = Omit<StaffProfile, 'employeeCode' | 'updatedAt'>;
const EMPTY: Editable = { nickname: '', email: '', education: '', workHistory: '', expertise: '', bio: '' };
const DAY_SHORT: Record<number, string> = { 1: 'จ.', 2: 'อ.', 3: 'พ.', 4: 'พฤ.', 5: 'ศ.', 6: 'ส.', 7: 'อา.' };
const slot = (s: StaffHistoryEntry['before']) =>
  !s || s.status === 'unplaced_tray' || !s.dayOfWeek ? 'ถาดรอจัด' : `${DAY_SHORT[s.dayOfWeek]} คาบ ${s.startPeriod}`;

const FIELDS: Array<{ key: keyof Editable; label: string; rows?: number; placeholder: string }> = [
  { key: 'nickname', label: 'ชื่อเล่น', placeholder: 'เช่น ครูเอ' },
  { key: 'email', label: 'อีเมลติดต่องาน', placeholder: 'name@college.ac.th' },
  { key: 'education', label: 'ประวัติการศึกษา', rows: 3, placeholder: 'เช่น ค.อ.บ. วิศวกรรมคอมพิวเตอร์ (2560)' },
  { key: 'workHistory', label: 'ประวัติการทำงาน', rows: 3, placeholder: 'เช่น ครูประจำแผนกคอมพิวเตอร์ธุรกิจ (2562–ปัจจุบัน)' },
  { key: 'expertise', label: 'ความเชี่ยวชาญ', rows: 2, placeholder: 'เช่น การเขียนโปรแกรม, ฐานข้อมูล' },
  { key: 'bio', label: 'แนะนำตัว', rows: 3, placeholder: 'ข้อความแนะนำตัวสั้น ๆ' },
];

/** Slide-over with a staff member's personal profile, teaching summary, weekly timetable and change history. */
export function StaffProfilePanel({
  staff,
  deptName,
  ctx,
  canEdit,
  onClose,
}: {
  staff: Staff;
  deptName: string;
  ctx: Ctx;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [history, setHistory] = useState<StaffHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Editable>(EMPTY);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .staffProfile(staff.employeeCode)
      .then((r) => {
        setProfile(r.profile);
        setHistory(r.history);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'โหลดโปรไฟล์ไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [staff.employeeCode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const teaching = useMemo(() => {
    const mine = new Set(ctx.itemTeachers.filter((t) => t.staffId === staff.id).map((t) => t.itemId));
    const items = ctx.items.filter((i) => mine.has(i.id));
    const off = new Map(ctx.offerings.map((o) => [o.id, o]));
    const subj = new Map(ctx.subjects.map((s) => [s.id, s]));
    const grp = new Map(ctx.studentGroups.map((g) => [g.id, g.groupCode]));
    const groupsOf = new Map<string, string[]>();
    for (const og of ctx.offeringGroups) groupsOf.set(og.offeringId, [...(groupsOf.get(og.offeringId) ?? []), grp.get(og.groupId) ?? '']);
    const subjectOf = (offeringId: string) => subj.get(off.get(offeringId)?.subjectId ?? '');
    const subjects = new Map<string, { code: string; name: string; groups: Set<string>; periods: number }>();
    for (const i of items) {
      const s = subjectOf(i.offeringId);
      if (!s) continue;
      const e = subjects.get(s.id) ?? { code: s.subjectCode, name: s.subjectName, groups: new Set(), periods: 0 };
      for (const g of groupsOf.get(i.offeringId) ?? []) e.groups.add(g);
      if (i.status === 'scheduled') e.periods += i.duration;
      subjects.set(s.id, e);
    }
    return { items, subjects: [...subjects.values()], subjectOf, groupsOf };
  }, [ctx, staff.id]);

  const load = teaching.items.filter((i) => i.status === 'scheduled').reduce((n, i) => n + i.duration, 0);
  const max = staff.maxWeeklyPeriods ?? 24;
  const days = [...new Set(ctx.timeSlots.flatMap((t) => t.openDays ?? []))].sort((a, b) => a - b);
  const periods = [...new Set(ctx.timeSlots.map((t) => t.period))].sort((a, b) => a - b);
  const at = (d: number, p: number) =>
    teaching.items.find((i) => i.status === 'scheduled' && i.dayOfWeek === d && p >= i.startPeriod! && p < i.startPeriod! + i.duration);
  const initials = staff.fullName.replace(/^(นาย|นางสาว|นาง|ดร\.|ว่าที่ร้อยตรี)\s*/, '').slice(0, 2);

  const startEdit = () => {
    setForm({
      nickname: profile?.nickname ?? '',
      email: profile?.email ?? '',
      education: profile?.education ?? '',
      workHistory: profile?.workHistory ?? '',
      expertise: profile?.expertise ?? '',
      bio: profile?.bio ?? '',
    });
    setErr('');
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.saveStaffProfile(staff.employeeCode, form);
      setProfile(r.profile);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`โปรไฟล์ ${staff.fullName}`}>
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-slate-50 shadow-2xl">
        <div className="bg-linear-to-r from-indigo-900 to-indigo-700 px-6 pb-5 pt-4 text-white">
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="ปิด">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-gold-400 bg-white text-2xl font-bold text-indigo-800">
              {initials}
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold">
                {staff.fullName}
                {profile?.nickname && <span className="ml-2 text-base font-normal text-gold-300">({profile.nickname})</span>}
              </h2>
              <div className="text-sm text-indigo-100">
                {staff.position ?? 'ครูผู้สอน'} · {deptName}
              </div>
              <div className="mt-1 font-mono text-xs text-indigo-200">รหัส {staff.employeeCode}</div>
              {profile?.email && (
                <a href={`mailto:${profile.email}`} className="mt-1 inline-flex items-center gap-1 text-xs text-gold-300 hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {profile.email}
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid grid-cols-3 gap-3">
            {[
              ['คาบสอน/สัปดาห์', `${load} / ${max}`],
              ['จำนวนรายวิชา', teaching.subjects.length],
              ['กลุ่มเรียนที่สอน', new Set(teaching.subjects.flatMap((s) => [...s.groups])).size],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-3 text-center">
                <div className={`text-xl font-bold ${label === 'คาบสอน/สัปดาห์' && load > max ? 'text-rose-700' : 'text-indigo-800'}`}>{value}</div>
                <div className="text-xs text-slate-500">{label}</div>
              </div>
            ))}
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 font-bold text-slate-900">
                <GraduationCap className="h-4 w-4 text-indigo-700" /> ประวัติส่วนตัว
              </h3>
              {canEdit && !editing && (
                <button type="button" onClick={startEdit} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50">
                  <Pencil className="h-3.5 w-3.5" /> แก้ไขประวัติ
                </button>
              )}
            </div>
            {loading ? (
              <p className="mt-2 text-sm text-slate-400">กำลังโหลด...</p>
            ) : err && !editing ? (
              <p className="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{err}</p>
            ) : editing ? (
              <div className="mt-3 space-y-3">
                {FIELDS.map((f) => (
                  <label key={f.key} className="block text-xs font-medium text-slate-700">
                    {f.label}
                    {f.rows ? (
                      <textarea
                        rows={f.rows}
                        value={form[f.key] ?? ''}
                        placeholder={f.placeholder}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal"
                      />
                    ) : (
                      <input
                        type={f.key === 'email' ? 'email' : 'text'}
                        value={form[f.key] ?? ''}
                        placeholder={f.placeholder}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal"
                      />
                    )}
                  </label>
                ))}
                <p className="text-[11px] text-slate-400">ข้อมูลนี้แสดงต่อทุกคนที่เปิดระบบ (โหมดสาธารณะ) — ไม่ควรใส่เบอร์โทรส่วนตัวหรือที่อยู่</p>
                {err && <div className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{err}</div>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save()}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                  >
                    <Save className="h-4 w-4" /> {saving ? 'กำลังบันทึก...' : 'บันทึก'}
                  </button>
                </div>
              </div>
            ) : FIELDS.slice(2).some((f) => profile?.[f.key]) ? (
              <dl className="mt-3 space-y-3 text-sm">
                {FIELDS.slice(2).map((f) =>
                  profile?.[f.key] ? (
                    <div key={f.key}>
                      <dt className="text-xs font-semibold text-indigo-800">{f.label}</dt>
                      <dd className="mt-0.5 whitespace-pre-line text-slate-700">{profile[f.key]}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-slate-400">
                ยังไม่มีข้อมูลประวัติ{canEdit ? ' — กด "แก้ไขประวัติ" เพื่อเพิ่ม' : ''}
              </p>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="flex items-center gap-1.5 font-bold text-slate-900">
              <BookOpen className="h-4 w-4 text-indigo-700" /> รายวิชาที่สอน
            </h3>
            {teaching.subjects.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">ยังไม่มีรายวิชาในตารางปัจจุบัน</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {teaching.subjects.map((s) => (
                  <li key={s.code} className="flex justify-between gap-3 py-1.5">
                    <span>
                      <span className="font-mono text-xs text-slate-500">{s.code}</span> {s.name}
                      <span className="block text-xs text-slate-500">{[...s.groups].join(', ')}</span>
                    </span>
                    <span className="shrink-0 text-xs text-slate-600">{s.periods} คาบ</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="font-bold text-slate-900">ตารางสอนรายสัปดาห์</h3>
            <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
              <thead>
                <tr className="bg-indigo-900 text-white">
                  <th className="w-16 px-1.5 py-1">วัน</th>
                  {periods.map((p) => (
                    <th key={p} className="px-1.5 py-1 font-medium">
                      {p}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d}>
                    <th className="border border-slate-200 bg-slate-50 px-1.5 text-left">{DAY_NAMES_TH[d]}</th>
                    {periods.map((p) => {
                      const i = at(d, p);
                      return (
                        <td key={p} className={`h-8 border border-slate-200 px-1 text-center ${i ? 'bg-indigo-50 font-medium text-indigo-900' : ''}`} title={i ? teaching.subjectOf(i.offeringId)?.subjectName : undefined}>
                          {i ? (teaching.groupsOf.get(i.offeringId) ?? []).join(',') : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="flex items-center gap-1.5 font-bold text-slate-900">
              <History className="h-4 w-4 text-indigo-700" /> ประวัติการเปลี่ยนแปลงตารางสอน
            </h3>
            {history.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">{loading ? 'กำลังโหลด...' : 'ยังไม่มีการย้ายหรือสลับคาบของครูท่านนี้'}</p>
            ) : (
              <ol className="mt-2 space-y-1.5 text-xs">
                {history.map((h, idx) => {
                  const item = ctx.items.find((i) => i.id === h.itemId);
                  const s = item && teaching.subjectOf(item.offeringId);
                  const lockChange = h.before?.isLocked !== h.after?.isLocked && slot(h.before) === slot(h.after);
                  return (
                    <li key={idx} className="rounded-md border border-slate-200 bg-indigo-50/50 px-2 py-1.5">
                      <span className="font-semibold">{s ? `${s.subjectCode} ${s.subjectName}` : 'คาบเรียน'}</span>{' '}
                      {lockChange ? (h.after?.isLocked ? 'ถูกล็อก' : 'ถูกปลดล็อก') : `${slot(h.before)} → ${slot(h.after)}`}
                      {h.at && <span className="ml-1 text-slate-400">· {new Date(h.at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
