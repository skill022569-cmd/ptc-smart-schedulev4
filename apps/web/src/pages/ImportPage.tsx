import { useState } from 'react';
import { AlertCircle, CheckCircle2, Database, FileSpreadsheet, Upload } from 'lucide-react';
import { api } from '../lib/api';
import type { Dataset7ValidationResult } from '../types/ui';

const FILE_KEYS = ['timeslot', 'student_group', 'register', 'subject', 'teacher', 'teach', 'room'] as const;

export function ImportPage({ onCommitted }: { onCommitted: () => void }) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [mappingText, setMappingText] = useState('');
  const [showMapping, setShowMapping] = useState(false);
  const [validation, setValidation] = useState<Dataset7ValidationResult | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const loadSample = async () => {
    setStatus('กำลังโหลดไฟล์ตัวอย่าง 7 CSV...');
    setError('');
    try {
      const res = await api.importTemplates();
      setFiles(res.files);
      setMappingText(JSON.stringify(res.defaultMapping, null, 2));
      const prev = await api.importPreview(res.files);
      setValidation(prev.validation);
      setStatus('โหลดและตรวจ Dataset ตัวอย่าง 7 ไฟล์เรียบร้อย');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    }
  };

  const handleFileUpload = async (key: string, file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const next = { ...files, [`${key}.csv`]: text };
    setFiles(next);
  };

  const runPreview = async () => {
    setStatus('กำลังตรวจความสัมพันธ์ข้ามไฟล์ (Data Check)...');
    setError('');
    try {
      const mapping = mappingText.trim() ? (JSON.parse(mappingText) as Record<string, Record<string, string[]>>) : undefined;
      const res = await api.importPreview(files, mapping);
      setValidation(res.validation);
      setStatus('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    }
  };

  const commitDb = async () => {
    setStatus('กำลังบันทึกข้อมูล 7 ไฟล์ลงฐานข้อมูล TiDB...');
    setError('');
    try {
      const mapping = mappingText.trim() ? (JSON.parse(mappingText) as Record<string, Record<string, string[]>>) : undefined;
      await api.importCommit(files, mapping, false);
      setStatus('นำเข้าข้อมูลลงฐานข้อมูล TiDB สำเร็จ!');
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">นำเข้าข้อมูล 7 CSV &amp; Data Check</h1>
          <p className="text-sm text-slate-500">ตรวจความสมบูรณ์และความสัมพันธ์ข้ามไฟล์ก่อนจัดตาราง (ข้อกำหนด 1.1 &amp; โจทย์ 19)</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void loadSample()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">
            <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> โหลดตัวอย่าง 7 CSV
          </button>
          <button onClick={() => setShowMapping((v) => !v)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">
            {showMapping ? 'ซ่อน Column Mapping' : 'ตั้งค่า Column Mapping'}
          </button>
        </div>
      </div>

      {status && <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">{status}</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FILE_KEYS.map((key) => {
          const fileName = `${key}.csv`;
          const loaded = Boolean(files[fileName] || files[key]);
          return (
            <label key={key} className={`flex cursor-pointer flex-col justify-between rounded-xl border p-4 transition ${loaded ? 'border-emerald-300 bg-emerald-50/40' : 'border-dashed border-slate-300 bg-white hover:border-indigo-400'}`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold text-slate-800">{fileName}</span>
                {loaded ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Upload className="h-4 w-4 text-slate-400" />}
              </div>
              <span className="mt-2 text-xs text-slate-500">{loaded ? 'พร้อมตรวจสอบ' : 'คลิกเพื่อเลือกไฟล์ .csv'}</span>
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void handleFileUpload(key, e.target.files?.[0])} />
            </label>
          );
        })}
      </div>

      {showMapping && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-sm font-semibold text-slate-800">กำหนดชื่อคอลัมน์ (Column Mapping JSON)</div>
          <textarea
            value={mappingText}
            onChange={(e) => setMappingText(e.target.value)}
            rows={10}
            className="w-full rounded-lg border border-slate-300 font-mono text-xs p-3"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button onClick={() => void runPreview()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
          ตรวจสอบ Data Check
        </button>
        {validation?.valid && (
          <button onClick={() => void commitDb()} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            <Database className="h-4 w-4" /> นำเข้าข้อมูลลง TiDB
          </button>
        )}
      </div>

      {validation && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-slate-900">
              ผลการตรวจ Data Check: {validation.valid ? 'ผ่านพร้อมนำเข้า' : `พบข้อผิดพลาด ${validation.stats.errorCount} รายการ`}
            </h2>
            <div className="text-sm text-slate-600">
              ไฟล์: {validation.stats.totalFiles}/7 · คาบที่ต้องจัดรวม: {validation.stats.totalWeeklyPeriods} · Error: {validation.stats.errorCount} · Warning: {validation.stats.warningCount}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {FILE_KEYS.map((k) => (
              <div key={k} className="rounded-lg bg-slate-50 p-2.5 text-center">
                <div className="font-mono text-xs text-slate-500">{k}</div>
                <div className="text-lg font-bold text-slate-800">{validation.stats.counts[k]}</div>
              </div>
            ))}
          </div>

          {validation.issues.length === 0 ? (
            <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">
              ไม่พบปัญหาความสัมพันธ์ข้ามไฟล์ (ครู–วิชา–ห้อง–กลุ่มครบถ้วน)
            </div>
          ) : (
            <div className="space-y-2">
              {validation.issues.map((iss, idx) => (
                <div key={idx} className={`rounded-lg border p-3 text-sm ${iss.severity === 'error' ? 'border-red-200 bg-red-50/70' : 'border-amber-200 bg-amber-50/70'}`}>
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertCircle className={`h-4 w-4 ${iss.severity === 'error' ? 'text-red-600' : 'text-amber-600'}`} />
                    <span>[{iss.code}] {iss.file}.csv {iss.row ? `(แถว ${iss.row})` : ''}</span>
                  </div>
                  <div className="mt-1 text-slate-800">{iss.message}</div>
                  {iss.suggestions.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                      {iss.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
