/**
 * Data Check (Screen 16 / Requirement 1.1): cross-file validation of a parsed 7-CSV bundle.
 * Every issue carries a Thai message and actionable Thai suggestions.
 */
import type {
  DataCheckCode,
  DataCheckIssue,
  DataCheckSeverity,
  Dataset7Bundle,
  Dataset7FileKey,
  Dataset7ValidationResult,
  EducationLevel,
  ImportPreviewStats,
  RegisterCsvRow,
  RoomCsvRow,
  SlotRef,
  StudentGroupCsvRow,
  SubjectCsvRow,
  TeacherCsvRow,
} from '@ptc/shared';
import { DATASET7_FILE_KEYS } from '@ptc/shared';

/** Default lunch period when `student_group.csv` has no lunch column (CLAUDE.md: ปวช.=4, ปวส.=5). */
export const DEFAULT_LUNCH_PERIOD: Record<EducationLevel, number> = { 'ปวช.': 4, 'ปวส.': 5 };
export const DEFAULT_MAX_WEEKLY_PERIODS = 24;
const NON_CLASSROOM_TYPES = new Set(['activity_yard']);

const key = (code: string) => code.trim().toUpperCase();
const slotKey = (day: number, period: number) => `${day}:${period}`;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Up to `limit` candidate codes that look like `code` (typo / formatting differences). */
export function findSimilarCodes(code: string, candidates: Iterable<string>, limit = 3): string[] {
  const strip = (s: string) => s.toUpperCase().replace(/[\s_\-./]/g, '');
  const target = strip(code);
  const scored: Array<{ c: string; d: number }> = [];
  for (const c of candidates) {
    const s = strip(c);
    const d = s === target ? 0 : levenshtein(s, target);
    if (d <= Math.max(2, Math.floor(target.length / 4))) scored.push({ c, d });
  }
  return scored
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, limit)
    .map((x) => x.c);
}

function indexBy<T>(rows: T[], getKey: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const k = getKey(row);
    if (!map.has(k)) map.set(k, row);
  }
  return map;
}

export function validateDataset7(bundle: Dataset7Bundle): Dataset7ValidationResult {
  const issues: DataCheckIssue[] = [...bundle.parseIssues];
  const add = (
    severity: DataCheckSeverity,
    code: DataCheckCode,
    file: Dataset7FileKey,
    row: number | undefined,
    message: string,
    suggestions: string[],
  ) => {
    issues.push({ severity, code, file, ...(row !== undefined ? { row } : {}), message, suggestions });
  };

  const { timeslots, studentGroups, registers, subjects, teachers, teaches, rooms } = bundle;

  // -------------------------------------------------------------------------
  // 1) Duplicate codes within each file
  // -------------------------------------------------------------------------
  function checkDuplicates<T extends { rowNo: number }>(
    file: Dataset7FileKey,
    rows: T[],
    getKey: (row: T) => string | null,
    label: string,
    severity: DataCheckSeverity = 'error',
  ) {
    const firstRow = new Map<string, number>();
    for (const row of rows) {
      const k = getKey(row);
      if (k === null) continue;
      const first = firstRow.get(k);
      if (first === undefined) {
        firstRow.set(k, row.rowNo);
        continue;
      }
      add(
        severity,
        'DUP_CODE',
        file,
        row.rowNo,
        `${label} "${k}" ซ้ำกันในไฟล์ ${file}.csv (แถวที่ ${first} และ ${row.rowNo})`,
        [
          `ลบแถวที่ ${row.rowNo} ออก หากเป็นข้อมูลซ้ำ`,
          `หากเป็นคนละรายการ ให้แก้${label}ให้ไม่ซ้ำกัน`,
          ...(severity === 'error' ? ['ระบบจะใช้ข้อมูลจากแถวแรกที่พบในการตรวจสอบขั้นต่อไป'] : []),
        ],
      );
    }
  }

  checkDuplicates('timeslot', timeslots, (r) => `วัน ${r.day} คาบ ${r.period}`, 'ช่วงเวลา');
  checkDuplicates('student_group', studentGroups, (r) => key(r.groupCode), 'รหัสกลุ่มเรียน');
  checkDuplicates('subject', subjects, (r) => key(r.subjectCode), 'รหัสวิชา');
  checkDuplicates('teacher', teachers, (r) => key(r.teacherCode), 'รหัสครู');
  checkDuplicates('room', rooms, (r) => key(r.roomCode), 'รหัสห้อง');
  checkDuplicates('register', registers, (r) => (r.offeringCode ? key(r.offeringCode) : null), 'รหัสการลงทะเบียน');
  checkDuplicates(
    'register',
    registers.filter((r) => !r.offeringCode),
    (r) => `${key(r.subjectCode)} / ${r.groupCodes.map(key).sort().join('+')}${r.sectionNo ? ` / ตอน ${r.sectionNo}` : ''}`,
    'การลงทะเบียน (วิชา/กลุ่ม)',
    'warning',
  );
  checkDuplicates(
    'teach',
    teaches,
    (r) => `${key(r.teacherCode)} / ${key(r.subjectCode)}${r.groupCode ? ` / ${key(r.groupCode)}` : ''}`,
    'สิทธิ์การสอน (ครู/วิชา/กลุ่ม)',
    'warning',
  );

  const groupByCode = indexBy(studentGroups, (g) => key(g.groupCode));
  const subjectByCode = indexBy(subjects, (s) => key(s.subjectCode));
  const teacherByCode = indexBy(teachers, (t) => key(t.teacherCode));
  const roomTypes = new Set(rooms.map((r) => r.roomType));

  // -------------------------------------------------------------------------
  // 2) Semantic row checks (INVALID_ROW / MISSING_ROOM_TYPE)
  // -------------------------------------------------------------------------
  const classSlots = timeslots.filter((t) => t.kind === 'class');
  const lunchPeriodsGlobal = new Set(timeslots.filter((t) => t.kind === 'lunch').map((t) => slotKey(t.day, t.period)));
  const periodNumbers = new Set(timeslots.map((t) => t.period));
  if (bundle.presentFiles.includes('timeslot') && timeslots.length > 0 && classSlots.length === 0) {
    add('error', 'INVALID_ROW', 'timeslot', undefined, 'timeslot.csv ไม่มีคาบเรียนเลย (ทุกแถวเป็นคาบพัก/พักกลางวัน)', [
      'ตั้งค่าประเภทคาบ (type) ของคาบเรียนเป็น class หรือเว้นว่างไว้',
    ]);
  }

  for (const s of subjects) {
    if (s.theoryHours + s.practiceHours === 0) {
      add('error', 'INVALID_ROW', 'subject', s.rowNo, `วิชา ${s.subjectCode} มีชั่วโมงทฤษฎีและปฏิบัติรวมเป็น 0`, [
        'ระบุชั่วโมงทฤษฎี (ท) และ/หรือปฏิบัติ (ป) ต่อสัปดาห์ เช่น 1-3-2',
        'หากเป็นกิจกรรมที่ไม่ต้องจัดตาราง ให้ลบออกจาก register.csv',
      ]);
    }
  }

  for (const g of studentGroups) {
    if (g.lunchPeriod !== null && periodNumbers.size > 0 && !periodNumbers.has(g.lunchPeriod)) {
      add('warning', 'INVALID_ROW', 'student_group', g.rowNo, `กลุ่ม ${g.groupCode} กำหนดคาบพักกลางวันเป็นคาบที่ ${g.lunchPeriod} ซึ่งไม่มีใน timeslot.csv`, [
        `ใช้คาบพักกลางวันตามระดับชั้น (ปวช.=${DEFAULT_LUNCH_PERIOD['ปวช.']}, ปวส.=${DEFAULT_LUNCH_PERIOD['ปวส.']})`,
        'หรือเพิ่มคาบดังกล่าวใน timeslot.csv',
      ]);
    }
  }

  const registeredSubjects = new Set(registers.map((r) => key(r.subjectCode)));
  const reportedRoomType = new Set<string>();
  for (const s of subjects) {
    if (!s.requiredRoomType || roomTypes.has(s.requiredRoomType) || rooms.length === 0) continue;
    if (reportedRoomType.has(key(s.subjectCode))) continue;
    reportedRoomType.add(key(s.subjectCode));
    const used = registeredSubjects.has(key(s.subjectCode));
    add(
      used ? 'error' : 'warning',
      'MISSING_ROOM_TYPE',
      'subject',
      s.rowNo,
      `วิชา ${s.subjectCode} ต้องใช้ห้องประเภท "${s.requiredRoomType}" แต่ไม่มีห้องประเภทนี้ใน room.csv`,
      [
        `เพิ่มห้องประเภท "${s.requiredRoomType}" ใน room.csv`,
        `หรือแก้ประเภทห้องของวิชาให้ตรงกับที่มี: ${[...roomTypes].sort().join(', ')}`,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // 3–4) register → subject / student_group references
  // -------------------------------------------------------------------------
  const periodsOf = (r: RegisterCsvRow, s: SubjectCsvRow | undefined): number =>
    r.periodsPerWeek ?? (s ? s.theoryHours + s.practiceHours : 0);

  for (const r of registers) {
    const s = subjectByCode.get(key(r.subjectCode));
    if (!s) {
      const similar = findSimilarCodes(r.subjectCode, subjectByCode.keys());
      add('error', 'MISSING_SUBJECT', 'register', r.rowNo, `register.csv แถวที่ ${r.rowNo} อ้างถึงรหัสวิชา "${r.subjectCode}" ซึ่งไม่มีใน subject.csv`, [
        ...(similar.length > 0 ? [`ตรวจสอบการพิมพ์รหัสวิชา อาจหมายถึง: ${similar.join(', ')}`] : []),
        `เพิ่มวิชา ${r.subjectCode} ใน subject.csv พร้อมชั่วโมง ท-ป-น`,
        'หรือลบแถวนี้ออกจาก register.csv หากไม่ได้เปิดสอนในภาคเรียนนี้',
      ]);
    } else if (r.periodsPerWeek !== null && r.periodsPerWeek !== s.theoryHours + s.practiceHours) {
      add(
        'warning',
        'INVALID_ROW',
        'register',
        r.rowNo,
        `register.csv แถวที่ ${r.rowNo} ระบุ ${r.periodsPerWeek} คาบ/สัปดาห์ แต่วิชา ${s.subjectCode} มี ท+ป = ${s.theoryHours + s.practiceHours} คาบ`,
        ['ตรวจสอบจำนวนคาบให้ตรงกับหลักสูตร (ระบบจะใช้ค่าจาก register.csv)'],
      );
    }
    for (const gc of r.groupCodes) {
      if (groupByCode.has(key(gc))) continue;
      const similar = findSimilarCodes(gc, groupByCode.keys());
      add('error', 'MISSING_GROUP', 'register', r.rowNo, `register.csv แถวที่ ${r.rowNo} อ้างถึงกลุ่มเรียน "${gc}" ซึ่งไม่มีใน student_group.csv`, [
        ...(similar.length > 0 ? [`ตรวจสอบการพิมพ์รหัสกลุ่ม อาจหมายถึง: ${similar.join(', ')}`] : []),
        `เพิ่มกลุ่ม ${gc} ใน student_group.csv พร้อมจำนวนนักเรียน`,
        'หากเป็นการเรียนรวมหลายกลุ่ม ให้คั่นรหัสกลุ่มด้วย ; เช่น G1;G2',
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // 5) teach references & eligible teachers per offering
  // -------------------------------------------------------------------------
  for (const t of teaches) {
    if (!teacherByCode.has(key(t.teacherCode))) {
      const similar = findSimilarCodes(t.teacherCode, teacherByCode.keys());
      add('error', 'UNKNOWN_TEACHER_REF', 'teach', t.rowNo, `teach.csv แถวที่ ${t.rowNo} อ้างถึงครู "${t.teacherCode}" ซึ่งไม่มีใน teacher.csv`, [
        ...(similar.length > 0 ? [`อาจหมายถึงรหัสครู: ${similar.join(', ')}`] : []),
        `เพิ่มครู ${t.teacherCode} ใน teacher.csv หรือลบแถวนี้ออก`,
      ]);
    }
    if (!subjectByCode.has(key(t.subjectCode))) {
      const similar = findSimilarCodes(t.subjectCode, subjectByCode.keys());
      add('error', 'UNKNOWN_TEACHER_REF', 'teach', t.rowNo, `teach.csv แถวที่ ${t.rowNo} อ้างถึงวิชา "${t.subjectCode}" ซึ่งไม่มีใน subject.csv`, [
        ...(similar.length > 0 ? [`อาจหมายถึงรหัสวิชา: ${similar.join(', ')}`] : []),
        `เพิ่มวิชา ${t.subjectCode} ใน subject.csv หรือลบแถวนี้ออก`,
      ]);
    }
    if (t.groupCode && !groupByCode.has(key(t.groupCode))) {
      add('warning', 'UNKNOWN_TEACHER_REF', 'teach', t.rowNo, `teach.csv แถวที่ ${t.rowNo} จำกัดสิทธิ์สอนให้กลุ่ม "${t.groupCode}" ซึ่งไม่มีใน student_group.csv`, [
        'แก้รหัสกลุ่มให้ถูกต้อง หรือเว้นว่างเพื่อให้สอนได้ทุกกลุ่ม',
      ]);
    }
  }

  const eligibleFor = (r: RegisterCsvRow): string[] => {
    const groups = new Set(r.groupCodes.map(key));
    const result = new Set<string>();
    for (const t of teaches) {
      if (key(t.subjectCode) !== key(r.subjectCode) || !teacherByCode.has(key(t.teacherCode))) continue;
      if (t.groupCode === null || groups.has(key(t.groupCode))) result.add(key(t.teacherCode));
    }
    return [...result].sort();
  };

  const offeringEligible = new Map<RegisterCsvRow, string[]>();
  for (const r of registers) {
    if (!subjectByCode.has(key(r.subjectCode))) continue;
    const eligible = eligibleFor(r);
    offeringEligible.set(r, eligible);
    if (r.teacherCode) {
      if (!teacherByCode.has(key(r.teacherCode))) {
        add('error', 'UNKNOWN_TEACHER_REF', 'register', r.rowNo, `register.csv แถวที่ ${r.rowNo} ระบุครูผู้สอน "${r.teacherCode}" ซึ่งไม่มีใน teacher.csv`, [
          `เพิ่มครู ${r.teacherCode} ใน teacher.csv`,
          'หรือเว้นว่างช่องครูผู้สอนเพื่อให้ระบบเลือกครูที่มีสิทธิ์สอนจาก teach.csv',
        ]);
      } else if (!eligible.includes(key(r.teacherCode))) {
        add('error', 'MISSING_ELIGIBLE_TEACHER', 'register', r.rowNo, `ครู ${r.teacherCode} ที่ระบุใน register.csv แถวที่ ${r.rowNo} ไม่มีสิทธิ์สอนวิชา ${r.subjectCode} ตาม teach.csv`, [
          `เพิ่มแถว ${r.teacherCode},${r.subjectCode} ใน teach.csv`,
          ...(eligible.length > 0 ? [`หรือเปลี่ยนเป็นครูที่มีสิทธิ์สอน: ${eligible.join(', ')}`] : []),
        ]);
      }
      continue;
    }
    if (eligible.length === 0) {
      const anyGroupTeachers = teaches.filter((t) => key(t.subjectCode) === key(r.subjectCode)).map((t) => t.teacherCode);
      add('error', 'MISSING_ELIGIBLE_TEACHER', 'register', r.rowNo, `วิชา ${r.subjectCode} ของกลุ่ม ${r.groupCodes.join(', ')} (register.csv แถวที่ ${r.rowNo}) ไม่มีครูที่มีสิทธิ์สอนใน teach.csv`, [
        `เพิ่มแถวใน teach.csv ระบุครูที่สอนวิชา ${r.subjectCode} ได้ เช่น <รหัสครู>,${r.subjectCode}`,
        ...(anyGroupTeachers.length > 0
          ? [`มีครูสอนวิชานี้แต่จำกัดเฉพาะกลุ่มอื่น (${[...new Set(anyGroupTeachers)].join(', ')}) — เว้นว่างคอลัมน์กลุ่มหรือเพิ่มกลุ่มนี้`]
          : []),
        'ตรวจสอบว่ารหัสวิชาใน teach.csv ตรงกับ subject.csv',
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // 6) Room capacity
  // -------------------------------------------------------------------------
  // Outdoor/activity spaces are not classrooms: they only count for subjects that require them.
  const classrooms = rooms.some((r) => !NON_CLASSROOM_TYPES.has(r.roomType))
    ? rooms.filter((r) => !NON_CLASSROOM_TYPES.has(r.roomType))
    : rooms;
  const maxCapacity = classrooms.reduce((m, r) => Math.max(m, r.capacity), 0);
  const largestRooms = (list: RoomCsvRow[]) =>
    [...list]
      .sort((a, b) => b.capacity - a.capacity)
      .slice(0, 3)
      .map((r) => `${r.roomCode} (${r.capacity} ที่นั่ง)`)
      .join(', ');

  if (rooms.length > 0) {
    for (const g of studentGroups) {
      if (g.studentCount <= maxCapacity) continue;
      add('error', 'NO_SUFFICIENT_ROOM_CAPACITY', 'student_group', g.rowNo, `กลุ่ม ${g.groupCode} มีนักเรียน ${g.studentCount} คน แต่ห้องที่ใหญ่ที่สุดจุได้เพียง ${maxCapacity} คน`, [
        `เพิ่มห้องที่มีความจุอย่างน้อย ${g.studentCount} ที่นั่งใน room.csv`,
        `แบ่งกลุ่มย่อย (A/B) ให้แต่ละกลุ่มไม่เกิน ${maxCapacity} คน`,
        `ห้องที่ใหญ่ที่สุดในปัจจุบัน: ${largestRooms(classrooms)}`,
      ]);
    }

    for (const r of registers) {
      const groups = r.groupCodes.map((gc) => groupByCode.get(key(gc))).filter((g): g is StudentGroupCsvRow => !!g);
      if (groups.length === 0) continue;
      const total = groups.reduce((sum, g) => sum + g.studentCount, 0);
      if (groups.length > 1 && total > maxCapacity) {
        add('error', 'NO_SUFFICIENT_ROOM_CAPACITY', 'register', r.rowNo, `วิชา ${r.subjectCode} เรียนรวม ${groups.length} กลุ่ม (${total} คน) แต่ไม่มีห้องที่จุได้ (ใหญ่สุด ${maxCapacity} คน)`, [
          'แยกการลงทะเบียนเป็นหลายแถว (กลุ่มละ 1 แถว) แทนการเรียนรวม',
          `เพิ่มห้องบรรยายที่จุได้อย่างน้อย ${total} คน`,
        ]);
        continue;
      }
      const s = subjectByCode.get(key(r.subjectCode));
      if (!s?.requiredRoomType || !roomTypes.has(s.requiredRoomType)) continue;
      const typed = rooms.filter((room) => room.roomType === s.requiredRoomType);
      const typedMax = typed.reduce((m, room) => Math.max(m, room.capacity), 0);
      if (total > typedMax) {
        const half = Math.ceil(total / 2);
        add('warning', 'NO_SUFFICIENT_ROOM_CAPACITY', 'register', r.rowNo, `วิชา ${r.subjectCode} ต้องใช้ห้อง ${s.requiredRoomType} แต่ห้องประเภทนี้จุได้สูงสุด ${typedMax} คน ขณะที่ผู้เรียนมี ${total} คน`, [
          half <= typedMax
            ? `แบ่งเรียนเป็นกลุ่มย่อย A/B (กลุ่มละประมาณ ${half} คน) เพื่อให้ใช้ห้อง ${s.requiredRoomType} ได้`
            : `เพิ่มห้อง ${s.requiredRoomType} ที่จุได้อย่างน้อย ${total} คน`,
          `ห้อง ${s.requiredRoomType} ที่มี: ${largestRooms(typed)}`,
        ]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7) Weekly hours per group vs. available slots
  // -------------------------------------------------------------------------
  const groupRequired = new Map<string, number>();
  let totalWeeklyPeriods = 0;
  for (const r of registers) {
    const p = periodsOf(r, subjectByCode.get(key(r.subjectCode)));
    totalWeeklyPeriods += p;
    for (const gc of new Set(r.groupCodes.map(key))) groupRequired.set(gc, (groupRequired.get(gc) ?? 0) + p);
  }

  const availableForGroup = (g: StudentGroupCsvRow) => {
    const unavailable = new Set(g.unavailableSlots.map((s) => slotKey(s.day, s.period)));
    const lunch = g.lunchPeriod ?? (lunchPeriodsGlobal.size === 0 && g.level ? DEFAULT_LUNCH_PERIOD[g.level] : null);
    const days = g.allowedDays ? new Set(g.allowedDays) : null;
    return classSlots.filter(
      (t) =>
        (!days || days.has(t.day)) &&
        t.period !== lunch &&
        !unavailable.has(slotKey(t.day, t.period)),
    ).length;
  };

  if (classSlots.length > 0) {
    for (const g of studentGroups) {
      const required = groupRequired.get(key(g.groupCode)) ?? 0;
      if (required === 0) continue;
      const available = availableForGroup(g);
      if (required > available) {
        add('error', 'HOURS_EXCEED_AVAILABLE_SLOTS', 'student_group', g.rowNo, `กลุ่ม ${g.groupCode} ต้องเรียน ${required} คาบ/สัปดาห์ แต่มีคาบที่จัดได้เพียง ${available} คาบ (เกิน ${required - available} คาบ)`, [
          'ลดจำนวนวิชา/คาบที่ลงทะเบียนของกลุ่มนี้ใน register.csv หรือย้ายบางวิชาไปภาคเรียนอื่น',
          'เพิ่มคาบเรียนใน timeslot.csv (เช่น เปิดคาบเย็นหรือวันเสาร์)',
          'ตรวจสอบคาบไม่ว่าง (unavailable_slots) และวันเรียน (allowed_days) ของกลุ่มว่าปิดมากเกินไปหรือไม่',
        ]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8) Teacher overload risk
  // -------------------------------------------------------------------------
  const forced = new Map<string, number>();
  const share = new Map<string, number>();
  for (const [r, eligible] of offeringEligible) {
    const p = periodsOf(r, subjectByCode.get(key(r.subjectCode)));
    const assigned = r.teacherCode && teacherByCode.has(key(r.teacherCode)) ? key(r.teacherCode) : null;
    if (assigned) {
      forced.set(assigned, (forced.get(assigned) ?? 0) + p);
      share.set(assigned, (share.get(assigned) ?? 0) + p);
    } else if (eligible.length > 0) {
      if (eligible.length === 1) forced.set(eligible[0]!, (forced.get(eligible[0]!) ?? 0) + p);
      for (const t of eligible) share.set(t, (share.get(t) ?? 0) + p / eligible.length);
    }
  }

  const teacherAvailable = (t: TeacherCsvRow) => {
    const unavailable = new Set(t.unavailableSlots.map((s: SlotRef) => slotKey(s.day, s.period)));
    return classSlots.filter((s) => !unavailable.has(slotKey(s.day, s.period))).length;
  };

  for (const t of teachers) {
    const code = key(t.teacherCode);
    if (teacherByCode.get(code) !== t) continue; // duplicate rows already reported
    const max = t.maxWeeklyPeriods ?? DEFAULT_MAX_WEEKLY_PERIODS;
    const available = classSlots.length > 0 ? teacherAvailable(t) : Number.POSITIVE_INFINITY;
    const limit = Math.min(max, available);
    const minLoad = forced.get(code) ?? 0;
    const fair = Math.round((share.get(code) ?? 0) * 10) / 10;
    if (minLoad > limit) {
      add('warning', 'TEACHER_OVERLOAD_RISK', 'teacher', t.rowNo, `ครู ${t.teacherCode} ต้องสอนอย่างน้อย ${minLoad} คาบ/สัปดาห์ (เป็นผู้สอนเพียงคนเดียวของบางวิชา) เกินขีดจำกัด ${limit} คาบ`, [
        'เพิ่มครูที่มีสิทธิ์สอนวิชาเหล่านี้ใน teach.csv เพื่อกระจายภาระงาน',
        `ปรับคาบสูงสุดต่อสัปดาห์ของครู (ปัจจุบัน ${max}) หรือลดคาบไม่ว่างของครู`,
      ]);
    } else if (fair > limit) {
      add('warning', 'TEACHER_OVERLOAD_RISK', 'teacher', t.rowNo, `ครู ${t.teacherCode} มีภาระงานเฉลี่ยโดยประมาณ ${fair} คาบ/สัปดาห์ เกินขีดจำกัด ${limit} คาบ (เสี่ยงจัดตารางไม่ลง)`, [
        'เพิ่มครูที่มีสิทธิ์สอนวิชาเดียวกันใน teach.csv',
        'ตรวจสอบว่าวิชาที่ครูคนนี้สอนได้มีจำนวนกลุ่มมากเกินไปหรือไม่',
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Result
  // -------------------------------------------------------------------------
  const fileOrder = new Map<Dataset7FileKey, number>(DATASET7_FILE_KEYS.map((f, i) => [f, i]));
  issues.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      fileOrder.get(a.file)! - fileOrder.get(b.file)! ||
      (a.row ?? 0) - (b.row ?? 0),
  );

  const issuesByCode: Partial<Record<DataCheckCode, number>> = {};
  for (const i of issues) issuesByCode[i.code] = (issuesByCode[i.code] ?? 0) + 1;
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  const stats: ImportPreviewStats = {
    totalFiles: bundle.presentFiles.length,
    counts: {
      timeslot: timeslots.length,
      student_group: studentGroups.length,
      register: registers.length,
      subject: subjects.length,
      teacher: teachers.length,
      teach: teaches.length,
      room: rooms.length,
    },
    errorCount,
    warningCount: issues.length - errorCount,
    issuesByCode,
    totalWeeklyPeriods,
    classSlotsPerWeek: classSlots.length,
  };

  return { valid: errorCount === 0, issues, stats };
}
