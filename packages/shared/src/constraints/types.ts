/**
 * Constraint Engine types (Phase 2).
 *
 * The same evaluation code runs on the Client (drag & drop preview), the Server
 * (Validator) and the Worker (Solver fitness), so every result is plain JSON.
 */
import type { MessageParams } from '../explain/messages.th';
import type {
  Building,
  ConstraintCode,
  ConstraintConfig,
  ConstraintMode,
  CourseOffering,
  Department,
  ElectiveEnrollment,
  FixedBlock,
  JsonObject,
  OfferingGroup,
  OfferingTeacher,
  OccupancyResourceType,
  Room,
  RoomType,
  ScheduleItem,
  ScheduleItemTeacher,
  Staff,
  Student,
  StudentGroup,
  Subgroup,
  Subject,
  TeacherSubjectEligibility,
  Term,
  TimeSlot,
  XaiExplanationEntry,
} from '../types';
import type { EvaluationIndex } from './context';

export type ConstraintKind = 'hard' | 'soft';
export type ActiveConstraintMode = Exclude<ConstraintMode, 'off'>;

/** Built-in preset names (custom profile names from `constraint_configs` are allowed too). */
export type BuiltInProfileName = 'competition' | 'default' | 'teacher_first' | 'room_first';

export type ConstraintCategory =
  | 'clash'
  | 'room'
  | 'time'
  | 'teacher'
  | 'student'
  | 'curriculum'
  | 'stability';

export interface ConstraintCatalogEntry {
  code: ConstraintCode;
  kind: ConstraintKind;
  /** English identifier, e.g. `TEACHER_CLASH`. */
  key: string;
  nameTh: string;
  descriptionTh: string;
  category: ConstraintCategory;
  defaultMode: ConstraintMode;
  /** Weight used whenever the code runs in `soft` mode and no weight is configured. */
  defaultWeight: number;
  defaultParams: JsonObject;
  /** Hard codes that may be downgraded to `soft` (advisory flag for the Rule UI). */
  supportsSoftMode: boolean;
}

/** One code after merging catalog defaults → profile preset → explicit configs → overrides. */
export interface ResolvedConstraintConfig {
  code: ConstraintCode;
  mode: ConstraintMode;
  weight: number;
  params: JsonObject;
  source: 'catalog' | 'profile' | 'config' | 'override';
}

export type ResolvedConstraintConfigMap = Record<ConstraintCode, ResolvedConstraintConfig>;

export interface ConstraintOverride {
  mode?: ConstraintMode;
  weight?: number;
  params?: JsonObject;
}

export interface ScheduleEvaluationContext {
  term: Term;
  timeSlots: TimeSlot[];
  departments: Department[];
  buildings: Building[];
  roomTypes: RoomType[];
  rooms: Room[];
  staff: Staff[];
  studentGroups: StudentGroup[];
  subgroups: Subgroup[];
  students: Student[];
  subjects: Subject[];
  offerings: CourseOffering[];
  offeringGroups: OfferingGroup[];
  offeringTeachers: OfferingTeacher[];
  eligibilities: TeacherSubjectEligibility[];
  electiveEnrollments: ElectiveEnrollment[];
  fixedBlocks: FixedBlock[];
  /** Solution under evaluation (`schedule_items` of one version). */
  items: ScheduleItem[];
  itemTeachers: ScheduleItemTeacher[];
  /** Previous published version (S07 MIN_CHANGES). */
  baselineItems?: ScheduleItem[];
  baselineItemTeachers?: ScheduleItemTeacher[];
  /** Profile to use; defaults to the profile of `constraintConfigs[0]`, else `competition`. */
  profileName?: string;
  /** Rows from `constraint_configs`; only rows whose `profileName` matches are applied. */
  constraintConfigs?: ConstraintConfig[];
  /** Final per-code overrides (Rule Builder / API), applied last. */
  overrides?: Partial<Record<ConstraintCode, ConstraintOverride>>;
}

export type ViolationResourceType = OccupancyResourceType | 'offering' | 'student' | 'item';

export interface ConstraintViolation {
  code: ConstraintCode;
  name: string;
  mode: ActiveConstraintMode;
  /** Penalty units of this violation (1 per clash cell, per extra period, …). */
  severity: number;
  itemIds: string[];
  offeringId?: string;
  resourceType?: ViolationResourceType;
  resourceId?: string;
  day?: number;
  period?: number;
  messageKey: string;
  params: MessageParams;
  messageTh: string;
}

/** What an evaluator returns; the engine adds code, name, mode and Thai text. */
export interface ViolationDraft {
  messageKey: string;
  params: MessageParams;
  itemIds: string[];
  severity?: number;
  offeringId?: string;
  resourceType?: ViolationResourceType;
  resourceId?: string;
  day?: number;
  period?: number;
}

export interface EvaluatorInput {
  ctx: ScheduleEvaluationContext;
  index: EvaluationIndex;
  params: JsonObject;
  mode: ActiveConstraintMode;
}

export type ConstraintEvaluator = (input: EvaluatorInput) => ViolationDraft[];

export interface SoftPenaltyDetail {
  code: ConstraintCode;
  name: string;
  weight: number;
  rawPenalty: number;
  weightedPenalty: number;
  violations: ConstraintViolation[];
  messageTh: string;
}

export interface MultiObjectiveMetrics {
  /** Teacher-days without S05/S06 violations ÷ teacher-days with teaching (0..1). */
  teacherSatisfaction: number;
  /** Scheduled room-hours ÷ total available room-hours (0..1). */
  roomUtilization: number;
  teacherDays: number;
  satisfiedTeacherDays: number;
  scheduledRoomHours: number;
  availableRoomHours: number;
}

export interface UnplacedOffering {
  offeringId: string;
  subjectId: string;
  requiredPeriods: number;
  scheduledPeriods: number;
  missingPeriods: number;
}

export interface EvaluationReport {
  profileName: string;
  configs: ResolvedConstraintConfigMap;
  hardViolations: ConstraintViolation[];
  hardCount: number;
  hardCountsByCode: Partial<Record<ConstraintCode, number>>;
  softPenalties: SoftPenaltyDetail[];
  totalPenalty: number;
  /** `1000 / (1 + totalPenalty)` */
  fitness: number;
  multiObjective: MultiObjectiveMetrics;
  /** itemId → deterministic XAI entries (JSON for `schedule_items.explanation`). */
  itemExplanations: Record<string, XaiExplanationEntry[]>;
  unplacedOfferings: UnplacedOffering[];
}

export interface EvaluateOptions {
  /** Add `passed: true` entries for every active code to each item explanation (default true). */
  includePassedExplanations?: boolean;
}

// ---------------------------------------------------------------------------
// Quality Summary (Screen 14) — 4 dimensions
// ---------------------------------------------------------------------------

export interface ConflictDetectionSummary {
  teacherClashes: number;
  roomClashes: number;
  groupClashes: number;
  totalClashes: number;
  passed: boolean;
}

export type HardCodeStatus = 'pass' | 'fail' | 'soft' | 'off';

export interface HardConstraintStatus {
  code: ConstraintCode;
  name: string;
  nameTh: string;
  mode: ConstraintMode;
  violations: number;
  status: HardCodeStatus;
  passed: boolean;
}

export interface ConstraintValidationSummary {
  codes: HardConstraintStatus[];
  failedCodes: ConstraintCode[];
  passed: boolean;
}

export interface ScheduleCompletenessSummary {
  requiredHours: number;
  scheduledHours: number;
  completenessPct: number;
  unplacedCount: number;
  unplacedOfferings: number;
  passed: boolean;
}

export interface SoftBreakdownEntry {
  code: ConstraintCode;
  name: string;
  nameTh: string;
  weight: number;
  rawPenalty: number;
  weightedPenalty: number;
}

export interface PerformanceSummary {
  durationMs: number;
  memoryMb: number;
  softBreakdown: {
    items: SoftBreakdownEntry[];
    totalPenalty: number;
    fitness: number;
  };
}

export interface QualitySummary4D {
  profileName: string;
  conflictDetection: ConflictDetectionSummary;
  constraintValidation: ConstraintValidationSummary;
  scheduleCompleteness: ScheduleCompletenessSummary;
  performance: PerformanceSummary;
  multiObjective: MultiObjectiveMetrics;
  passed: boolean;
}

export interface PerformanceInput {
  durationMs?: number;
  memoryMb?: number;
}
