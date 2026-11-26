import type {
  AccountRole,
  AgentLogEntry,
  ChallengeCategory,
  ChallengeMode,
  ChallengeRule,
  CourseOffering,
  Dataset7ValidationResult,
  Department,
  EvaluationReport,
  FixedBlock,
  IssueCategory,
  IssueReport,
  OfferingGroup,
  OfferingTeacher,
  QualitySummary4D,
  Room,
  RoomType,
  ScheduleItem,
  ScheduleItemTeacher,
  ScheduleVersion,
  SchedulingAlgorithm,
  SchedulingRun,
  Staff,
  StudentGroup,
  Subgroup,
  Subject,
  TeacherSubjectEligibility,
  Term,
  TimeSlot,
} from '@ptc/shared';

export interface AuthSession {
  user: {
    accountId: string;
    username: string;
    role: AccountRole;
    staffId: string | null;
    studentId: string | null;
    isPublicGuest: boolean;
  } | null;
  publicDemoMode: boolean;
}

export interface DashboardData {
  term: Term;
  activeVersion: ScheduleVersion | null;
  versionsCount: number;
  runsCount: number;
  latestRun: SchedulingRun | null;
  counts: {
    departments: number;
    groups: number;
    staff: number;
    rooms: number;
    subjects: number;
    offerings: number;
    scheduledItems: number;
    unplacedItems: number;
  };
  report: {
    profileName: string;
    hardCount: number;
    totalPenalty: number;
    fitness: number;
    multiObjective: {
      teacherSatisfaction: number;
      roomUtilization: number;
    };
  };
  qualitySummary: QualitySummary4D;
  profiles: string[];
}

export interface ScheduleWorkspacePayload {
  version: ScheduleVersion | null;
  versions: ScheduleVersion[];
  context: {
    term: Term;
    timeSlots: TimeSlot[];
    departments: Department[];
    buildings: Array<{ id: string; code: string | null; name: string }>;
    roomTypes: RoomType[];
    rooms: Room[];
    staff: Staff[];
    studentGroups: StudentGroup[];
    subgroups: Subgroup[];
    subjects: Subject[];
    offerings: CourseOffering[];
    offeringGroups: OfferingGroup[];
    offeringTeachers: OfferingTeacher[];
    eligibilities: TeacherSubjectEligibility[];
    fixedBlocks: FixedBlock[];
    items: ScheduleItem[];
    itemTeachers: ScheduleItemTeacher[];
  };
  report: EvaluationReport;
  qualitySummary: QualitySummary4D;
}

export interface FixOption {
  optionIndex: number;
  labelTh: string;
  descriptionTh: string;
  movedItemsCount: number;
  deltaPenalty: number;
  hardCount: number;
  changes: Array<{ itemId: string; day: number | null; startPeriod: number | null; roomId: string | null; teacherIds: string[] }>;
}

export interface ChallengeImpactResponse {
  violationCount: number;
  violatedItemIds: string[];
  affectedGroupIds: string[];
  affectedStaffIds: string[];
  hardViolations: EvaluationReport['hardViolations'];
}

export interface ChallengeApplyResponse {
  versionId: string;
  diff: {
    movedCount: number;
    movedItems: Array<{
      itemId: string;
      offeringId: string;
      subjectCode: string;
      subjectName: string;
      beforeText: string;
      afterText: string;
      reasonTh: string;
    }>;
    beforeHardCount: number;
    afterHardCount: number;
    beforePenalty: number;
    afterPenalty: number;
    beforeFitness: number;
    afterFitness: number;
    affectedGroupCount: number;
    affectedTeacherCount: number;
  };
  report: EvaluationReport;
  qualitySummary: QualitySummary4D;
}

export interface ScenarioCatalogItem {
  code: string;
  title: string;
  focus: string;
  demonstration: string;
  loadableDataset: 'Q01' | 'Q21';
}

export interface RunResponse {
  run: SchedulingRun;
  versionId: string;
  versionName: string;
  report: EvaluationReport;
  qualitySummary: QualitySummary4D;
  agentLog: AgentLogEntry[];
}

export interface BenchmarkResultRow {
  algorithm: string;
  profileName: string;
  runs: Array<{
    seed: number;
    durationMs: number;
    hardCount: number;
    penalty: number;
    fitness: number;
    teacherSat: number;
    roomUtil: number;
  }>;
  summary: {
    durationMs: { mean: number; sd: number };
    hardCount: { mean: number; sd: number };
    fitness: { mean: number; sd: number };
    penalty: { mean: number; sd: number };
    teacherSat: number;
    roomUtil: number;
  };
}

export type {
  AccountRole,
  ChallengeCategory,
  ChallengeMode,
  ChallengeRule,
  Dataset7ValidationResult,
  IssueCategory,
  IssueReport,
  SchedulingAlgorithm,
  SchedulingRun,
};
