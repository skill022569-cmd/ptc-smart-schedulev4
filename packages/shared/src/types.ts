/**
 * PTC Smart Schedule V4 — shared domain types.
 *
 * Row interfaces mirror the 30-table Drizzle schema in `apps/server/src/db/schema.ts`
 * (camelCase property ↔ snake_case column). Nullability follows CLAUDE.md literally:
 * a column is non-null only when it is a PK, an FK without `NULL`, or declared `NOT NULL`.
 * Dates are `YYYY-MM-DD` strings, times `HH:MM:SS`, timestamps `YYYY-MM-DD HH:MM:SS`.
 */

// ---------------------------------------------------------------------------
// Primitive enums & value objects
// ---------------------------------------------------------------------------

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Shift = 'day' | 'evening';
export type AllowedShift = 'day' | 'evening' | 'both';
export type RoomTypeCode =
  | 'theory'
  | 'lecture_hall'
  | 'lab_com'
  | 'lab_network'
  | 'lab_ai'
  | 'lab_graphic'
  | 'activity_yard';
export type StaffType = 'teacher' | 'guest_lecturer' | 'staff';
export type AccountRole = 'admin' | 'scheduler' | 'teacher' | 'student' | 'viewer';
export type EducationLevel = 'ปวช.' | 'ปวส.';
export type ProgramType = 'ปกติ' | 'ทวิภาคี' | 'ภาคสมทบ';
export type SubjectCategory = 'general' | 'core' | 'elective' | 'activity';
export type TimePreference = 'any' | 'morning' | 'afternoon';
export type OfferingType = 'regular' | 'combined' | 'split' | 'team' | 'elective_section' | 'activity';
export type TeacherRole = 'main' | 'co';
export type FixedBlockType = 'activity' | 'elective_block' | 'closed';
export type ConstraintMode = 'hard' | 'soft' | 'off';
export type ScheduleVersionSource = 'run' | 'manual' | 'restore' | 'repair';
export type ScheduleVersionStatus = 'draft' | 'published' | 'archived';
export type SchedulingAlgorithm = 'greedy' | 'csp_ga' | 'csp_sa' | 'cpsat';
export type SchedulingRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type ScheduleItemStatus = 'scheduled' | 'unplaced_tray';
export type OccupancyResourceType = 'teacher' | 'group' | 'subgroup' | 'room';
export type IssueCategory = 'teacher_leave' | 'room_outage' | 'schedule_conflict' | 'system_bug';
export type IssueStatus = 'open' | 'proposed' | 'applied' | 'closed';
export type ExceptionAction = 'substitute' | 'room_change' | 'makeup' | 'cancel';
export type ImportJobStatus = 'uploaded' | 'validated' | 'has_errors' | 'committed';
export type ChallengeCategory = 'time' | 'room' | 'subject' | 'teacher';
export type ChallengeMode = 'hard' | 'soft';

/** One (day, period) cell of the weekly grid. */
export interface SlotRef {
  day: number;
  period: number;
}

/** Target selector stored in `fixed_blocks.applies_to`. Empty selector = nobody. */
export interface FixedBlockAppliesTo {
  all?: boolean;
  groupIds?: string[];
  levels?: EducationLevel[];
  departmentIds?: string[];
  staffIds?: string[];
}

export type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Constraint catalog identifiers (evaluators arrive in Phase 2)
// ---------------------------------------------------------------------------

export const HARD_CONSTRAINT_NAMES = {
  H01: 'TEACHER_CLASH',
  H02: 'ROOM_CLASH',
  H03: 'GROUP_CLASH',
  H04: 'ROOM_CAPACITY',
  H05: 'ROOM_TYPE',
  H06: 'LUNCH_BREAK',
  H07: 'AVAILABILITY',
  H08: 'FIXED_BLOCK',
  H09: 'CONSECUTIVE',
  H10: 'ALLOWED_DAYS',
  H11: 'TEAM_TEACHING',
  H12: 'BUILDING_GAP',
  H13: 'TEACHER_DAILY_MAX',
  H14: 'TEACHER_CONSECUTIVE',
  H15: 'DAY_OFF',
  H16: 'EVENING_AFTER_DAY',
  H17: 'ELECTIVE_CLASH',
  H18: 'REGISTERED_ONLY',
  H19: 'ELIGIBLE_TEACHER',
  H20: 'HOURS_COMPLETE',
  H21: 'GROUP_AVAILABILITY',
} as const;

export const SOFT_CONSTRAINT_NAMES = {
  S01: 'STUDENT_GAPS',
  S02: 'SUBJECT_SPREAD',
  S03: 'TIME_PREFERENCE',
  S04: 'ROOM_BEST_FIT',
  S05: 'TEACHER_LUNCH',
  S06: 'TEACHER_LOAD',
  S07: 'MIN_CHANGES',
  S08: 'TEACHER_GAPS',
  S09: 'THEORY_STREAK',
  S10: 'ROOM_CHANGES',
  S11: 'CONTENT_SEQUENCE',
  S12: 'DAY_SPAN',
  S13: 'GROUP_DAILY_BALANCE',
} as const;

export type HardConstraintCode = keyof typeof HARD_CONSTRAINT_NAMES;
export type SoftConstraintCode = keyof typeof SOFT_CONSTRAINT_NAMES;
export type ConstraintCode = HardConstraintCode | SoftConstraintCode;

// ---------------------------------------------------------------------------
// 1. Calendar & Time
// ---------------------------------------------------------------------------

export interface Term {
  id: string;
  academicYear: number;
  semester: number;
  startDate: string;
  endDate: string;
}

export interface TimeSlot {
  id: string;
  termId: string;
  period: number;
  startTime: string;
  endTime: string;
  shift: Shift;
  openDays: number[];
}

// ---------------------------------------------------------------------------
// 2. Places
// ---------------------------------------------------------------------------

export interface Department {
  id: string;
  code: string | null;
  name: string;
}

export interface Building {
  id: string;
  code: string | null;
  name: string;
}

export interface RoomType {
  id: string;
  code: string;
  name: string;
  isLab: boolean | null;
}

export interface Room {
  id: string;
  roomCode: string;
  buildingId: string;
  roomTypeId: string;
  capacity: number;
  allowMultiGroup: boolean | null;
  features: string[] | null;
  unavailableSlots: SlotRef[] | null;
}

// ---------------------------------------------------------------------------
// 3. Staff, Accounts & PDPA
// ---------------------------------------------------------------------------

export interface Staff {
  id: string;
  employeeCode: string;
  fullName: string;
  departmentId: string | null;
  position: string | null;
  staffType: StaffType | null;
  /** AES-encrypted phone number (Buffer on the server). Always null in scenario JSON. */
  phoneEncrypted: Uint8Array | null;
  maxDailyPeriods: number | null;
  maxConsecutive: number | null;
  maxWeeklyPeriods: number | null;
  dayOff: number | null;
  availableSlots: SlotRef[] | null;
  unavailableSlots: SlotRef[] | null;
}

export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  role: AccountRole;
  staffId: string | null;
  studentId: string | null;
  lastLoginAt: string | null;
}

export interface ConsentRecord {
  id: string;
  accountId: string;
  policyVersion: string;
  consentedAt: string;
  withdrawnAt: string | null;
}

export interface AuditLog {
  id: string;
  accountId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  beforeData: JsonObject | null;
  afterData: JsonObject | null;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// 4. Students & Groups
// ---------------------------------------------------------------------------

export interface StudentGroup {
  id: string;
  groupCode: string;
  departmentId: string;
  level: EducationLevel;
  yearNo: number;
  programType: ProgramType | null;
  studentCount: number;
  lunchPeriod: number;
  allowedDays: number[];
  allowedShift: AllowedShift | null;
  unavailableSlots: SlotRef[] | null;
}

export interface Subgroup {
  id: string;
  groupId: string;
  code: string;
  studentCount: number;
}

export interface Student {
  id: string;
  studentCode: string;
  fullName: string;
  groupId: string;
  subgroupId: string | null;
}

// ---------------------------------------------------------------------------
// 5. Curriculum & Offerings (Solver input)
// ---------------------------------------------------------------------------

export interface Subject {
  id: string;
  subjectCode: string;
  curriculumYear: number;
  subjectName: string;
  theoryHours: number | null;
  practiceHours: number | null;
  credits: number;
  category: SubjectCategory;
  requiredRoomTypeId: string | null;
  defaultSplit: number[] | null;
  mustBeConsecutive: boolean | null;
  timePreference: TimePreference | null;
}

export interface CourseOffering {
  id: string;
  termId: string;
  subjectId: string;
  offeringType: OfferingType | null;
  periodsPerWeek: number;
  splitPattern: number[];
  roomTypeId: string | null;
  sectionNo: number | null;
  maxStudents: number | null;
}

export interface OfferingGroup {
  offeringId: string;
  groupId: string;
}

export interface OfferingTeacher {
  offeringId: string;
  staffId: string;
  subgroupCode: string | null;
  role: TeacherRole | null;
}

export interface ElectiveEnrollment {
  studentId: string;
  termId: string;
  subjectId: string;
  offeringId: string | null;
}

export interface FixedBlock {
  id: string;
  termId: string;
  name: string;
  blockType: FixedBlockType;
  dayOfWeek: number;
  startPeriod: number;
  duration: number;
  roomId: string | null;
  appliesTo: FixedBlockAppliesTo;
}

export interface TeacherSubjectEligibility {
  staffId: string;
  subjectId: string;
  groupId: string | null;
}

// ---------------------------------------------------------------------------
// 6. Scheduling Runs & Results
// ---------------------------------------------------------------------------

export interface ConstraintConfig {
  id: string;
  profileName: string;
  code: string;
  mode: ConstraintMode;
  weight: number | null;
  params: JsonObject | null;
}

export interface ScheduleVersion {
  id: string;
  termId: string;
  name: string;
  source: ScheduleVersionSource;
  status: ScheduleVersionStatus | null;
  parentVersionId: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

/** One step of the Planner → Solver → Validator → Repair pipeline log. */
export interface AgentLogEntry {
  at: string;
  agent: 'planner' | 'solver' | 'validator' | 'repair' | 'system';
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: JsonObject;
}

export interface SchedulingRun {
  id: string;
  termId: string;
  scenarioCode: string | null;
  algorithm: SchedulingAlgorithm;
  profileName: string;
  seed: number;
  maxIterations: number;
  timeLimitSec: number | null;
  status: SchedulingRunStatus | null;
  progressPct: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  hardViolations: number | null;
  softScore: number | null;
  fitness: number | null;
  unplacedCount: number | null;
  metrics: JsonObject | null;
  agentLog: AgentLogEntry[] | null;
  versionId: string | null;
}

/**
 * Deterministic XAI entry stored in `schedule_items.explanation`.
 * Rendered into Thai text by `messages.th.ts` templates (Phase 2/4) — never by an LLM.
 */
export interface XaiExplanationEntry {
  code: ConstraintCode;
  mode: Exclude<ConstraintMode, 'off'>;
  passed: boolean;
  /** Template key, e.g. `H01.violation` or `S01.penalty`. */
  messageKey: string;
  params: Record<string, string | number | boolean | null>;
  penalty?: number;
  weight?: number;
  /** Pre-rendered Thai message (optional cache of the template output). */
  messageTh?: string;
}

export interface ScheduleItem {
  id: string;
  versionId: string;
  offeringId: string;
  segmentIndex: number;
  subgroupId: string | null;
  roomId: string | null;
  dayOfWeek: number | null;
  startPeriod: number | null;
  duration: number;
  status: ScheduleItemStatus | null;
  isLocked: boolean | null;
  explanation: XaiExplanationEntry[] | null;
  rowVersion: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ScheduleItemTeacher {
  itemId: string;
  staffId: string;
}

export interface SlotOccupancy {
  versionId: string;
  dayOfWeek: number;
  period: number;
  resourceType: OccupancyResourceType;
  resourceId: string;
  itemId: string;
}

// ---------------------------------------------------------------------------
// 7. Issues, Imports & Lucky Challenge
// ---------------------------------------------------------------------------

export interface IssueReport {
  id: string;
  reporterId: string;
  category: IssueCategory;
  affectedDate: string;
  affectedStaffId: string | null;
  affectedRoomId: string | null;
  description: string | null;
  status: IssueStatus | null;
  agentProposal: JsonObject | null;
  createdAt: string | null;
}

export interface ScheduleException {
  id: string;
  versionId: string;
  issueId: string | null;
  itemId: string;
  exceptionDate: string;
  action: ExceptionAction;
  substituteStaffId: string | null;
  newRoomId: string | null;
  makeupDate: string | null;
  makeupPeriod: number | null;
}

export interface ImportJob {
  id: string;
  fileName: string;
  status: ImportJobStatus;
  stats: ImportPreviewStats | null;
  issues: DataCheckIssue[] | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface ChallengeRule {
  id: string;
  termId: string;
  category: ChallengeCategory;
  ruleType: string;
  target: JsonObject;
  params: JsonObject;
  mode: ChallengeMode | null;
  description: string | null;
  isActive: boolean | null;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// Table registry (30 tables)
// ---------------------------------------------------------------------------

/** SQL table name → row interface. Order = FK dependency order (parents first). */
export interface TableRowMap {
  terms: Term;
  time_slots: TimeSlot;
  departments: Department;
  buildings: Building;
  room_types: RoomType;
  rooms: Room;
  staff: Staff;
  accounts: Account;
  consent_records: ConsentRecord;
  audit_logs: AuditLog;
  student_groups: StudentGroup;
  subgroups: Subgroup;
  students: Student;
  subjects: Subject;
  course_offerings: CourseOffering;
  offering_groups: OfferingGroup;
  offering_teachers: OfferingTeacher;
  elective_enrollments: ElectiveEnrollment;
  fixed_blocks: FixedBlock;
  teacher_subject_eligibility: TeacherSubjectEligibility;
  constraint_configs: ConstraintConfig;
  schedule_versions: ScheduleVersion;
  scheduling_runs: SchedulingRun;
  schedule_items: ScheduleItem;
  schedule_item_teachers: ScheduleItemTeacher;
  slot_occupancy: SlotOccupancy;
  issue_reports: IssueReport;
  schedule_exceptions: ScheduleException;
  import_jobs: ImportJob;
  challenge_rules: ChallengeRule;
}

export type TableName = keyof TableRowMap;

export const TABLE_NAMES = [
  'terms',
  'time_slots',
  'departments',
  'buildings',
  'room_types',
  'rooms',
  'staff',
  'accounts',
  'consent_records',
  'audit_logs',
  'student_groups',
  'subgroups',
  'students',
  'subjects',
  'course_offerings',
  'offering_groups',
  'offering_teachers',
  'elective_enrollments',
  'fixed_blocks',
  'teacher_subject_eligibility',
  'constraint_configs',
  'schedule_versions',
  'scheduling_runs',
  'schedule_items',
  'schedule_item_teachers',
  'slot_occupancy',
  'issue_reports',
  'schedule_exceptions',
  'import_jobs',
  'challenge_rules',
] as const satisfies readonly TableName[];

// ---------------------------------------------------------------------------
// Competition 7-CSV dataset
// ---------------------------------------------------------------------------

export const DATASET7_FILE_KEYS = [
  'timeslot',
  'student_group',
  'register',
  'subject',
  'teacher',
  'teach',
  'room',
] as const;

export type Dataset7FileKey = (typeof DATASET7_FILE_KEYS)[number];
export type Dataset7FileName = `${Dataset7FileKey}.csv`;

/** Raw file contents keyed by `timeslot` or `timeslot.csv` etc. */
export type Dataset7Files = Partial<Record<Dataset7FileKey | Dataset7FileName, string | Uint8Array>>;

export type TimeslotKind = 'class' | 'lunch' | 'break';

/** Common metadata kept on every parsed CSV row (1-based line number in the source file). */
export interface CsvRowMeta {
  rowNo: number;
}

/** `timeslot.csv` — one row per (day, period). */
export interface TimeslotCsvRow extends CsvRowMeta {
  /** `timeslot_id` from the file, echoed back in output.csv. */
  slotId: string | null;
  day: number;
  period: number;
  startTime: string;
  endTime: string;
  shift: Shift;
  kind: TimeslotKind;
}

/** `student_group.csv` */
export interface StudentGroupCsvRow extends CsvRowMeta {
  groupCode: string;
  groupName: string | null;
  departmentCode: string | null;
  level: EducationLevel | null;
  yearNo: number | null;
  studentCount: number;
  lunchPeriod: number | null;
  allowedDays: number[] | null;
  unavailableSlots: SlotRef[];
}

/** `register.csv` — 1 row = 1 offering (several groups = combined class). */
export interface RegisterCsvRow extends CsvRowMeta {
  offeringCode: string | null;
  subjectCode: string;
  groupCodes: string[];
  /** Explicit periods/week; null = theory + practice hours of the subject. */
  periodsPerWeek: number | null;
  sectionNo: number | null;
  teacherCode: string | null;
}

/** `subject.csv` */
export interface SubjectCsvRow extends CsvRowMeta {
  subjectCode: string;
  subjectName: string;
  theoryHours: number;
  practiceHours: number;
  credits: number;
  requiredRoomType: string | null;
  mustBeConsecutive: boolean;
  /** Content-sequence order within a chain (S11), e.g. 1 = must precede 2. */
  sequenceOrder: number | null;
  prerequisiteCode: string | null;
  category: SubjectCategory | null;
}

/** `teacher.csv` */
export interface TeacherCsvRow extends CsvRowMeta {
  teacherCode: string;
  fullName: string;
  departmentCode: string | null;
  maxWeeklyPeriods: number | null;
  unavailableSlots: SlotRef[];
}

/** `teach.csv` — teacher × subject eligibility (optionally limited to one group). */
export interface TeachCsvRow extends CsvRowMeta {
  teacherCode: string;
  subjectCode: string;
  groupCode: string | null;
}

/** `room.csv` */
export interface RoomCsvRow extends CsvRowMeta {
  roomCode: string;
  roomName: string | null;
  buildingCode: string | null;
  capacity: number;
  roomType: string;
}

export interface Dataset7Bundle {
  timeslots: TimeslotCsvRow[];
  studentGroups: StudentGroupCsvRow[];
  registers: RegisterCsvRow[];
  subjects: SubjectCsvRow[];
  teachers: TeacherCsvRow[];
  teaches: TeachCsvRow[];
  rooms: RoomCsvRow[];
  /** Files that were supplied (non-empty). */
  presentFiles: Dataset7FileKey[];
  /** Issues found while parsing (missing file/column, malformed rows). */
  parseIssues: DataCheckIssue[];
}

export interface Dataset7FieldMap {
  timeslot: keyof Omit<TimeslotCsvRow, 'rowNo'>;
  student_group: keyof Omit<StudentGroupCsvRow, 'rowNo'>;
  register: keyof Omit<RegisterCsvRow, 'rowNo'>;
  subject: keyof Omit<SubjectCsvRow, 'rowNo'>;
  teacher: keyof Omit<TeacherCsvRow, 'rowNo'>;
  teach: keyof Omit<TeachCsvRow, 'rowNo'>;
  room: keyof Omit<RoomCsvRow, 'rowNo'>;
}

/** For each file and normalized field: accepted header names (aliases, case-insensitive). */
export type Dataset7ColumnMapping = {
  [F in Dataset7FileKey]: Record<Dataset7FieldMap[F], string[]>;
};

/** Partial override from UI/API: a field may be remapped to one header or a list of headers. */
export type Dataset7ColumnMappingOverrides = {
  [F in Dataset7FileKey]?: Partial<Record<Dataset7FieldMap[F], string | string[]>>;
};

export type DataCheckSeverity = 'error' | 'warning';

export type DataCheckCode =
  | 'MISSING_FILE'
  | 'MISSING_COLUMN'
  | 'DUP_CODE'
  | 'INVALID_ROW'
  | 'MISSING_SUBJECT'
  | 'MISSING_GROUP'
  | 'MISSING_ELIGIBLE_TEACHER'
  | 'UNKNOWN_TEACHER_REF'
  | 'MISSING_ROOM_TYPE'
  | 'NO_SUFFICIENT_ROOM_CAPACITY'
  | 'HOURS_EXCEED_AVAILABLE_SLOTS'
  | 'TEACHER_OVERLOAD_RISK';

export interface DataCheckIssue {
  severity: DataCheckSeverity;
  code: DataCheckCode;
  file: Dataset7FileKey;
  /** 1-based line number in the CSV (header = line 1). */
  row?: number;
  /** Thai, human-readable explanation. */
  message: string;
  /** Actionable Thai suggestions on how to fix the problem. */
  suggestions: string[];
}

export interface ImportPreviewStats {
  totalFiles: number;
  counts: Record<Dataset7FileKey, number>;
  errorCount: number;
  warningCount: number;
  issuesByCode: Partial<Record<DataCheckCode, number>>;
  /** Total registered periods per week across all offerings. */
  totalWeeklyPeriods: number;
  /** Teaching (non-lunch/break) slots per week in timeslot.csv. */
  classSlotsPerWeek: number;
  /** Set on commit: `${day}-${period}` -> original timeslot_id, used by output.csv. */
  timeslotIds?: Record<string, string>;
}

export interface Dataset7ValidationResult {
  valid: boolean;
  issues: DataCheckIssue[];
  stats: ImportPreviewStats;
}

// ---------------------------------------------------------------------------
// Deterministic scenario datasets (scenarios/Qxx.json)
// ---------------------------------------------------------------------------

export type ScenarioTables = { [K in TableName]: TableRowMap[K][] };

export interface ScenarioDemoAccount {
  username: string;
  role: AccountRole;
  /** Plain demo password for the public practice mode (hash is stored in `accounts`). */
  password: string;
}

export interface ScenarioMeta {
  days: number[];
  periodsPerDay: number;
  /** days × periods (grid cells) = Σ time_slots.openDays.length. */
  totalSlots: number;
  lunchPeriodByLevel: Record<EducationLevel, number>;
  rngSeed: number;
  counts: Record<TableName, number>;
}

export interface ScenarioDataset {
  code: string;
  name: string;
  description: string;
  schemaVersion: 1;
  meta: ScenarioMeta;
  demoAccounts: ScenarioDemoAccount[];
  tables: ScenarioTables;
}
