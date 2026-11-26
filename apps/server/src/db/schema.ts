/**
 * PTC Smart Schedule V4 — 30-table schema (TiDB Serverless / MySQL 8).
 * Source of truth: CLAUDE.md "Database Schema". Column nullability follows the spec literally:
 * NOT NULL only for PKs, FKs not marked `NULL`, and columns declared `NOT NULL`.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  customType,
  date,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  time,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type {
  AgentLogEntry,
  DataCheckIssue,
  FixedBlockAppliesTo,
  ImportPreviewStats,
  JsonObject,
  SlotRef,
  XaiExplanationEntry,
} from '@ptc/shared';

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const uuid = (name: string) => varchar(name, { length: 36 });
const pk = () => uuid('id').primaryKey();
/** `TIMESTAMP` as `YYYY-MM-DD HH:MM:SS` strings (JSON/scenario friendly). */
const ts = (name: string) => timestamp(name, { mode: 'string' });
const createdAt = () => ts('created_at').default(sql`CURRENT_TIMESTAMP`);
const dateStr = (name: string) => date(name, { mode: 'string' });

/**
 * `VARBINARY(255)` holding encrypted bytes. Exposed as `Uint8Array` (mysql2 returns a `Buffer`,
 * which is a `Uint8Array`) so the row type matches the browser-safe shared `Staff` interface.
 */
const varbinary255 = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'varbinary(255)';
  },
  toDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
});

// ---------------------------------------------------------------------------
// 1. Calendar & Time
// ---------------------------------------------------------------------------

export const terms = mysqlTable(
  'terms',
  {
    id: pk(),
    academicYear: int('academic_year').notNull(),
    semester: tinyint('semester').notNull(),
    startDate: dateStr('start_date').notNull(),
    endDate: dateStr('end_date').notNull(),
  },
  (t) => [uniqueIndex('uq_term').on(t.academicYear, t.semester)],
);

export const timeSlots = mysqlTable(
  'time_slots',
  {
    id: pk(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id),
    period: int('period').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    shift: mysqlEnum('shift', ['day', 'evening']).notNull(),
    openDays: json('open_days').$type<number[]>().notNull(),
  },
  (t) => [uniqueIndex('uq_slot').on(t.termId, t.period)],
);

// ---------------------------------------------------------------------------
// 2. Places
// ---------------------------------------------------------------------------

export const departments = mysqlTable('departments', {
  id: pk(),
  code: varchar('code', { length: 20 }).unique(),
  name: varchar('name', { length: 100 }).notNull(),
});

export const buildings = mysqlTable('buildings', {
  id: pk(),
  code: varchar('code', { length: 10 }).unique(),
  name: varchar('name', { length: 100 }).notNull(),
});

export const roomTypes = mysqlTable('room_types', {
  id: pk(),
  code: varchar('code', { length: 30 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  isLab: boolean('is_lab').default(false),
});

export const rooms = mysqlTable('rooms', {
  id: pk(),
  roomCode: varchar('room_code', { length: 30 }).notNull().unique(),
  buildingId: uuid('building_id')
    .notNull()
    .references(() => buildings.id),
  roomTypeId: uuid('room_type_id')
    .notNull()
    .references(() => roomTypes.id),
  capacity: int('capacity').notNull(),
  allowMultiGroup: boolean('allow_multi_group').default(false),
  features: json('features').$type<string[]>(),
  unavailableSlots: json('unavailable_slots').$type<SlotRef[]>(),
});

// ---------------------------------------------------------------------------
// 3. Staff, Accounts & PDPA
// ---------------------------------------------------------------------------

export const staff = mysqlTable('staff', {
  id: pk(),
  employeeCode: varchar('employee_code', { length: 20 }).notNull().unique(),
  fullName: varchar('full_name', { length: 150 }).notNull(),
  departmentId: uuid('department_id').references(() => departments.id),
  position: varchar('position', { length: 100 }),
  staffType: mysqlEnum('staff_type', ['teacher', 'guest_lecturer', 'staff']).default('teacher'),
  phoneEncrypted: varbinary255('phone_encrypted'),
  maxDailyPeriods: int('max_daily_periods').default(6),
  maxConsecutive: int('max_consecutive').default(3),
  maxWeeklyPeriods: int('max_weekly_periods').default(24),
  dayOff: tinyint('day_off'),
  availableSlots: json('available_slots').$type<SlotRef[]>(),
  unavailableSlots: json('unavailable_slots').$type<SlotRef[]>(),
});

export const accounts = mysqlTable('accounts', {
  id: pk(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['admin', 'scheduler', 'teacher', 'student', 'viewer']).notNull(),
  staffId: uuid('staff_id'),
  studentId: uuid('student_id'),
  lastLoginAt: ts('last_login_at'),
});

export const consentRecords = mysqlTable('consent_records', {
  id: pk(),
  accountId: uuid('account_id').notNull(),
  policyVersion: varchar('policy_version', { length: 20 }).notNull(),
  consentedAt: ts('consented_at').notNull(),
  withdrawnAt: ts('withdrawn_at'),
});

export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: pk(),
    accountId: uuid('account_id'),
    action: varchar('action', { length: 50 }).notNull(),
    entity: varchar('entity', { length: 50 }),
    entityId: uuid('entity_id'),
    beforeData: json('before_data').$type<JsonObject>(),
    afterData: json('after_data').$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (t) => [index('idx_audit_entity').on(t.entity, t.entityId)],
);

// ---------------------------------------------------------------------------
// 4. Students & Groups
// ---------------------------------------------------------------------------

export const studentGroups = mysqlTable('student_groups', {
  id: pk(),
  groupCode: varchar('group_code', { length: 30 }).notNull().unique(),
  departmentId: uuid('department_id')
    .notNull()
    .references(() => departments.id),
  level: mysqlEnum('level', ['ปวช.', 'ปวส.']).notNull(),
  yearNo: tinyint('year_no').notNull(),
  programType: mysqlEnum('program_type', ['ปกติ', 'ทวิภาคี', 'ภาคสมทบ']).default('ปกติ'),
  studentCount: int('student_count').notNull(),
  lunchPeriod: int('lunch_period').notNull(),
  allowedDays: json('allowed_days').$type<number[]>().notNull(),
  allowedShift: mysqlEnum('allowed_shift', ['day', 'evening', 'both']).default('day'),
  unavailableSlots: json('unavailable_slots').$type<SlotRef[]>(),
});

export const subgroups = mysqlTable(
  'subgroups',
  {
    id: pk(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => studentGroups.id),
    code: char('code', { length: 1 }).notNull(),
    studentCount: int('student_count').notNull(),
  },
  (t) => [uniqueIndex('uq_sub').on(t.groupId, t.code)],
);

export const students = mysqlTable('students', {
  id: pk(),
  studentCode: varchar('student_code', { length: 20 }).notNull().unique(),
  fullName: varchar('full_name', { length: 150 }).notNull(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => studentGroups.id),
  subgroupId: uuid('subgroup_id'),
});

// ---------------------------------------------------------------------------
// 5. Curriculum & Offerings (Solver input)
// ---------------------------------------------------------------------------

export const subjects = mysqlTable(
  'subjects',
  {
    id: pk(),
    subjectCode: varchar('subject_code', { length: 30 }).notNull(),
    curriculumYear: int('curriculum_year').notNull(),
    subjectName: varchar('subject_name', { length: 200 }).notNull(),
    theoryHours: int('theory_hours').default(0),
    practiceHours: int('practice_hours').default(0),
    credits: int('credits').notNull(),
    category: mysqlEnum('category', ['general', 'core', 'elective', 'activity']).notNull(),
    requiredRoomTypeId: uuid('required_room_type_id'),
    defaultSplit: json('default_split').$type<number[]>(),
    mustBeConsecutive: boolean('must_be_consecutive').default(false),
    timePreference: mysqlEnum('time_preference', ['any', 'morning', 'afternoon']).default('any'),
  },
  (t) => [uniqueIndex('uq_subject').on(t.subjectCode, t.curriculumYear)],
);

export const courseOfferings = mysqlTable('course_offerings', {
  id: pk(),
  termId: uuid('term_id')
    .notNull()
    .references(() => terms.id),
  subjectId: uuid('subject_id')
    .notNull()
    .references(() => subjects.id),
  offeringType: mysqlEnum('offering_type', [
    'regular',
    'combined',
    'split',
    'team',
    'elective_section',
    'activity',
  ]).default('regular'),
  periodsPerWeek: int('periods_per_week').notNull(),
  splitPattern: json('split_pattern').$type<number[]>().notNull(),
  roomTypeId: uuid('room_type_id'),
  sectionNo: int('section_no'),
  maxStudents: int('max_students'),
});

export const offeringGroups = mysqlTable(
  'offering_groups',
  {
    offeringId: uuid('offering_id').notNull(),
    groupId: uuid('group_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.offeringId, t.groupId] })],
);

export const offeringTeachers = mysqlTable(
  'offering_teachers',
  {
    offeringId: uuid('offering_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    subgroupCode: char('subgroup_code', { length: 1 }),
    role: mysqlEnum('role', ['main', 'co']).default('main'),
  },
  (t) => [primaryKey({ columns: [t.offeringId, t.staffId] })],
);

export const electiveEnrollments = mysqlTable(
  'elective_enrollments',
  {
    studentId: uuid('student_id').notNull(),
    termId: uuid('term_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    offeringId: uuid('offering_id'),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.termId] })],
);

export const fixedBlocks = mysqlTable('fixed_blocks', {
  id: pk(),
  termId: uuid('term_id').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  blockType: mysqlEnum('block_type', ['activity', 'elective_block', 'closed']).notNull(),
  dayOfWeek: tinyint('day_of_week').notNull(),
  startPeriod: int('start_period').notNull(),
  duration: int('duration').notNull(),
  roomId: uuid('room_id'),
  appliesTo: json('applies_to').$type<FixedBlockAppliesTo>().notNull(),
});

export const teacherSubjectEligibility = mysqlTable(
  'teacher_subject_eligibility',
  {
    staffId: uuid('staff_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    groupId: uuid('group_id'),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.subjectId] })],
);

// ---------------------------------------------------------------------------
// 6. Scheduling Runs & Results
// ---------------------------------------------------------------------------

export const constraintConfigs = mysqlTable(
  'constraint_configs',
  {
    id: pk(),
    profileName: varchar('profile_name', { length: 50 }).notNull(),
    code: varchar('code', { length: 40 }).notNull(),
    mode: mysqlEnum('mode', ['hard', 'soft', 'off']).notNull(),
    weight: int('weight').default(0),
    params: json('params').$type<JsonObject>(),
  },
  (t) => [uniqueIndex('uq_cc').on(t.profileName, t.code)],
);

export const scheduleVersions = mysqlTable('schedule_versions', {
  id: pk(),
  termId: uuid('term_id').notNull(),
  name: varchar('name', { length: 150 }).notNull(),
  source: mysqlEnum('source', ['run', 'manual', 'restore', 'repair']).notNull(),
  status: mysqlEnum('status', ['draft', 'published', 'archived']).default('draft'),
  parentVersionId: uuid('parent_version_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const schedulingRuns = mysqlTable('scheduling_runs', {
  id: pk(),
  termId: uuid('term_id').notNull(),
  scenarioCode: varchar('scenario_code', { length: 30 }),
  algorithm: mysqlEnum('algorithm', ['greedy', 'csp_ga', 'csp_sa', 'cpsat']).notNull(),
  profileName: varchar('profile_name', { length: 50 }).notNull(),
  seed: int('seed').notNull(),
  maxIterations: int('max_iterations').notNull(),
  timeLimitSec: int('time_limit_sec').default(180),
  status: mysqlEnum('status', ['queued', 'running', 'done', 'failed', 'cancelled']).default('queued'),
  progressPct: tinyint('progress_pct').default(0),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  durationMs: int('duration_ms'),
  hardViolations: int('hard_violations'),
  softScore: decimal('soft_score', { precision: 12, scale: 2, mode: 'number' }),
  fitness: decimal('fitness', { precision: 12, scale: 4, mode: 'number' }),
  unplacedCount: int('unplaced_count'),
  metrics: json('metrics').$type<JsonObject>(),
  agentLog: json('agent_log').$type<AgentLogEntry[]>(),
  versionId: uuid('version_id'),
});

export const scheduleItems = mysqlTable(
  'schedule_items',
  {
    id: pk(),
    versionId: uuid('version_id').notNull(),
    offeringId: uuid('offering_id').notNull(),
    segmentIndex: tinyint('segment_index').notNull(),
    subgroupId: uuid('subgroup_id'),
    roomId: uuid('room_id'),
    dayOfWeek: tinyint('day_of_week'),
    startPeriod: int('start_period'),
    duration: int('duration').notNull(),
    status: mysqlEnum('status', ['scheduled', 'unplaced_tray']).default('scheduled'),
    isLocked: boolean('is_locked').default(false),
    explanation: json('explanation').$type<XaiExplanationEntry[]>(),
    rowVersion: int('row_version').default(1),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('idx_items_version').on(t.versionId, t.status)],
);

export const scheduleItemTeachers = mysqlTable(
  'schedule_item_teachers',
  {
    itemId: uuid('item_id').notNull(),
    staffId: uuid('staff_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.staffId] })],
);

export const slotOccupancy = mysqlTable(
  'slot_occupancy',
  {
    versionId: uuid('version_id').notNull(),
    dayOfWeek: tinyint('day_of_week').notNull(),
    period: int('period').notNull(),
    resourceType: mysqlEnum('resource_type', ['teacher', 'group', 'subgroup', 'room']).notNull(),
    resourceId: uuid('resource_id').notNull(),
    itemId: uuid('item_id').notNull(),
  },
  (t) => [
    uniqueIndex('uq_no_clash').on(t.versionId, t.dayOfWeek, t.period, t.resourceType, t.resourceId),
    index('idx_occ_item').on(t.itemId),
  ],
);

// ---------------------------------------------------------------------------
// 7. Issues, Imports & Lucky Challenge
// ---------------------------------------------------------------------------

export const issueReports = mysqlTable('issue_reports', {
  id: pk(),
  reporterId: uuid('reporter_id').notNull(),
  category: mysqlEnum('category', [
    'teacher_leave',
    'room_outage',
    'schedule_conflict',
    'system_bug',
  ]).notNull(),
  affectedDate: dateStr('affected_date').notNull(),
  affectedStaffId: uuid('affected_staff_id'),
  affectedRoomId: uuid('affected_room_id'),
  description: text('description'),
  status: mysqlEnum('status', ['open', 'proposed', 'applied', 'closed']).default('open'),
  agentProposal: json('agent_proposal').$type<JsonObject>(),
  createdAt: createdAt(),
});

export const scheduleExceptions = mysqlTable('schedule_exceptions', {
  id: pk(),
  versionId: uuid('version_id').notNull(),
  issueId: uuid('issue_id'),
  itemId: uuid('item_id').notNull(),
  exceptionDate: dateStr('exception_date').notNull(),
  action: mysqlEnum('action', ['substitute', 'room_change', 'makeup', 'cancel']).notNull(),
  substituteStaffId: uuid('substitute_staff_id'),
  newRoomId: uuid('new_room_id'),
  makeupDate: dateStr('makeup_date'),
  makeupPeriod: int('makeup_period'),
});

export const importJobs = mysqlTable('import_jobs', {
  id: pk(),
  fileName: varchar('file_name', { length: 200 }).notNull(),
  status: mysqlEnum('status', ['uploaded', 'validated', 'has_errors', 'committed']).notNull(),
  stats: json('stats').$type<ImportPreviewStats>(),
  issues: json('issues').$type<DataCheckIssue[]>(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const challengeRules = mysqlTable('challenge_rules', {
  id: pk(),
  termId: uuid('term_id').notNull(),
  category: mysqlEnum('category', ['time', 'room', 'subject', 'teacher']).notNull(),
  ruleType: varchar('rule_type', { length: 40 }).notNull(),
  target: json('target').$type<JsonObject>().notNull(),
  params: json('params').$type<JsonObject>().notNull(),
  mode: mysqlEnum('mode', ['hard', 'soft']).default('hard'),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Registry — SQL table name → table object, in FK dependency order (parents first).
// ---------------------------------------------------------------------------

export const SCHEMA_TABLES = {
  terms,
  time_slots: timeSlots,
  departments,
  buildings,
  room_types: roomTypes,
  rooms,
  staff,
  accounts,
  consent_records: consentRecords,
  audit_logs: auditLogs,
  student_groups: studentGroups,
  subgroups,
  students,
  subjects,
  course_offerings: courseOfferings,
  offering_groups: offeringGroups,
  offering_teachers: offeringTeachers,
  elective_enrollments: electiveEnrollments,
  fixed_blocks: fixedBlocks,
  teacher_subject_eligibility: teacherSubjectEligibility,
  constraint_configs: constraintConfigs,
  schedule_versions: scheduleVersions,
  scheduling_runs: schedulingRuns,
  schedule_items: scheduleItems,
  schedule_item_teachers: scheduleItemTeachers,
  slot_occupancy: slotOccupancy,
  issue_reports: issueReports,
  schedule_exceptions: scheduleExceptions,
  import_jobs: importJobs,
  challenge_rules: challengeRules,
} as const;

export type SchemaTables = typeof SCHEMA_TABLES;
export type SchemaTableName = keyof SchemaTables;
