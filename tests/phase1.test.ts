import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataCheckCode, DataCheckIssue, Dataset7Files, ScenarioDataset } from '../packages/shared/src';
import { DATASET7_FILE_KEYS, TABLE_NAMES } from '../packages/shared/src';
import { describeSchema } from '../apps/server/src/db/introspect';
import { buildQ01, buildQ21, scenarioToDataset7Files } from '../apps/server/src/db/scenario-builder';
import { SCHEMA_TABLES } from '../apps/server/src/db/schema';
import { verifyPassword } from '../apps/server/src/lib/password';
import {
  DEFAULT_COLUMN_MAPPING,
  loadDataset7FromDir,
  mergeColumnMapping,
  parseDataset7,
  parseSlotList,
  splitGroupCodes,
  validateDataset7,
} from '../apps/server/src/services/import';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THAI = /[฀-๿]/;

const csv = (...lines: string[]) => `${lines.join('\n')}\n`;

function expectThaiIssue(issue: DataCheckIssue | undefined): asserts issue is DataCheckIssue {
  expect(issue).toBeDefined();
  expect(issue!.message).toMatch(THAI);
  expect(issue!.suggestions.length).toBeGreaterThan(0);
  for (const s of issue!.suggestions) expect(s).toMatch(THAI);
}

const issuesOf = (issues: DataCheckIssue[], code: DataCheckCode) => issues.filter((i) => i.code === code);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('Drizzle schema (30 tables)', () => {
  const schema = describeSchema();

  it('SCHEMA_TABLES contains exactly the 30 expected tables with matching SQL names', () => {
    expect(Object.keys(SCHEMA_TABLES)).toHaveLength(30);
    expect(Object.keys(SCHEMA_TABLES).sort()).toEqual([...TABLE_NAMES].sort());
    for (const [key, table] of Object.entries(schema)) expect(table.name).toBe(key);
  });

  it('slot_occupancy has uq_no_clash (5 columns, unique) and idx_occ_item', () => {
    const occ = schema.slot_occupancy;
    const uq = occ.indexes.find((i) => i.name === 'uq_no_clash');
    expect(uq).toEqual({
      name: 'uq_no_clash',
      unique: true,
      columns: ['version_id', 'day_of_week', 'period', 'resource_type', 'resource_id'],
    });
    expect(occ.indexes.find((i) => i.name === 'idx_occ_item')).toEqual({ name: 'idx_occ_item', unique: false, columns: ['item_id'] });
    expect(occ.columns.every((c) => c.notNull)).toBe(true);
  });

  it('has the composite primary keys, unique indexes and FKs from the spec', () => {
    expect(schema.teacher_subject_eligibility.primaryKey).toEqual(['staff_id', 'subject_id']);
    expect(schema.offering_groups.primaryKey).toEqual(['offering_id', 'group_id']);
    expect(schema.offering_teachers.primaryKey).toEqual(['offering_id', 'staff_id']);
    expect(schema.elective_enrollments.primaryKey).toEqual(['student_id', 'term_id']);
    expect(schema.schedule_item_teachers.primaryKey).toEqual(['item_id', 'staff_id']);
    expect(schema.terms.indexes.find((i) => i.name === 'uq_term')?.columns).toEqual(['academic_year', 'semester']);
    expect(schema.time_slots.indexes.find((i) => i.name === 'uq_slot')?.columns).toEqual(['term_id', 'period']);
    expect(schema.subgroups.indexes.find((i) => i.name === 'uq_sub')?.columns).toEqual(['group_id', 'code']);
    expect(schema.subjects.indexes.find((i) => i.name === 'uq_subject')?.columns).toEqual(['subject_code', 'curriculum_year']);
    expect(schema.constraint_configs.indexes.find((i) => i.name === 'uq_cc')?.columns).toEqual(['profile_name', 'code']);
    expect(schema.audit_logs.indexes.find((i) => i.name === 'idx_audit_entity')?.columns).toEqual(['entity', 'entity_id']);
    expect(schema.schedule_items.indexes.find((i) => i.name === 'idx_items_version')?.columns).toEqual(['version_id', 'status']);

    const fks = Object.values(schema).flatMap((t) => t.foreignKeys.map((fk) => `${t.name}.${fk.columns[0]}->${fk.foreignTable}`));
    expect(fks.sort()).toEqual(
      [
        'course_offerings.subject_id->subjects',
        'course_offerings.term_id->terms',
        'rooms.building_id->buildings',
        'rooms.room_type_id->room_types',
        'staff.department_id->departments',
        'student_groups.department_id->departments',
        'students.group_id->student_groups',
        'subgroups.group_id->student_groups',
        'time_slots.term_id->terms',
      ].sort(),
    );
  });

  it('uses the specified column types for special columns', () => {
    const col = (t: keyof typeof schema, c: string) => schema[t].columns.find((x) => x.name === c)!;
    expect(col('staff', 'phone_encrypted').sqlType).toBe('varbinary(255)');
    expect(col('staff', 'phone_encrypted').notNull).toBe(false);
    expect(col('student_groups', 'unavailable_slots')).toMatchObject({ sqlType: 'json', notNull: false });
    expect(col('time_slots', 'open_days')).toMatchObject({ sqlType: 'json', notNull: true });
    expect(col('scheduling_runs', 'soft_score').sqlType).toBe('decimal(12,2)');
    expect(col('scheduling_runs', 'fitness').sqlType).toBe('decimal(12,4)');
    expect(col('subgroups', 'code').sqlType).toBe('char(1)');
    expect(col('student_groups', 'level').sqlType).toBe("enum('ปวช.','ปวส.')");
    expect(col('rooms', 'room_code')).toMatchObject({ notNull: true, unique: true });
    expect(col('audit_logs', 'created_at').hasDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function loadScenario(code: string): Promise<{ raw: string; data: ScenarioDataset }> {
  const raw = await readFile(path.join(ROOT, 'scenarios', `${code}.json`), 'utf8');
  return { raw, data: JSON.parse(raw) as ScenarioDataset };
}

/** Assert every id reference in a scenario points at an existing row. */
function checkReferentialIntegrity(s: ScenarioDataset): void {
  const t = s.tables;
  const ids = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
  const terms = ids(t.terms);
  const departments = ids(t.departments);
  const buildings = ids(t.buildings);
  const roomTypes = ids(t.room_types);
  const rooms = ids(t.rooms);
  const staff = ids(t.staff);
  const groups = ids(t.student_groups);
  const subgroups = ids(t.subgroups);
  const students = ids(t.students);
  const subjects = ids(t.subjects);
  const offerings = ids(t.course_offerings);
  const accounts = ids(t.accounts);
  const missing: string[] = [];
  const ref = (set: Set<string>, value: string | null, label: string) => {
    if (value !== null && !set.has(value)) missing.push(`${label}=${value}`);
  };
  for (const r of t.time_slots) ref(terms, r.termId, 'time_slots.term_id');
  for (const r of t.rooms) {
    ref(buildings, r.buildingId, 'rooms.building_id');
    ref(roomTypes, r.roomTypeId, 'rooms.room_type_id');
  }
  for (const r of t.staff) ref(departments, r.departmentId, 'staff.department_id');
  for (const r of t.accounts) {
    ref(staff, r.staffId, 'accounts.staff_id');
    ref(students, r.studentId, 'accounts.student_id');
  }
  for (const r of t.consent_records) ref(accounts, r.accountId, 'consent_records.account_id');
  for (const r of t.student_groups) ref(departments, r.departmentId, 'student_groups.department_id');
  for (const r of t.subgroups) ref(groups, r.groupId, 'subgroups.group_id');
  for (const r of t.students) {
    ref(groups, r.groupId, 'students.group_id');
    ref(subgroups, r.subgroupId, 'students.subgroup_id');
  }
  for (const r of t.subjects) ref(roomTypes, r.requiredRoomTypeId, 'subjects.required_room_type_id');
  for (const r of t.course_offerings) {
    ref(terms, r.termId, 'course_offerings.term_id');
    ref(subjects, r.subjectId, 'course_offerings.subject_id');
    ref(roomTypes, r.roomTypeId, 'course_offerings.room_type_id');
  }
  for (const r of t.offering_groups) {
    ref(offerings, r.offeringId, 'offering_groups.offering_id');
    ref(groups, r.groupId, 'offering_groups.group_id');
  }
  for (const r of t.offering_teachers) {
    ref(offerings, r.offeringId, 'offering_teachers.offering_id');
    ref(staff, r.staffId, 'offering_teachers.staff_id');
  }
  for (const r of t.teacher_subject_eligibility) {
    ref(staff, r.staffId, 'eligibility.staff_id');
    ref(subjects, r.subjectId, 'eligibility.subject_id');
    ref(groups, r.groupId, 'eligibility.group_id');
  }
  for (const r of t.fixed_blocks) {
    ref(terms, r.termId, 'fixed_blocks.term_id');
    ref(rooms, r.roomId, 'fixed_blocks.room_id');
  }
  expect(missing).toEqual([]);

  // Unique keys
  const unique = <T>(rows: T[], key: (r: T) => string) => expect(new Set(rows.map(key)).size).toBe(rows.length);
  for (const name of TABLE_NAMES) {
    const rows = t[name] as unknown as Array<{ id?: string }>;
    if (rows.length > 0 && rows[0]!.id !== undefined) unique(rows, (r) => r.id!);
  }
  unique(t.rooms, (r) => r.roomCode);
  unique(t.staff, (r) => r.employeeCode);
  unique(t.student_groups, (r) => r.groupCode);
  unique(t.students, (r) => r.studentCode);
  unique(t.subjects, (r) => r.subjectCode);
  unique(t.accounts, (r) => r.username);
  unique(t.time_slots, (r) => `${r.termId}|${r.period}`);
  unique(t.offering_groups, (r) => `${r.offeringId}|${r.groupId}`);
  unique(t.offering_teachers, (r) => `${r.offeringId}|${r.staffId}`);
  unique(t.teacher_subject_eligibility, (r) => `${r.staffId}|${r.subjectId}`);
  unique(t.constraint_configs, (r) => `${r.profileName}|${r.code}`);

  // Every offering has ≥1 group and ≥1 eligible teacher
  const eligible = new Set(t.teacher_subject_eligibility.map((e) => `${e.staffId}|${e.subjectId}`));
  const subjectOf = new Map(t.course_offerings.map((o) => [o.id, o.subjectId]));
  for (const o of t.course_offerings) {
    expect(t.offering_groups.some((g) => g.offeringId === o.id)).toBe(true);
    expect(t.offering_teachers.some((x) => x.offeringId === o.id)).toBe(true);
    expect(o.splitPattern.reduce((a, b) => a + b, 0)).toBe(o.periodsPerWeek);
  }
  for (const ot of t.offering_teachers) expect(eligible.has(`${ot.staffId}|${subjectOf.get(ot.offeringId)}`)).toBe(true);

  // Students & subgroups add up
  for (const g of t.student_groups) {
    expect(t.students.filter((s) => s.groupId === g.id)).toHaveLength(g.studentCount);
    const subs = t.subgroups.filter((sg) => sg.groupId === g.id);
    if (subs.length > 0) expect(subs.reduce((n, sg) => n + sg.studentCount, 0)).toBe(g.studentCount);
  }

  // Weekly load per group fits the free grid (slots − fixed blocks − lunch − unavailable)
  const blocked = t.fixed_blocks.filter((b) => b.appliesTo.all).reduce((n, b) => n + b.duration, 0);
  const periodsByGroup = new Map<string, number>();
  for (const og of t.offering_groups) {
    const o = t.course_offerings.find((x) => x.id === og.offeringId)!;
    periodsByGroup.set(og.groupId, (periodsByGroup.get(og.groupId) ?? 0) + o.periodsPerWeek);
  }
  for (const g of t.student_groups) {
    const free = s.meta.totalSlots - blocked - g.allowedDays.length - (g.unavailableSlots?.length ?? 0);
    expect(periodsByGroup.get(g.id) ?? 0).toBeLessThanOrEqual(free);
  }

  // Teacher load stays within max_weekly_periods
  const load = new Map<string, number>();
  for (const ot of t.offering_teachers) {
    const o = t.course_offerings.find((x) => x.id === ot.offeringId)!;
    load.set(ot.staffId, (load.get(ot.staffId) ?? 0) + o.periodsPerWeek);
  }
  for (const st of t.staff) expect(load.get(st.id) ?? 0).toBeLessThanOrEqual(st.maxWeeklyPeriods ?? 24);

  // meta.counts mirrors table sizes
  for (const name of TABLE_NAMES) expect(s.meta.counts[name]).toBe(t[name].length);
}

describe('scenarios/Q01.json', () => {
  let q01: { raw: string; data: ScenarioDataset };
  beforeAll(async () => {
    q01 = await loadScenario('Q01');
  });

  it('has the exact Q01 counts', () => {
    const t = q01.data.tables;
    expect(q01.data.code).toBe('Q01');
    expect(t.departments).toHaveLength(1);
    expect(t.student_groups).toHaveLength(4);
    expect(t.student_groups.filter((g) => g.level === 'ปวช.' && g.lunchPeriod === 4)).toHaveLength(2);
    expect(t.student_groups.filter((g) => g.level === 'ปวส.' && g.lunchPeriod === 5)).toHaveLength(2);
    expect(t.staff).toHaveLength(8);
    expect(t.rooms).toHaveLength(6);
    const typeCode = new Map(t.room_types.map((r) => [r.id, r.code]));
    expect(t.rooms.filter((r) => typeCode.get(r.roomTypeId) === 'theory')).toHaveLength(4);
    expect(t.rooms.filter((r) => typeCode.get(r.roomTypeId)!.startsWith('lab_'))).toHaveLength(2);
    expect(new Set(t.rooms.map((r) => r.buildingId)).size).toBe(2);
    expect(t.buildings).toHaveLength(2);
    expect(t.time_slots).toHaveLength(8);
    expect(t.time_slots.map((s) => s.period)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(t.time_slots.every((s) => s.shift === 'day' && s.openDays.join() === '1,2,3,4,5')).toBe(true);
    expect(t.time_slots.reduce((n, s) => n + s.openDays.length, 0)).toBe(40);
    expect(q01.data.meta.totalSlots).toBe(40);
    expect(t.room_types.map((r) => r.code).sort()).toEqual(
      ['activity_yard', 'lab_ai', 'lab_com', 'lab_graphic', 'lab_network', 'lecture_hall', 'theory'],
    );
    expect(t.subjects.length).toBeGreaterThanOrEqual(20);
    expect(t.course_offerings.length).toBeGreaterThanOrEqual(30);
    expect(t.course_offerings.some((o) => o.offeringType === 'split')).toBe(true);
  });

  it('ships competition & default constraint profiles covering H01–H21 and S01–S13', () => {
    const cc = q01.data.tables.constraint_configs;
    for (const profile of ['competition', 'default']) {
      const codes = cc.filter((c) => c.profileName === profile).map((c) => c.code);
      expect(codes).toHaveLength(34);
    }
    const competition = new Map(cc.filter((c) => c.profileName === 'competition').map((c) => [c.code, c]));
    expect(competition.get('H14')).toMatchObject({ mode: 'hard', params: { maxConsecutive: 3 } });
    expect(competition.get('S07')).toMatchObject({ mode: 'soft', weight: 20 });
    const def = new Map(cc.filter((c) => c.profileName === 'default').map((c) => [c.code, c]));
    expect(def.get('H14')).toMatchObject({ mode: 'soft', params: { maxConsecutive: 4 } });
    expect(def.get('H21')?.mode).toBe('off');
  });

  it('has 5 demo accounts with verifiable password hashes', () => {
    const { accounts } = q01.data.tables;
    expect(accounts.map((a) => a.role).sort()).toEqual(['admin', 'scheduler', 'student', 'teacher', 'viewer']);
    for (const demo of q01.data.demoAccounts) {
      const account = accounts.find((a) => a.username === demo.username)!;
      expect(account.passwordHash).not.toContain(demo.password);
      expect(verifyPassword(demo.password, account.passwordHash)).toBe(true);
      expect(verifyPassword('wrong-password', account.passwordHash)).toBe(false);
    }
  });

  it('is referentially consistent', () => checkReferentialIntegrity(q01.data));

  it('is deterministic (file equals a fresh build)', () => {
    expect(q01.raw).toBe(`${JSON.stringify(buildQ01(), null, 2)}\n`);
  });
});

describe('scenarios/Q21.json', () => {
  let q21: { raw: string; data: ScenarioDataset };
  beforeAll(async () => {
    q21 = await loadScenario('Q21');
  });

  it('has the exact Q21 counts', () => {
    const t = q21.data.tables;
    expect(q21.data.code).toBe('Q21');
    expect(t.departments).toHaveLength(10);
    expect(t.student_groups).toHaveLength(60);
    expect(t.staff).toHaveLength(120);
    expect(t.rooms).toHaveLength(70);
    expect(q21.data.meta.totalSlots).toBe(40);
    expect(t.time_slots).toHaveLength(8);
    const typeCode = new Map(t.room_types.map((r) => [r.id, r.code]));
    const usedTypes = new Set(t.rooms.map((r) => typeCode.get(r.roomTypeId)));
    expect([...usedTypes].sort()).toEqual(['activity_yard', 'lab_ai', 'lab_com', 'lab_graphic', 'lab_network', 'lecture_hall', 'theory']);
    expect(new Set(t.rooms.map((r) => r.buildingId)).size).toBeGreaterThanOrEqual(4);
    expect(t.course_offerings.some((o) => o.offeringType === 'combined')).toBe(true);
    expect(t.subgroups.length).toBeGreaterThan(0);
    expect(t.accounts).toHaveLength(5);
    expect(t.constraint_configs).toHaveLength(68);
  });

  it('is referentially consistent', () => checkReferentialIntegrity(q21.data));

  it('is deterministic (file equals a fresh build)', () => {
    expect(q21.raw).toBe(`${JSON.stringify(buildQ21(), null, 2)}\n`);
  });
});

describe('scenario → 7-CSV round trip', () => {
  it.each([
    ['Q01', buildQ01],
    ['Q21', buildQ21],
  ] as const)('%s passes the Data Check with zero errors', (_code, build) => {
    const scenario = build();
    const bundle = parseDataset7(scenarioToDataset7Files(scenario));
    const result = validateDataset7(bundle);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.stats.totalFiles).toBe(7);
    expect(result.stats.counts.student_group).toBe(scenario.tables.student_groups.length);
    expect(result.stats.counts.teacher).toBe(scenario.tables.staff.length);
    expect(result.stats.counts.room).toBe(scenario.tables.rooms.length);
    expect(result.stats.counts.register).toBe(scenario.tables.course_offerings.length);
    expect(result.stats.counts.timeslot).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 7-CSV parser
// ---------------------------------------------------------------------------

/** Small, valid 7-CSV dataset with English headers. 5 days × 6 periods, period 4 = lunch. */
function cleanEnglishFiles(): Record<string, string> {
  const timeslotRows: string[] = [];
  for (let d = 1; d <= 5; d++) {
    for (let p = 1; p <= 6; p++) {
      timeslotRows.push(`${d},${p},${String(7 + p).padStart(2, '0')}:00,${String(8 + p).padStart(2, '0')}:00,${p === 4 ? 'lunch' : 'class'}`);
    }
  }
  return {
    timeslot: csv('day,period,start_time,end_time,type', ...timeslotRows),
    student_group: csv(
      'group_code,group_name,student_count,level,unavailable_slots',
      'G1,IT ปวช.1/1,30,ปวช.,',
      'G2,IT ปวช.1/2,25,ปวช.,"5:5;5:6"',
    ),
    register: csv('offering_code,subject_code,group_code', 'R1,S1,G1', 'R2,S2,G1', 'R3,S1,G2', 'R4,S3,"G1;G2"'),
    subject: csv(
      'subject_code,subject_name,theory_hours,practice_hours,credits,room_type,consecutive',
      'S1,ภาษาไทย,2,0,2,,false',
      'S2,การเขียนโปรแกรม,1,3,2,lab_com,true',
      'S3,คณิตศาสตร์,2,0,2,,false',
    ),
    teacher: csv('teacher_code,full_name,unavailable_slots', 'T1,ครูหนึ่ง,1:1-2', 'T2,ครูสอง,', 'T3,ครูสาม,'),
    teach: csv('teacher_code,subject_code,group_code', 'T1,S1,', 'T2,S2,', 'T3,S3,', 'T1,S3,'),
    room: csv('room_code,building,capacity,room_type', 'R101,B1,40,theory', 'LAB1,B1,35,lab_com', 'HALL,B2,60,lecture_hall'),
  };
}

describe('parseDataset7', () => {
  it('parses standard English headers', () => {
    const bundle = parseDataset7(cleanEnglishFiles());
    expect(bundle.parseIssues).toEqual([]);
    expect(bundle.presentFiles).toEqual([...DATASET7_FILE_KEYS]);
    expect(bundle.timeslots).toHaveLength(30);
    expect(bundle.timeslots.filter((t) => t.kind === 'lunch')).toHaveLength(5);
    expect(bundle.timeslots[0]).toMatchObject({ day: 1, period: 1, startTime: '08:00', endTime: '09:00', shift: 'day', kind: 'class' });
    expect(bundle.studentGroups[1]).toMatchObject({
      groupCode: 'G2',
      studentCount: 25,
      level: 'ปวช.',
      unavailableSlots: [
        { day: 5, period: 5 },
        { day: 5, period: 6 },
      ],
    });
    expect(bundle.registers[3]).toMatchObject({ offeringCode: 'R4', subjectCode: 'S3', groupCodes: ['G1', 'G2'], rowNo: 5 });
    expect(bundle.subjects[1]).toMatchObject({ theoryHours: 1, practiceHours: 3, credits: 2, requiredRoomType: 'lab_com', mustBeConsecutive: true });
    expect(bundle.teachers[0]!.unavailableSlots).toEqual([
      { day: 1, period: 1 },
      { day: 1, period: 2 },
    ]);
    expect(bundle.teaches[0]).toMatchObject({ teacherCode: 'T1', subjectCode: 'S1', groupCode: null });
    expect(bundle.rooms.map((r) => [r.roomCode, r.capacity, r.roomType])).toEqual([
      ['R101', 40, 'theory'],
      ['LAB1', 35, 'lab_com'],
      ['HALL', 60, 'lecture_hall'],
    ]);
  });

  it('parses Thai headers, UTF-8 BOM, CRLF, blank lines, Thai day names and ท-ป-น notation', () => {
    const bom = '﻿';
    const days = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์'];
    const ts: string[] = [];
    days.forEach((d) => {
      for (let p = 1; p <= 6; p++) ts.push(`${d},${p},${7 + p}.00,${8 + p}.00,${p === 4 ? 'พักกลางวัน' : 'เรียน'}`);
    });
    const files: Dataset7Files = {
      'timeslot.csv': bom + ['วัน,คาบ,เวลาเริ่ม,เวลาสิ้นสุด,ประเภทคาบ', ...ts].join('\r\n'),
      student_group: Buffer.from(
        bom + csv('รหัสกลุ่ม,ชื่อกลุ่ม,จำนวนนักเรียน,ระดับชั้น,คาบไม่ว่าง', '', 'ชพ.1/1,ช่างไฟฟ้า ปวช.1/1,32,ปวช,ศ:5-6', '  ', 'ชพ.2/1,ช่างไฟฟ้า ปวส.1/1,"28",ปวส.,'),
        'utf8',
      ),
      register: csv('รหัสวิชา,กลุ่มเรียน', '20104-2001,ชพ.1/1', '20000-1101,"ชพ.1/1, ชพ.2/1"'),
      subject: csv(
        'รหัสวิชา,ชื่อวิชา,ท-ป-น,ประเภทห้อง,เรียนต่อเนื่อง,หมวดวิชา',
        '20104-2001,เขียนแบบไฟฟ้า,1-3-2,ห้องคอมพิวเตอร์,ใช่,วิชาชีพ',
        '20000-1101,ภาษาไทยพื้นฐาน,1-0-1,,ไม่,สามัญ',
      ),
      teacher: csv('รหัสครู,ชื่อ-นามสกุล,คาบไม่ว่าง', 'T01,นายสมชาย ใจดี,จ:1-2;อา:*', 'T02,นางสาวสุภาพร ศรีสุข,'),
      teach: csv('รหัสครู,รหัสวิชา', 'T01,20104-2001', 'T02,20000-1101'),
      room: csv('รหัสห้อง,อาคาร,ความจุ,ประเภทห้อง', '5-101,อาคาร 5,60,ห้องเรียน', '3-201,อาคาร 3,40,ห้องปฏิบัติการคอมพิวเตอร์'),
    };
    const bundle = parseDataset7(files);
    expect(bundle.parseIssues).toEqual([]);
    expect(bundle.timeslots).toHaveLength(30);
    expect(bundle.timeslots[0]).toMatchObject({ day: 1, period: 1, startTime: '08:00', endTime: '09:00', kind: 'class' });
    expect(bundle.timeslots.find((t) => t.day === 4 && t.period === 4)?.kind).toBe('lunch');
    expect(bundle.studentGroups.map((g) => [g.groupCode, g.studentCount, g.level])).toEqual([
      ['ชพ.1/1', 32, 'ปวช.'],
      ['ชพ.2/1', 28, 'ปวส.'],
    ]);
    expect(bundle.studentGroups[0]!.unavailableSlots).toEqual([
      { day: 5, period: 5 },
      { day: 5, period: 6 },
    ]);
    expect(bundle.registers[1]!.groupCodes).toEqual(['ชพ.1/1', 'ชพ.2/1']);
    expect(bundle.subjects[0]).toMatchObject({
      subjectCode: '20104-2001',
      theoryHours: 1,
      practiceHours: 3,
      credits: 2,
      requiredRoomType: 'lab_com',
      mustBeConsecutive: true,
      category: 'core',
    });
    expect(bundle.subjects[1]).toMatchObject({ theoryHours: 1, practiceHours: 0, credits: 1, requiredRoomType: null, category: 'general' });
    expect(bundle.teachers[0]!.unavailableSlots.filter((s) => s.day === 7)).toHaveLength(12);
    expect(bundle.rooms.map((r) => r.roomType)).toEqual(['theory', 'lab_com']);
    expect(validateDataset7(bundle).valid).toBe(true);
  });

  it('applies custom ColumnMapping overrides (and reports MISSING_COLUMN without them)', () => {
    const files = {
      ...cleanEnglishFiles(),
      student_group: csv('Kelas,Pax,Tingkat', 'G1,30,ปวช.', 'G2,25,ปวช.'),
      room: csv('Bilik,Muatan,Jenis', 'R101,40,theory', 'LAB1,35,lab_com', 'HALL,60,lecture_hall'),
    };
    const withoutOverride = parseDataset7(files);
    const missing = issuesOf(withoutOverride.parseIssues, 'MISSING_COLUMN');
    expect(missing.map((i) => i.file).sort()).toEqual(['room', 'room', 'student_group', 'student_group']);
    expectThaiIssue(missing[0]);

    const overrides = {
      student_group: { groupCode: 'Kelas', studentCount: ['Pax'], level: 'Tingkat' },
      room: { roomCode: 'Bilik', capacity: 'Muatan', roomType: 'Jenis' },
    };
    const bundle = parseDataset7(files, overrides);
    expect(bundle.parseIssues).toEqual([]);
    expect(bundle.studentGroups.map((g) => [g.groupCode, g.studentCount])).toEqual([
      ['G1', 30],
      ['G2', 25],
    ]);
    expect(bundle.rooms[2]).toMatchObject({ roomCode: 'HALL', capacity: 60, roomType: 'lecture_hall' });
    expect(validateDataset7(bundle).valid).toBe(true);

    const merged = mergeColumnMapping(overrides);
    expect(merged.student_group.groupCode[0]).toBe('Kelas');
    expect(merged.student_group.groupCode).toContain('group_code');
    expect(DEFAULT_COLUMN_MAPPING.student_group.groupCode[0]).toBe('group_code'); // defaults untouched
  });

  it('parses slot lists and combined group cells in all supported notations', () => {
    expect(parseSlotList('1:3; 2-4 | Mon:5-6').slots).toEqual([
      { day: 1, period: 3 },
      { day: 1, period: 5 },
      { day: 1, period: 6 },
      { day: 2, period: 4 },
    ]);
    expect(parseSlotList('[{"day":3,"period":2},[4,1],"ศ:8"]').slots).toEqual([
      { day: 3, period: 2 },
      { day: 4, period: 1 },
      { day: 5, period: 8 },
    ]);
    expect(parseSlotList('9:1;1:99;xyz').invalid).toEqual(['9:1', '1:99', 'xyz']);
    expect(splitGroupCodes('ชพ.1/1; ชพ.1/2,ชพ.1/3|ชพ.1/1')).toEqual(['ชพ.1/1', 'ชพ.1/2', 'ชพ.1/3']);
  });

  it('reports malformed rows as INVALID_ROW and drops rows whose required values are broken', () => {
    const files = {
      ...cleanEnglishFiles(),
      room: csv('room_code,building,capacity,room_type', 'R101,B1,40,theory', 'BAD,B1,abc,theory', 'LAB1,B1,35,lab_com', 'HALL,B2,60,lecture_hall'),
    };
    const bundle = parseDataset7(files);
    const invalid = issuesOf(bundle.parseIssues, 'INVALID_ROW');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ severity: 'error', file: 'room', row: 3 });
    expectThaiIssue(invalid[0]);
    expect(bundle.rooms.map((r) => r.roomCode)).toEqual(['R101', 'LAB1', 'HALL']);
  });

  it('reports MISSING_FILE for absent files', () => {
    const { room: _room, ...rest } = cleanEnglishFiles();
    const result = validateDataset7(parseDataset7(rest));
    expect(result.valid).toBe(false);
    const missing = issuesOf(result.issues, 'MISSING_FILE');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.file).toBe('room');
    expectThaiIssue(missing[0]);
    expect(result.stats.totalFiles).toBe(6);
  });
});

describe('loadDataset7FromDir', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ptc-ds7-'));
    const files = cleanEnglishFiles();
    const names: Record<string, string> = {
      timeslot: 'TimeSlot.CSV',
      student_group: 'student-groups.csv',
      register: 'register.csv',
      subject: 'Subjects.csv',
      teacher: 'teacher.csv',
      teach: 'teach.csv',
      room: 'rooms.csv',
    };
    for (const [key, name] of Object.entries(names)) await writeFile(path.join(dir, name), `﻿${files[key]!}`, 'utf8');
    await writeFile(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads all 7 CSVs from a directory (case-insensitive file names, BOM) and validates cleanly', async () => {
    const bundle = await loadDataset7FromDir(dir);
    expect(bundle.presentFiles).toHaveLength(7);
    expect(bundle.parseIssues).toEqual([]);
    expect(bundle.studentGroups[0]!.groupCode).toBe('G1');
    expect(validateDataset7(bundle).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Data Check validator
// ---------------------------------------------------------------------------

describe('validateDataset7', () => {
  it('returns valid=true with zero issues on a clean dataset', () => {
    const result = validateDataset7(parseDataset7(cleanEnglishFiles()));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.stats).toMatchObject({
      totalFiles: 7,
      errorCount: 0,
      warningCount: 0,
      counts: { timeslot: 30, student_group: 2, register: 4, subject: 3, teacher: 3, teach: 4, room: 3 },
      classSlotsPerWeek: 25,
      totalWeeklyPeriods: 2 + 4 + 2 + 2,
    });
  });

  describe('detects cross-file errors with Thai messages and suggestions', () => {
    const base = cleanEnglishFiles();
    const files = {
      ...base,
      // G3 is too big for any room, G4 can only study on Friday (5 class slots).
      student_group: csv(
        'group_code,group_name,student_count,level,unavailable_slots',
        'G1,IT ปวช.1/1,30,ปวช.,',
        'G2,IT ปวช.1/2,25,ปวช.,"5:5;5:6"',
        'G3,IT ปวส.1/1,80,ปวส.,',
        'G4,IT ปวส.2/1,20,ปวส.,"จ:*;อ:*;พ:*;พฤ:*"',
      ),
      register: csv(
        'offering_code,subject_code,group_code',
        'R1,S1,G1',
        'R2,S2,G1',
        'R3,S1,G2',
        'R4,S3,"G1;G2"',
        'R5,S9,G1', // missing subject (typo of S1/S2/S3)
        'R6,S4,G2', // S4 exists but nobody may teach it
        'R7,S1,G3',
        'R8,S2,G4',
        'R9,S1,G4', // G4: 4 + 2 = 6 periods > 5 available
        'R10,S1,GX', // missing group
      ),
      subject: `${base.subject}S4,ฟิสิกส์,2,0,2,,false\n`,
      teacher: `${base.teacher}T1,ครูหนึ่ง (ซ้ำ),\n`, // duplicate code
      teach: `${base.teach}T9,S1,\n`, // unknown teacher
    };
    const result = validateDataset7(parseDataset7(files));

    it('is invalid and counts errors/warnings in stats', () => {
      expect(result.valid).toBe(false);
      expect(result.stats.errorCount).toBe(result.issues.filter((i) => i.severity === 'error').length);
      expect(result.stats.warningCount).toBe(result.issues.filter((i) => i.severity === 'warning').length);
      expect(result.stats.errorCount).toBeGreaterThanOrEqual(7);
      // errors are listed before warnings
      const firstWarning = result.issues.findIndex((i) => i.severity === 'warning');
      if (firstWarning >= 0) expect(result.issues.slice(firstWarning).every((i) => i.severity === 'warning')).toBe(true);
    });

    it('MISSING_SUBJECT (with similar-code suggestion)', () => {
      const issue = issuesOf(result.issues, 'MISSING_SUBJECT')[0];
      expectThaiIssue(issue);
      expect(issue).toMatchObject({ severity: 'error', file: 'register', row: 6 });
      expect(issue.message).toContain('S9');
      expect(issue.suggestions.join(' ')).toMatch(/S1|S2|S3/);
    });

    it('MISSING_GROUP', () => {
      const issue = issuesOf(result.issues, 'MISSING_GROUP')[0];
      expectThaiIssue(issue);
      expect(issue).toMatchObject({ severity: 'error', file: 'register', row: 11 });
      expect(issue.message).toContain('GX');
    });

    it('MISSING_ELIGIBLE_TEACHER and UNKNOWN_TEACHER_REF', () => {
      const missing = issuesOf(result.issues, 'MISSING_ELIGIBLE_TEACHER');
      expect(missing).toHaveLength(1);
      expectThaiIssue(missing[0]);
      expect(missing[0]).toMatchObject({ severity: 'error', file: 'register', row: 7 });
      expect(missing[0]!.message).toContain('S4');

      const unknown = issuesOf(result.issues, 'UNKNOWN_TEACHER_REF')[0];
      expectThaiIssue(unknown);
      expect(unknown).toMatchObject({ severity: 'error', file: 'teach' });
      expect(unknown.message).toContain('T9');
    });

    it('NO_SUFFICIENT_ROOM_CAPACITY', () => {
      const issue = issuesOf(result.issues, 'NO_SUFFICIENT_ROOM_CAPACITY').find((i) => i.file === 'student_group');
      expectThaiIssue(issue);
      expect(issue).toMatchObject({ severity: 'error', row: 4 });
      expect(issue.message).toContain('G3');
      expect(issue.message).toContain('80');
    });

    it('HOURS_EXCEED_AVAILABLE_SLOTS', () => {
      const issues = issuesOf(result.issues, 'HOURS_EXCEED_AVAILABLE_SLOTS');
      expect(issues).toHaveLength(1);
      expectThaiIssue(issues[0]);
      expect(issues[0]).toMatchObject({ severity: 'error', file: 'student_group', row: 5 });
      expect(issues[0]!.message).toContain('6');
      expect(issues[0]!.message).toContain('5');
    });

    it('DUP_CODE', () => {
      const issue = issuesOf(result.issues, 'DUP_CODE').find((i) => i.file === 'teacher');
      expectThaiIssue(issue);
      expect(issue).toMatchObject({ severity: 'error', row: 5 });
      expect(issue.message).toContain('T1');
    });
  });

  it('warns TEACHER_OVERLOAD_RISK when a sole eligible teacher exceeds max weekly periods', () => {
    const base = cleanEnglishFiles();
    const groups = Array.from({ length: 8 }, (_, i) => `H${i + 1},Group ${i + 1},30,ปวช.,`);
    const files = {
      ...base,
      student_group: csv('group_code,group_name,student_count,level,unavailable_slots', ...groups),
      register: csv('subject_code,group_code', ...groups.map((_, i) => `S2,H${i + 1}`)), // 8 × 4 = 32 periods
      teacher: csv('teacher_code,full_name,max_weekly_periods', 'T1,ครูหนึ่ง,', 'T2,ครูสอง,24', 'T3,ครูสาม,'),
      room: csv('room_code,capacity,room_type', 'R101,40,theory', 'LAB1,40,lab_com'),
    };
    const result = validateDataset7(parseDataset7(files));
    const overload = issuesOf(result.issues, 'TEACHER_OVERLOAD_RISK');
    expect(overload).toHaveLength(1);
    expectThaiIssue(overload[0]);
    expect(overload[0]).toMatchObject({ severity: 'warning', file: 'teacher', row: 3 });
    expect(overload[0]!.message).toContain('T2');
    expect(overload[0]!.message).toContain('32');
    expect(result.valid).toBe(true); // warnings do not block import
  });
});
