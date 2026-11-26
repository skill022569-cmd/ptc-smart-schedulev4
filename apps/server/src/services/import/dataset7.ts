/**
 * Competition 7-CSV parser → normalized `Dataset7Bundle`.
 * Pure (no DB access): parsing problems are collected as `parseIssues` and later merged by
 * `validateDataset7()` so the Data Check screen shows everything in one list.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type {
  DataCheckIssue,
  Dataset7Bundle,
  Dataset7ColumnMapping,
  Dataset7ColumnMappingOverrides,
  Dataset7FieldMap,
  Dataset7FileKey,
  Dataset7Files,
  EducationLevel,
  RegisterCsvRow,
  RoomCsvRow,
  Shift,
  SlotRef,
  StudentGroupCsvRow,
  SubjectCategory,
  SubjectCsvRow,
  TeachCsvRow,
  TeacherCsvRow,
  TimeslotCsvRow,
  TimeslotKind,
} from '@ptc/shared';
import { DATASET7_FILE_KEYS } from '@ptc/shared';
import {
  FIELD_LABELS_TH,
  REQUIRED_FIELDS,
  mergeColumnMapping,
  normalizeHeader,
  normalizeRoomType,
  parseDay,
  resolveColumns,
} from './mapping';

/** Highest period number accepted anywhere (CLAUDE.md: periods 1–12). */
export const MAX_PERIOD = 12;

// ---------------------------------------------------------------------------
// Low-level CSV reading
// ---------------------------------------------------------------------------

interface CsvRecord {
  line: number;
  cells: string[];
}

interface CsvTable {
  headers: string[];
  records: CsvRecord[];
}

function decode(content: string | Uint8Array): string {
  const text = typeof content === 'string' ? content : new TextDecoder('utf-8').decode(content);
  return text.replace(/^﻿/, '');
}

/** Pick the delimiter that occurs most often in the header line (`,` `;` or tab). */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

function readCsv(file: Dataset7FileKey, content: string | Uint8Array, issues: DataCheckIssue[]): CsvTable | null {
  const text = decode(content);
  if (text.trim() === '') {
    issues.push({
      severity: 'error',
      code: 'MISSING_FILE',
      file,
      message: `ไฟล์ ${file}.csv ว่างเปล่า ไม่มีข้อมูล`,
      suggestions: [`ตรวจสอบว่าเลือกไฟล์ ${file}.csv ถูกต้อง และมีแถวหัวตาราง (header) กับข้อมูลอย่างน้อย 1 แถว`],
    });
    return null;
  }
  let raw: Array<{ record: string[]; info: { lines: number } }>;
  try {
    raw = parse(text, {
      bom: true,
      delimiter: detectDelimiter(text),
      trim: true,
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
      relax_column_count: true,
      relax_quotes: true,
      info: true,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (err) {
    const lines = (err as { lines?: number }).lines;
    issues.push({
      severity: 'error',
      code: 'INVALID_ROW',
      file,
      ...(typeof lines === 'number' ? { row: lines } : {}),
      message: `อ่านไฟล์ ${file}.csv ไม่สำเร็จ: ${(err as Error).message}`,
      suggestions: [
        'บันทึกไฟล์เป็น CSV UTF-8 (Comma delimited) จาก Excel/Google Sheets ใหม่อีกครั้ง',
        'ตรวจสอบเครื่องหมายคำพูด (") ที่เปิดแล้วไม่ได้ปิดในบางช่อง',
      ],
    });
    return null;
  }
  const [header, ...rest] = raw;
  if (!header) return null;
  return {
    headers: header.record.map((h) => h.replace(/^﻿/, '').trim()),
    records: rest.map((r) => ({ line: r.info.lines, cells: r.record.map((c) => c.trim()) })),
  };
}

// ---------------------------------------------------------------------------
// Row accessor with typed field parsers that record INVALID_ROW issues
// ---------------------------------------------------------------------------

class RowReader<F extends Dataset7FileKey> {
  /** True when a required value of this row could not be parsed (row is dropped). */
  broken = false;

  constructor(
    private readonly file: F,
    private readonly record: CsvRecord,
    private readonly columns: Partial<Record<Dataset7FieldMap[F], number>>,
    private readonly issues: DataCheckIssue[],
  ) {}

  get line(): number {
    return this.record.line;
  }

  has(field: Dataset7FieldMap[F]): boolean {
    return this.columns[field] !== undefined;
  }

  raw(field: Dataset7FieldMap[F]): string {
    const idx = this.columns[field];
    return idx === undefined ? '' : (this.record.cells[idx] ?? '').trim();
  }

  invalid(field: Dataset7FieldMap[F], value: string, expected: string, fatal: boolean): void {
    if (fatal) this.broken = true;
    const label = FIELD_LABELS_TH[field] ?? field;
    this.issues.push({
      severity: 'error',
      code: 'INVALID_ROW',
      file: this.file,
      row: this.line,
      message:
        value === ''
          ? `แถวที่ ${this.line} ของ ${this.file}.csv ไม่ได้ระบุ "${label}"`
          : `แถวที่ ${this.line} ของ ${this.file}.csv มีค่า "${label}" = "${value}" ไม่ถูกต้อง (ต้องเป็น${expected})`,
      suggestions: [
        `แก้ไขช่อง "${label}" ในแถวที่ ${this.line} ให้เป็น${expected}`,
        ...(fatal ? ['แถวนี้จะไม่ถูกนำเข้าจนกว่าจะแก้ไข'] : []),
      ],
    });
  }

  text(field: Dataset7FieldMap[F], required: true): string;
  text(field: Dataset7FieldMap[F], required?: false): string | null;
  text(field: Dataset7FieldMap[F], required = false): string | null {
    const v = this.raw(field);
    if (v === '') {
      if (required) this.invalid(field, v, 'ข้อความที่ไม่ว่าง', true);
      return required ? '' : null;
    }
    return v;
  }

  int(field: Dataset7FieldMap[F], opts: { required: true; min?: number; max?: number }): number;
  int(field: Dataset7FieldMap[F], opts?: { required?: false; min?: number; max?: number }): number | null;
  int(field: Dataset7FieldMap[F], opts: { required?: boolean; min?: number; max?: number } = {}): number | null {
    const { required = false, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
    const v = this.raw(field).replace(/,/g, '');
    const expected =
      min > Number.MIN_SAFE_INTEGER && max < Number.MAX_SAFE_INTEGER
        ? `จำนวนเต็มระหว่าง ${min}–${max}`
        : min > Number.MIN_SAFE_INTEGER
          ? `จำนวนเต็มตั้งแต่ ${min} ขึ้นไป`
          : 'จำนวนเต็ม';
    if (v === '') {
      if (required) this.invalid(field, v, expected, true);
      return null;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      this.invalid(field, v, expected, required);
      return null;
    }
    return n;
  }

  bool(field: Dataset7FieldMap[F]): boolean {
    const v = this.raw(field).toLowerCase();
    if (v === '') return false;
    if (TRUE_WORDS.has(v)) return true;
    if (FALSE_WORDS.has(v)) return false;
    this.invalid(field, this.raw(field), 'ค่า true/false, 1/0, Y/N หรือ ใช่/ไม่', false);
    return false;
  }

  day(field: Dataset7FieldMap[F]): number {
    const v = this.raw(field);
    const d = v === '' ? null : parseDay(v);
    if (d === null) {
      this.invalid(field, v, 'วัน 1–7 (1=จันทร์) หรือชื่อวัน เช่น Mon, จ., จันทร์', true);
      return 0;
    }
    return d;
  }

  slots(field: Dataset7FieldMap[F]): SlotRef[] {
    const v = this.raw(field);
    if (v === '') return [];
    const { slots, invalid } = parseSlotList(v);
    if (invalid.length > 0) {
      this.invalid(field, invalid.join(', '), ' "วัน:คาบ" เช่น 1:3, 1-3, Mon:1-4 หรือ จ:5 คั่นด้วย ;', false);
    }
    return slots;
  }

  days(field: Dataset7FieldMap[F]): number[] | null {
    const v = this.raw(field);
    if (v === '') return null;
    const result = parseDayList(v);
    if (result === null) {
      this.invalid(field, v, 'รายการวัน เช่น 1,2,3,4,5 หรือ 1-5 หรือ จ-ศ', false);
      return null;
    }
    return result;
  }
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 't', 'x', '✓', 'ใช่', 'จริง', 'ต่อเนื่อง', 'ติดกัน']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'f', '-', 'ไม่', 'ไม่ใช่', 'เท็จ', 'ไม่ต่อเนื่อง']);

// ---------------------------------------------------------------------------
// Value parsers (exported for reuse/tests)
// ---------------------------------------------------------------------------

const SLOT_TOKEN = /^([^\d\s:_\-/.]+\.?|\d)\s*[:\-_/.\s]\s*(\*|all|ทั้งวัน|\d{1,2}(?:\s*-\s*\d{1,2})?)$/i;

function expandPeriods(spec: string): number[] | null {
  const s = spec.trim().toLowerCase();
  if (s === '*' || s === 'all' || s === 'ทั้งวัน') return Array.from({ length: MAX_PERIOD }, (_, i) => i + 1);
  const m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || to > MAX_PERIOD || to < from) return null;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * Parse an unavailable-slot list. Accepted forms (separated by `;`, `,` or `|`):
 * `1:3`, `1-3`, `1_3`, `Mon:1-4` (range), `จ:5`, `ศ:*` (whole day), a bare day (`Fri`, `ศ`)
 * for the whole day, or JSON (`[{"day":1,"period":3}]`, `[[1,3]]`, `["1:3"]`).
 */
export function parseSlotList(value: string): { slots: SlotRef[]; invalid: string[] } {
  const slots: SlotRef[] = [];
  const invalid: string[] = [];
  const pushUnique = (day: number, period: number) => {
    if (!slots.some((s) => s.day === day && s.period === period)) slots.push({ day, period });
  };
  const trimmed = value.trim();
  let tokens: unknown[];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      tokens = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return { slots, invalid: [trimmed] };
    }
  } else {
    tokens = trimmed.split(/[;,|]+/);
  }
  for (const token of tokens) {
    if (Array.isArray(token) && token.length === 2 && token.every((n) => Number.isInteger(n))) {
      const [d, p] = token as [number, number];
      if (d >= 1 && d <= 7 && p >= 1 && p <= MAX_PERIOD) pushUnique(d, p);
      else invalid.push(JSON.stringify(token));
      continue;
    }
    if (token !== null && typeof token === 'object' && !Array.isArray(token)) {
      const { day, period } = token as { day?: unknown; period?: unknown };
      const d = typeof day === 'string' ? parseDay(day) : Number(day);
      const p = Number(period);
      if (d !== null && Number.isInteger(d) && d >= 1 && d <= 7 && Number.isInteger(p) && p >= 1 && p <= MAX_PERIOD) {
        pushUnique(d, p);
      } else invalid.push(JSON.stringify(token));
      continue;
    }
    const t = String(token).trim();
    if (t === '') continue;
    const bareDay = parseDay(t);
    if (bareDay !== null && !/^\d+$/.test(t)) {
      for (let p = 1; p <= MAX_PERIOD; p++) pushUnique(bareDay, p);
      continue;
    }
    const m = SLOT_TOKEN.exec(t);
    const day = m ? parseDay(m[1]!) : null;
    const periods = m ? expandPeriods(m[2]!) : null;
    if (day === null || periods === null) {
      invalid.push(t);
      continue;
    }
    for (const p of periods) pushUnique(day, p);
  }
  slots.sort((a, b) => a.day - b.day || a.period - b.period);
  return { slots, invalid };
}

/** Parse `1,2,3,4,5`, `1-5`, `จ-ศ`, `Mon;Wed` → sorted unique days, or null if invalid. */
export function parseDayList(value: string): number[] | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
        return [...new Set(parsed as number[])].sort((a, b) => a - b);
      }
    } catch {
      /* fall through */
    }
    return null;
  }
  const days = new Set<number>();
  for (const part of trimmed.split(/[;,|\s]+/).filter(Boolean)) {
    const range = /^(.+?)\s*-\s*(.+)$/.exec(part);
    if (range) {
      const from = parseDay(range[1]!);
      const to = parseDay(range[2]!);
      if (from === null || to === null || to < from) return null;
      for (let d = from; d <= to; d++) days.add(d);
    } else {
      const d = parseDay(part);
      if (d === null) return null;
      days.add(d);
    }
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** Split combined-group cells: `G1;G2`, `G1, G2`, `G1|G2`, `G1+G2` (group codes may contain `/`). */
export function splitGroupCodes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;|+\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Normalize `8:00`, `08.00`, `0800`, `08:00:00` → `08:00`; null when invalid. */
export function parseTime(value: string): string | null {
  const m = /^(\d{1,2})[:.]?(\d{2})(?:[:.](\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseLevel(value: string): EducationLevel | null {
  const v = normalizeHeader(value);
  if (v === '') return null;
  if (v.includes('ปวช') || ['pvc', 'voc', 'vc', 'certificate', 'vocationalcertificate'].includes(v)) return 'ปวช.';
  if (v.includes('ปวส') || ['pvs', 'hvc', 'diploma', 'highvocationalcertificate', 'highervocational'].includes(v)) {
    return 'ปวส.';
  }
  return null;
}

function parseShift(value: string, period: number): Shift {
  const v = normalizeHeader(value);
  if (['evening', 'night', 'ค่ำ', 'เย็น', 'ภาคค่ำ', 'ภาคสมทบ', 'สมทบ'].includes(v)) return 'evening';
  if (['day', 'morning', 'afternoon', 'กลางวัน', 'ปกติ', 'เช้า', 'บ่าย'].includes(v)) return 'day';
  return period >= 10 ? 'evening' : 'day';
}

function parseKind(value: string): TimeslotKind | null {
  const v = normalizeHeader(value);
  if (['', 'class', 'teach', 'study', 'lesson', 'normal', 'false', '0', 'no', 'n', 'เรียน', 'สอน', 'คาบเรียน', 'ปกติ'].includes(v)) {
    return 'class';
  }
  if (['lunch', 'lunchbreak', 'พักกลางวัน', 'พักเที่ยง', 'กลางวัน'].includes(v)) return 'lunch';
  if (['break', 'rest', 'true', '1', 'yes', 'y', 'พัก', 'หยุด', 'กิจกรรม', 'activity', 'closed', 'ปิด'].includes(v)) {
    return 'break';
  }
  return null;
}

function parseCategory(value: string): SubjectCategory | null | undefined {
  const v = normalizeHeader(value);
  if (v === '') return null;
  if (['general', 'gen', 'สามัญ', 'ทั่วไป', 'สมรรถนะแกนกลาง', 'หมวดสมรรถนะแกนกลาง', 'วิชาสามัญ'].includes(v)) return 'general';
  if (['core', 'vocational', 'major', 'วิชาชีพ', 'สมรรถนะวิชาชีพ', 'หลัก', 'บังคับ', 'แกน'].includes(v)) return 'core';
  if (['elective', 'free', 'เลือก', 'เลือกเสรี', 'วิชาเลือก', 'วิชาเลือกเสรี'].includes(v)) return 'elective';
  if (['activity', 'กิจกรรม', 'กิจกรรมเสริมหลักสูตร'].includes(v)) return 'activity';
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-file parsers
// ---------------------------------------------------------------------------

type Columns<F extends Dataset7FileKey> = Partial<Record<Dataset7FieldMap[F], number>>;

function prepare<F extends Dataset7FileKey>(
  file: F,
  content: string | Uint8Array | undefined,
  mapping: Dataset7ColumnMapping,
  issues: DataCheckIssue[],
): { table: CsvTable; columns: Columns<F> } | null {
  if (content === undefined) {
    issues.push({
      severity: 'error',
      code: 'MISSING_FILE',
      file,
      message: `ไม่พบไฟล์ ${file}.csv ในชุดข้อมูล`,
      suggestions: [`อัปโหลดไฟล์ ${file}.csv ให้ครบทั้ง 7 ไฟล์ (timeslot, student_group, register, subject, teacher, teach, room)`],
    });
    return null;
  }
  const table = readCsv(file, content, issues);
  if (!table) return null;
  const columns = resolveColumns(file, table.headers, mapping);
  const missing = (REQUIRED_FIELDS[file] as Dataset7FieldMap[F][]).filter((f) => columns[f] === undefined);
  if (missing.length > 0) {
    const fileMapping = mapping[file] as Record<Dataset7FieldMap[F], string[]>;
    for (const field of missing) {
      const label = FIELD_LABELS_TH[field] ?? field;
      issues.push({
        severity: 'error',
        code: 'MISSING_COLUMN',
        file,
        row: 1,
        message: `ไฟล์ ${file}.csv ไม่มีคอลัมน์ "${label}" (${field}) ซึ่งจำเป็นต้องมี`,
        suggestions: [
          `เพิ่มคอลัมน์ชื่อใดชื่อหนึ่งต่อไปนี้: ${fileMapping[field].slice(0, 6).join(', ')}`,
          `หรือใช้หน้าจับคู่คอลัมน์ (Column Mapping) เลือกคอลัมน์ที่ตรงกับ "${label}" จากหัวตารางที่พบ: ${table.headers.join(', ') || '(ไม่มี)'}`,
        ],
      });
    }
    return null;
  }
  return { table, columns };
}

function parseTimeslots(table: CsvTable, columns: Columns<'timeslot'>, issues: DataCheckIssue[]): TimeslotCsvRow[] {
  const rows: TimeslotCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('timeslot', record, columns, issues);
    const day = r.day('day');
    const period = r.int('period', { required: true, min: 1, max: MAX_PERIOD });
    let startRaw = r.raw('startTime');
    let endRaw = r.raw('endTime');
    // A single "time" cell may hold the full range: 08:00-09:00
    const range = /^(\S+?)\s*[-–~]\s*(\S+)$/.exec(startRaw);
    if (range && endRaw === '') {
      startRaw = range[1]!;
      endRaw = range[2]!;
    }
    const startTime = startRaw === '' ? '' : parseTime(startRaw);
    const endTime = endRaw === '' ? '' : parseTime(endRaw);
    if (startTime === null) r.invalid('startTime', startRaw, 'เวลา HH:MM เช่น 08:00', false);
    if (endTime === null) r.invalid('endTime', endRaw, 'เวลา HH:MM เช่น 09:00', false);
    if (startTime && endTime && endTime <= startTime) {
      r.invalid('endTime', endRaw, `เวลาที่มากกว่าเวลาเริ่ม (${startTime})`, false);
    }
    const kind = parseKind(r.raw('kind'));
    if (kind === null) r.invalid('kind', r.raw('kind'), 'ประเภทคาบ class/lunch/break หรือ เรียน/พักกลางวัน/พัก', false);
    if (r.broken) continue;
    rows.push({
      rowNo: r.line,
      day,
      period,
      startTime: startTime ?? '',
      endTime: endTime ?? '',
      shift: parseShift(r.raw('shift'), period),
      kind: kind ?? 'class',
    });
  }
  return rows;
}

function parseStudentGroups(
  table: CsvTable,
  columns: Columns<'student_group'>,
  issues: DataCheckIssue[],
): StudentGroupCsvRow[] {
  const rows: StudentGroupCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('student_group', record, columns, issues);
    const groupCode = r.text('groupCode', true);
    const studentCount = r.int('studentCount', { required: true, min: 1 });
    const groupName = r.text('groupName');
    const levelRaw = r.raw('level');
    let level = parseLevel(levelRaw);
    if (levelRaw !== '' && level === null) r.invalid('level', levelRaw, ' ปวช. หรือ ปวส.', false);
    if (level === null) level = parseLevel(groupCode) ?? (groupName ? parseLevel(groupName) : null);
    const yearNo = r.int('yearNo', { min: 1, max: 5 });
    const lunchPeriod = r.int('lunchPeriod', { min: 1, max: MAX_PERIOD });
    const allowedDays = r.days('allowedDays');
    const unavailableSlots = r.slots('unavailableSlots');
    if (r.broken) continue;
    rows.push({
      rowNo: r.line,
      groupCode,
      groupName,
      departmentCode: r.text('departmentCode'),
      level,
      yearNo,
      studentCount,
      lunchPeriod,
      allowedDays,
      unavailableSlots,
    });
  }
  return rows;
}

function parseRegisters(table: CsvTable, columns: Columns<'register'>, issues: DataCheckIssue[]): RegisterCsvRow[] {
  const rows: RegisterCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('register', record, columns, issues);
    const subjectCode = r.text('subjectCode', true);
    const groupRaw = r.text('groupCodes', true);
    const groupCodes = splitGroupCodes(groupRaw);
    if (groupRaw !== '' && groupCodes.length === 0) r.invalid('groupCodes', groupRaw, 'รหัสกลุ่มเรียน เช่น G1 หรือ G1;G2', true);
    const periodsPerWeek = r.int('periodsPerWeek', { min: 1, max: 60 });
    const sectionNo = r.int('sectionNo', { min: 1 });
    if (r.broken) continue;
    rows.push({
      rowNo: r.line,
      offeringCode: r.text('offeringCode'),
      subjectCode,
      groupCodes,
      periodsPerWeek,
      sectionNo,
      teacherCode: r.text('teacherCode'),
    });
  }
  return rows;
}

function parseSubjects(table: CsvTable, columns: Columns<'subject'>, issues: DataCheckIssue[]): SubjectCsvRow[] {
  const rows: SubjectCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('subject', record, columns, issues);
    const subjectCode = r.text('subjectCode', true);
    let theoryHours: number | null;
    let practiceHours: number | null;
    let credits: number | null;
    // Thai curriculum notation ท-ป-น, e.g. "1-3-2" in the theory column.
    const tpc = /^(\d+)\s*-\s*(\d+)\s*-\s*(\d+)$/.exec(r.raw('theoryHours'));
    if (tpc) {
      theoryHours = Number(tpc[1]);
      practiceHours = Number(tpc[2]);
      credits = r.has('credits') && r.raw('credits') !== '' ? r.int('credits', { min: 0 }) : Number(tpc[3]);
    } else {
      theoryHours = r.int('theoryHours', { required: true, min: 0, max: 40 });
      practiceHours = r.int('practiceHours', { min: 0, max: 40 }) ?? 0;
      credits = r.int('credits', { min: 0, max: 40 });
    }
    const categoryRaw = r.raw('category');
    const category = parseCategory(categoryRaw);
    if (category === undefined) r.invalid('category', categoryRaw, ' general/core/elective/activity (สามัญ/วิชาชีพ/เลือก/กิจกรรม)', false);
    const roomTypeRaw = r.raw('requiredRoomType');
    const mustBeConsecutive = r.bool('mustBeConsecutive');
    const sequenceOrder = r.int('sequenceOrder', { min: 0 });
    if (r.broken) continue;
    const t = theoryHours ?? 0;
    const p = practiceHours ?? 0;
    rows.push({
      rowNo: r.line,
      subjectCode,
      subjectName: r.text('subjectName') ?? subjectCode,
      theoryHours: t,
      practiceHours: p,
      credits: credits ?? t + Math.floor(p / 2),
      requiredRoomType: roomTypeRaw === '' || ['-', 'any', 'none', 'ไม่ระบุ'].includes(roomTypeRaw.toLowerCase())
        ? null
        : normalizeRoomType(roomTypeRaw),
      mustBeConsecutive,
      sequenceOrder,
      prerequisiteCode: r.text('prerequisiteCode'),
      category: category ?? null,
    });
  }
  return rows;
}

function parseTeachers(table: CsvTable, columns: Columns<'teacher'>, issues: DataCheckIssue[]): TeacherCsvRow[] {
  const rows: TeacherCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('teacher', record, columns, issues);
    const teacherCode = r.text('teacherCode', true);
    const maxWeeklyPeriods = r.int('maxWeeklyPeriods', { min: 1, max: 84 });
    const unavailableSlots = r.slots('unavailableSlots');
    if (r.broken) continue;
    rows.push({
      rowNo: r.line,
      teacherCode,
      fullName: r.text('fullName') ?? teacherCode,
      departmentCode: r.text('departmentCode'),
      maxWeeklyPeriods,
      unavailableSlots,
    });
  }
  return rows;
}

function parseTeaches(table: CsvTable, columns: Columns<'teach'>, issues: DataCheckIssue[]): TeachCsvRow[] {
  const rows: TeachCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('teach', record, columns, issues);
    const teacherCode = r.text('teacherCode', true);
    const subjectCode = r.text('subjectCode', true);
    const groupRaw = r.text('groupCode');
    if (r.broken) continue;
    // A teach row listing several groups expands into one eligibility row per group.
    const groups = groupRaw ? splitGroupCodes(groupRaw) : [];
    if (groups.length === 0) rows.push({ rowNo: r.line, teacherCode, subjectCode, groupCode: null });
    for (const groupCode of groups) rows.push({ rowNo: r.line, teacherCode, subjectCode, groupCode });
  }
  return rows;
}

function parseRooms(table: CsvTable, columns: Columns<'room'>, issues: DataCheckIssue[]): RoomCsvRow[] {
  const rows: RoomCsvRow[] = [];
  for (const record of table.records) {
    const r = new RowReader('room', record, columns, issues);
    const roomCode = r.text('roomCode', true);
    const capacity = r.int('capacity', { required: true, min: 1, max: 5000 });
    if (r.broken) continue;
    const typeRaw = r.raw('roomType');
    rows.push({
      rowNo: r.line,
      roomCode,
      roomName: r.text('roomName'),
      buildingCode: r.text('buildingCode'),
      capacity,
      roomType: typeRaw === '' ? 'theory' : normalizeRoomType(typeRaw),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function pickFile(files: Dataset7Files, key: Dataset7FileKey): string | Uint8Array | undefined {
  return files[key] ?? files[`${key}.csv`];
}

/**
 * Parse the 7 competition CSV files into a normalized bundle.
 * @param files raw contents keyed by `timeslot` / `timeslot.csv` ...
 * @param columnMapping optional overrides merged on top of `DEFAULT_COLUMN_MAPPING`
 */
export function parseDataset7(files: Dataset7Files, columnMapping?: Dataset7ColumnMappingOverrides): Dataset7Bundle {
  const mapping = mergeColumnMapping(columnMapping);
  const issues: DataCheckIssue[] = [];
  const presentFiles = DATASET7_FILE_KEYS.filter((k) => {
    const c = pickFile(files, k);
    return c !== undefined && decode(c).trim() !== '';
  });

  const timeslot = prepare('timeslot', pickFile(files, 'timeslot'), mapping, issues);
  const studentGroup = prepare('student_group', pickFile(files, 'student_group'), mapping, issues);
  const register = prepare('register', pickFile(files, 'register'), mapping, issues);
  const subject = prepare('subject', pickFile(files, 'subject'), mapping, issues);
  const teacher = prepare('teacher', pickFile(files, 'teacher'), mapping, issues);
  const teach = prepare('teach', pickFile(files, 'teach'), mapping, issues);
  const room = prepare('room', pickFile(files, 'room'), mapping, issues);

  return {
    timeslots: timeslot ? parseTimeslots(timeslot.table, timeslot.columns, issues) : [],
    studentGroups: studentGroup ? parseStudentGroups(studentGroup.table, studentGroup.columns, issues) : [],
    registers: register ? parseRegisters(register.table, register.columns, issues) : [],
    subjects: subject ? parseSubjects(subject.table, subject.columns, issues) : [],
    teachers: teacher ? parseTeachers(teacher.table, teacher.columns, issues) : [],
    teaches: teach ? parseTeaches(teach.table, teach.columns, issues) : [],
    rooms: room ? parseRooms(room.table, room.columns, issues) : [],
    presentFiles,
    parseIssues: issues,
  };
}

const FILE_NAME_ALIASES: Record<string, Dataset7FileKey> = {
  timeslot: 'timeslot',
  timeslots: 'timeslot',
  time: 'timeslot',
  studentgroup: 'student_group',
  studentgroups: 'student_group',
  group: 'student_group',
  groups: 'student_group',
  register: 'register',
  registers: 'register',
  registration: 'register',
  subject: 'subject',
  subjects: 'subject',
  teacher: 'teacher',
  teachers: 'teacher',
  teach: 'teach',
  teaches: 'teach',
  teaching: 'teach',
  room: 'room',
  rooms: 'room',
};

/** Map a file name such as `Student_Group.CSV` or `time-slots.csv` to its dataset key. */
export function detectDataset7FileKey(fileName: string): Dataset7FileKey | null {
  const base = path.basename(fileName).replace(/\.csv$/i, '');
  return FILE_NAME_ALIASES[normalizeHeader(base)] ?? null;
}

/** Read the 7 CSV files from a directory (file names matched case-insensitively) and parse them. */
export async function loadDataset7FromDir(
  dirPath: string,
  columnMapping?: Dataset7ColumnMappingOverrides,
): Promise<Dataset7Bundle> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: Dataset7Files = {};
  for (const entry of entries) {
    if (!entry.isFile() || !/\.csv$/i.test(entry.name)) continue;
    const key = detectDataset7FileKey(entry.name);
    if (key && files[key] === undefined) files[key] = await readFile(path.join(dirPath, entry.name));
  }
  return parseDataset7(files, columnMapping);
}
