/**
 * Column mapping for the competition 7-CSV dataset.
 * Every normalized field accepts several header aliases (English + Thai). Header matching is
 * case-insensitive and ignores spaces, `_`, `-`, `.`, `/`, `(`, `)` — so `Start Time`,
 * `start_time` and `START-TIME` are all the same header.
 */
import type {
  Dataset7ColumnMapping,
  Dataset7ColumnMappingOverrides,
  Dataset7FieldMap,
  Dataset7FileKey,
} from '@ptc/shared';
import { DATASET7_FILE_KEYS } from '@ptc/shared';

const SLOT_ALIASES = [
  'unavailable_slots',
  'unavailable',
  'unavailable_time',
  'not_available',
  'busy_slots',
  'busy',
  'คาบไม่ว่าง',
  'เวลาไม่ว่าง',
  'ช่วงเวลาไม่ว่าง',
  'คาบที่ไม่ว่าง',
];

const DEPARTMENT_ALIASES = ['department_code', 'department', 'dept', 'รหัสแผนก', 'แผนกวิชา', 'แผนก', 'สาขาวิชา', 'สาขา'];

export const DEFAULT_COLUMN_MAPPING: Dataset7ColumnMapping = {
  timeslot: {
    day: ['day', 'day_of_week', 'dow', 'weekday', 'วัน', 'วันที่สอน', 'วันในสัปดาห์'],
    period: ['period', 'period_no', 'slot', 'slot_no', 'คาบ', 'คาบที่', 'คาบเรียน'],
    startTime: ['start_time', 'start', 'time_start', 'from', 'time', 'เวลาเริ่ม', 'เริ่ม', 'เวลา'],
    endTime: ['end_time', 'end', 'time_end', 'to', 'เวลาสิ้นสุด', 'เวลาเลิก', 'สิ้นสุด'],
    shift: ['shift', 'session', 'ช่วง', 'ช่วงเวลา', 'ภาค'],
    kind: ['slot_type', 'type', 'kind', 'is_break', 'break', 'lunch', 'ประเภทคาบ', 'ประเภท', 'พัก'],
  },
  student_group: {
    groupCode: ['group_code', 'group_id', 'group', 'code', 'id', 'รหัสกลุ่มเรียน', 'รหัสกลุ่ม', 'กลุ่มเรียน', 'กลุ่ม'],
    groupName: ['group_name', 'name', 'ชื่อกลุ่มเรียน', 'ชื่อกลุ่ม', 'ชื่อ'],
    departmentCode: DEPARTMENT_ALIASES,
    level: ['level', 'ระดับชั้น', 'ระดับ'],
    yearNo: ['year_no', 'year', 'grade', 'ชั้นปี', 'ปีที่', 'ปี'],
    studentCount: [
      'student_count',
      'students',
      'num_students',
      'size',
      'count',
      'จำนวนนักเรียน',
      'จำนวนนักศึกษา',
      'จำนวนผู้เรียน',
      'จำนวน',
    ],
    lunchPeriod: ['lunch_period', 'lunch', 'คาบพักกลางวัน', 'คาบพัก', 'พักกลางวัน'],
    allowedDays: ['allowed_days', 'days', 'study_days', 'วันเรียน', 'วันที่เรียน'],
    unavailableSlots: SLOT_ALIASES,
  },
  register: {
    offeringCode: ['offering_code', 'offering_id', 'register_id', 'register_code', 'id', 'รหัสการลงทะเบียน', 'รหัสลงทะเบียน'],
    subjectCode: ['subject_code', 'subject_id', 'subject', 'course_code', 'รหัสวิชา', 'วิชา'],
    groupCodes: ['group_codes', 'group_code', 'groups', 'group_id', 'group', 'รหัสกลุ่มเรียน', 'รหัสกลุ่ม', 'กลุ่มเรียน', 'กลุ่ม'],
    periodsPerWeek: [
      'periods_per_week',
      'periods',
      'hours_per_week',
      'hours',
      'คาบต่อสัปดาห์',
      'จำนวนคาบ',
      'ชั่วโมงต่อสัปดาห์',
    ],
    sectionNo: ['section_no', 'section', 'sec', 'ตอนเรียน', 'ตอน'],
    teacherCode: ['teacher_code', 'teacher_id', 'teacher', 'รหัสครู', 'ครูผู้สอน', 'ผู้สอน', 'ครู'],
  },
  subject: {
    subjectCode: ['subject_code', 'subject_id', 'code', 'id', 'รหัสวิชา'],
    subjectName: ['subject_name', 'name', 'title', 'ชื่อวิชา', 'รายวิชา', 'ชื่อ'],
    theoryHours: ['theory_hours', 'theory', 'lecture_hours', 't', 'ท', 'ทฤษฎี', 'ชั่วโมงทฤษฎี', 'ท-ป-น', 'tpc', 't-p-c'],
    practiceHours: ['practice_hours', 'practice', 'lab_hours', 'p', 'ป', 'ปฏิบัติ', 'ชั่วโมงปฏิบัติ'],
    credits: ['credits', 'credit', 'c', 'น', 'หน่วยกิต'],
    requiredRoomType: ['required_room_type', 'room_type', 'roomtype', 'ประเภทห้องเรียน', 'ประเภทห้อง', 'ห้องที่ต้องการ'],
    mustBeConsecutive: ['must_be_consecutive', 'consecutive', 'is_consecutive', 'เรียนต่อเนื่อง', 'คาบติดกัน', 'ต่อเนื่อง'],
    sequenceOrder: ['sequence_order', 'sequence', 'seq', 'order', 'ลำดับเนื้อหา', 'ลำดับ'],
    prerequisiteCode: ['prerequisite_code', 'prerequisite', 'prereq', 'วิชาบังคับก่อน', 'ต้องเรียนก่อน'],
    category: ['category', 'subject_type', 'type', 'หมวดวิชา', 'ประเภทวิชา', 'หมวด'],
  },
  teacher: {
    teacherCode: ['teacher_code', 'teacher_id', 'employee_code', 'staff_code', 'code', 'id', 'รหัสครู', 'รหัสบุคลากร', 'รหัสพนักงาน'],
    fullName: ['full_name', 'teacher_name', 'name', 'ชื่อ-นามสกุล', 'ชื่อ-สกุล', 'ชื่อสกุล', 'ชื่อครู', 'ชื่อ'],
    departmentCode: DEPARTMENT_ALIASES,
    maxWeeklyPeriods: [
      'max_weekly_periods',
      'max_periods',
      'max_load',
      'max_hours',
      'คาบสูงสุดต่อสัปดาห์',
      'ภาระงานสูงสุด',
    ],
    unavailableSlots: SLOT_ALIASES,
  },
  teach: {
    teacherCode: ['teacher_code', 'teacher_id', 'teacher', 'employee_code', 'รหัสครู', 'ครูผู้สอน', 'ครู'],
    subjectCode: ['subject_code', 'subject_id', 'subject', 'รหัสวิชา', 'วิชา'],
    groupCode: ['group_code', 'group_id', 'group', 'รหัสกลุ่มเรียน', 'รหัสกลุ่ม', 'กลุ่มเรียน', 'กลุ่ม'],
  },
  room: {
    roomCode: ['room_code', 'room_id', 'room', 'code', 'id', 'รหัสห้อง', 'ห้องเรียน', 'ห้อง'],
    roomName: ['room_name', 'name', 'ชื่อห้อง'],
    buildingCode: ['building_code', 'building', 'bldg', 'รหัสอาคาร', 'อาคาร', 'ตึก'],
    capacity: ['capacity', 'seats', 'size', 'ความจุ', 'จำนวนที่นั่ง'],
    roomType: ['room_type', 'type', 'roomtype', 'ประเภทห้อง', 'ประเภท'],
  },
};

/** Fields that must be present as a column for the file to be usable. */
export const REQUIRED_FIELDS: { [F in Dataset7FileKey]: Dataset7FieldMap[F][] } = {
  timeslot: ['day', 'period'],
  student_group: ['groupCode', 'studentCount'],
  register: ['subjectCode', 'groupCodes'],
  subject: ['subjectCode', 'theoryHours'],
  teacher: ['teacherCode'],
  teach: ['teacherCode', 'subjectCode'],
  room: ['roomCode', 'capacity'],
};

/** Thai labels for normalized fields (used in Data Check messages). */
export const FIELD_LABELS_TH: Record<string, string> = {
  day: 'วัน',
  period: 'คาบ',
  startTime: 'เวลาเริ่ม',
  endTime: 'เวลาสิ้นสุด',
  shift: 'ช่วงเวลา',
  kind: 'ประเภทคาบ',
  groupCode: 'รหัสกลุ่มเรียน',
  groupCodes: 'รหัสกลุ่มเรียน',
  groupName: 'ชื่อกลุ่มเรียน',
  departmentCode: 'แผนกวิชา',
  level: 'ระดับชั้น',
  yearNo: 'ชั้นปี',
  studentCount: 'จำนวนนักเรียน',
  lunchPeriod: 'คาบพักกลางวัน',
  allowedDays: 'วันเรียน',
  unavailableSlots: 'คาบไม่ว่าง',
  offeringCode: 'รหัสการลงทะเบียน',
  subjectCode: 'รหัสวิชา',
  subjectName: 'ชื่อวิชา',
  periodsPerWeek: 'จำนวนคาบต่อสัปดาห์',
  sectionNo: 'ตอนเรียน',
  teacherCode: 'รหัสครู',
  theoryHours: 'ชั่วโมงทฤษฎี (ท)',
  practiceHours: 'ชั่วโมงปฏิบัติ (ป)',
  credits: 'หน่วยกิต (น)',
  requiredRoomType: 'ประเภทห้องที่ต้องการ',
  mustBeConsecutive: 'เรียนต่อเนื่อง',
  sequenceOrder: 'ลำดับเนื้อหา',
  prerequisiteCode: 'วิชาบังคับก่อน',
  category: 'หมวดวิชา',
  fullName: 'ชื่อ-นามสกุล',
  maxWeeklyPeriods: 'คาบสูงสุดต่อสัปดาห์',
  roomCode: 'รหัสห้อง',
  roomName: 'ชื่อห้อง',
  buildingCode: 'อาคาร',
  capacity: 'ความจุ',
  roomType: 'ประเภทห้อง',
};

/** Normalize a header (or alias) for comparison. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./()]+/g, '');
}

/**
 * Merge UI/API overrides into the default mapping. Override headers take priority; default
 * aliases remain as fallbacks. Returns a fresh object (defaults are never mutated).
 */
export function mergeColumnMapping(overrides?: Dataset7ColumnMappingOverrides): Dataset7ColumnMapping {
  const merged = structuredClone(DEFAULT_COLUMN_MAPPING);
  if (!overrides) return merged;
  for (const file of DATASET7_FILE_KEYS) {
    const fileOverrides = overrides[file] as Partial<Record<string, string | string[]>> | undefined;
    if (!fileOverrides) continue;
    const target = merged[file] as Record<string, string[]>;
    for (const [field, value] of Object.entries(fileOverrides)) {
      if (value === undefined || !(field in target)) continue;
      const preferred = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
      const seen = new Set<string>();
      target[field] = [...preferred, ...(target[field] ?? [])].filter((alias) => {
        const key = normalizeHeader(alias);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return merged;
}

/**
 * Resolve each field of one file to a column index. Fields are resolved in declaration order;
 * an alias list is scanned in priority order and a header is claimed by at most one field.
 */
export function resolveColumns<F extends Dataset7FileKey>(
  file: F,
  headers: string[],
  mapping: Dataset7ColumnMapping,
): Partial<Record<Dataset7FieldMap[F], number>> {
  const normalized = headers.map(normalizeHeader);
  const claimed = new Set<number>();
  const result: Partial<Record<Dataset7FieldMap[F], number>> = {};
  const fileMapping = mapping[file] as Record<Dataset7FieldMap[F], string[]>;
  // Resolve required fields first so generic aliases (e.g. `code`, `id`) go to the key columns.
  const fields = Object.keys(fileMapping) as Dataset7FieldMap[F][];
  const required = new Set<string>(REQUIRED_FIELDS[file] as string[]);
  const ordered = [...fields.filter((f) => required.has(f)), ...fields.filter((f) => !required.has(f))];
  for (const field of ordered) {
    for (const alias of fileMapping[field]) {
      const key = normalizeHeader(alias);
      const idx = normalized.findIndex((h, i) => h === key && !claimed.has(i));
      if (idx >= 0) {
        result[field] = idx;
        claimed.add(idx);
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Value vocabularies
// ---------------------------------------------------------------------------

const ROOM_TYPE_ALIASES: Record<string, string[]> = {
  theory: ['theory', 'classroom', 'class', 'lecture', 'normal', 'ทฤษฎี', 'ห้องทฤษฎี', 'ห้องเรียน', 'ห้องเรียนทฤษฎี', 'ห้องเรียนปกติ'],
  lecture_hall: ['lecture_hall', 'hall', 'auditorium', 'ห้องบรรยาย', 'ห้องประชุม', 'หอประชุม'],
  lab_com: ['lab_com', 'lab_computer', 'computer_lab', 'computer', 'com', 'lab', 'ห้องคอม', 'ห้องคอมพิวเตอร์', 'ห้องปฏิบัติการคอมพิวเตอร์', 'คอมพิวเตอร์'],
  lab_network: ['lab_network', 'network_lab', 'network', 'ห้องเครือข่าย', 'ห้องปฏิบัติการเครือข่าย', 'เครือข่าย'],
  lab_ai: ['lab_ai', 'ai_lab', 'ai', 'ห้องปัญญาประดิษฐ์', 'ห้องปฏิบัติการปัญญาประดิษฐ์', 'ปัญญาประดิษฐ์'],
  lab_graphic: ['lab_graphic', 'graphic_lab', 'graphic', 'graphics', 'ห้องกราฟิก', 'ห้องปฏิบัติการกราฟิก', 'กราฟิก'],
  activity_yard: ['activity_yard', 'yard', 'field', 'gym', 'ลานกิจกรรม', 'สนาม', 'ลาน', 'โรงยิม'],
};

const ROOM_TYPE_LOOKUP = new Map<string, string>(
  Object.entries(ROOM_TYPE_ALIASES).flatMap(([code, aliases]) => aliases.map((a) => [normalizeHeader(a), code] as const)),
);

/** Map a free-text room type to a catalog code (`theory`, `lab_com`, ...). Unknown → lowercased input. */
export function normalizeRoomType(value: string): string {
  const key = normalizeHeader(value);
  return ROOM_TYPE_LOOKUP.get(key) ?? value.trim().toLowerCase();
}

const DAY_ALIASES: Record<number, string[]> = {
  1: ['mon', 'monday', 'จ', 'จ.', 'จันทร์', 'วันจันทร์'],
  2: ['tue', 'tues', 'tuesday', 'อ', 'อ.', 'อังคาร', 'วันอังคาร'],
  3: ['wed', 'wednesday', 'พ', 'พ.', 'พุธ', 'วันพุธ'],
  4: ['thu', 'thur', 'thurs', 'thursday', 'พฤ', 'พฤ.', 'พฤหัส', 'พฤหัสบดี', 'วันพฤหัสบดี', 'วันพฤหัส'],
  5: ['fri', 'friday', 'ศ', 'ศ.', 'ศุกร์', 'วันศุกร์'],
  6: ['sat', 'saturday', 'ส', 'ส.', 'เสาร์', 'วันเสาร์'],
  7: ['sun', 'sunday', 'อา', 'อา.', 'อาทิตย์', 'วันอาทิตย์'],
};

const DAY_LOOKUP = new Map<string, number>(
  Object.entries(DAY_ALIASES).flatMap(([day, aliases]) => aliases.map((a) => [normalizeHeader(a), Number(day)] as const)),
);

/** Parse a weekday (1–7, English or Thai name/abbreviation). Returns null when unrecognized. */
export function parseDay(value: string): number | null {
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 7 ? n : null;
  }
  return DAY_LOOKUP.get(normalizeHeader(v)) ?? null;
}
