import { desc, eq } from 'drizzle-orm';
import {
  TABLE_NAMES,
  buildQualitySummary4D,
  evaluateSchedule,
  type ChallengeRule,
  type EvaluationReport,
  type QualitySummary4D,
  type ConstraintOverride,
  type ConstraintCode,
  type CourseOffering,
  type Dataset7Bundle,
  type Department,
  type FixedBlock,
  type ImportJob,
  type IssueReport,
  type OfferingGroup,
  type OfferingTeacher,
  type Room,
  type RoomType,
  type ScheduleEvaluationContext,
  type ScheduleItem,
  type ScheduleItemTeacher,
  type ScheduleVersion,
  type SchedulingRun,
  type Staff,
  type Student,
  type StudentGroup,
  type Subject,
  type TeacherSubjectEligibility,
  type Term,
  type TimeSlot,
} from '@ptc/shared';
import { db } from '../db/client';
import {
  buildings,
  challengeRules,
  constraintConfigs,
  courseOfferings,
  departments,
  electiveEnrollments,
  fixedBlocks,
  importJobs,
  issueReports,
  offeringGroups,
  offeringTeachers,
  roomTypes,
  rooms,
  scheduleItemTeachers,
  scheduleItems,
  scheduleVersions,
  schedulingRuns,
  staff,
  studentGroups,
  students,
  subgroups,
  subjects,
  teacherSubjectEligibility,
  terms,
  timeSlots,
} from '../db/schema';
import { buildCanonicalConstraintConfigs } from '../db/seed';
import { stableId } from '../db/scenario-builder';
import { SCHEMA_TABLES } from '../db/schema';

export interface LoadedWorkspace {
  ctx: ScheduleEvaluationContext;
  versions: ScheduleVersion[];
  activeVersion: ScheduleVersion | null;
  runs: SchedulingRun[];
  challengeRules: ChallengeRule[];
  issues: IssueReport[];
}

function toStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v == null ? '' : String(v);
}

function toTimestampStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  return String(v);
}

// ---- Warm in-memory workspace + evaluation cache ---------------------------

const WORKSPACE_TTL_MS = 30_000;
const VERSIONS_LIMIT = 50;
const RUNS_LIMIT = 50;
const ISSUES_LIMIT = 100;

/** Profile-independent snapshot of everything `loadContextFromDb` reads from TiDB. */
type BaseSnapshot = Omit<LoadedWorkspace, 'ctx'> & {
  ctx: Omit<ScheduleEvaluationContext, 'profileName' | 'overrides'>;
};

let cacheEpoch = 0;
const snapshotCache = new Map<string, { snapshot: BaseSnapshot; expiresAt: number }>();
const snapshotInFlight = new Map<string, { epoch: number; promise: Promise<BaseSnapshot> }>();
const evaluationCache = new Map<
  string,
  { report: EvaluationReport; qualitySummary: QualitySummary4D; expiresAt: number }
>();
/** Contexts built by `loadContextFromDb` → the version + epoch they were loaded at. */
const loadedCtxMeta = new WeakMap<ScheduleEvaluationContext, { versionId: string | null; epoch: number }>();

/** Drop every cached workspace snapshot / evaluation. Call after any DB mutation. */
export function invalidateWorkspaceCache(): void {
  cacheEpoch += 1;
  snapshotCache.clear();
  snapshotInFlight.clear();
  evaluationCache.clear();
}

/**
 * `evaluateSchedule` + `buildQualitySummary4D`, memoised for contexts that came straight from
 * `loadContextFromDb` (no overrides, not mutated). Any other context is evaluated fresh.
 */
export function evaluateWorkspaceCached(
  ctx: ScheduleEvaluationContext,
  options: { includePassedExplanations?: boolean } = {},
): { report: EvaluationReport; qualitySummary: QualitySummary4D } {
  const includePassed = options.includePassedExplanations === true;
  const compute = () => {
    const report = evaluateSchedule(ctx, { includePassedExplanations: includePassed });
    return { report, qualitySummary: buildQualitySummary4D(ctx, report) };
  };

  const meta = loadedCtxMeta.get(ctx);
  const hasOverrides = ctx.overrides != null && Object.keys(ctx.overrides).length > 0;
  if (!meta || meta.epoch !== cacheEpoch || hasOverrides) return compute();

  const key = [
    cacheEpoch,
    meta.versionId ?? 'none',
    ctx.profileName ?? 'competition',
    includePassed ? 1 : 0,
    ctx.items.length,
  ].join('|');
  const now = Date.now();
  const hit = evaluationCache.get(key);
  if (hit && hit.expiresAt > now) return { report: hit.report, qualitySummary: hit.qualitySummary };

  const result = compute();
  evaluationCache.set(key, { ...result, expiresAt: now + WORKSPACE_TTL_MS });
  return result;
}

async function getBaseSnapshot(versionId: string | undefined): Promise<BaseSnapshot> {
  const key = versionId ?? '__latest__';
  const now = Date.now();
  const cached = snapshotCache.get(key);
  if (cached && cached.expiresAt > now) return cached.snapshot;

  const pending = snapshotInFlight.get(key);
  if (pending && pending.epoch === cacheEpoch) return pending.promise;

  const epoch = cacheEpoch;
  const promise = fetchBaseSnapshot(versionId)
    .then((snapshot) => {
      // Only keep the result if nothing was invalidated while the queries were running.
      if (epoch === cacheEpoch) {
        snapshotCache.set(key, { snapshot, expiresAt: Date.now() + WORKSPACE_TTL_MS });
      }
      return snapshot;
    })
    .finally(() => {
      if (snapshotInFlight.get(key)?.promise === promise) snapshotInFlight.delete(key);
    });
  snapshotInFlight.set(key, { epoch, promise });
  return promise;
}

/**
 * Load all active term data + optional `versionId` solution from TiDB Serverless
 * into a `@ptc/shared` `ScheduleEvaluationContext`.
 *
 * Served from a 30 s warm snapshot (single-flight); every call gets fresh top-level arrays,
 * so callers may push/filter/replace without corrupting the shared cache.
 */
export async function loadContextFromDb(options: {
  versionId?: string;
  profileName?: string;
  overrides?: Partial<Record<ConstraintCode, ConstraintOverride>>;
} = {}): Promise<LoadedWorkspace> {
  const epoch = cacheEpoch;
  const snap = await getBaseSnapshot(options.versionId);
  const c = snap.ctx;
  const ctx: ScheduleEvaluationContext = {
    term: { ...c.term },
    timeSlots: [...c.timeSlots],
    departments: [...c.departments],
    buildings: [...c.buildings],
    roomTypes: [...c.roomTypes],
    rooms: [...c.rooms],
    staff: [...c.staff],
    studentGroups: [...c.studentGroups],
    subgroups: [...c.subgroups],
    students: [...c.students],
    subjects: [...c.subjects],
    offerings: [...c.offerings],
    offeringGroups: [...c.offeringGroups],
    offeringTeachers: [...c.offeringTeachers],
    eligibilities: [...c.eligibilities],
    electiveEnrollments: [...c.electiveEnrollments],
    fixedBlocks: [...c.fixedBlocks],
    items: [...c.items],
    itemTeachers: [...c.itemTeachers],
    profileName: options.profileName ?? 'competition',
    constraintConfigs: c.constraintConfigs ? [...c.constraintConfigs] : [],
    overrides: options.overrides,
  };
  loadedCtxMeta.set(ctx, { versionId: snap.activeVersion?.id ?? null, epoch });

  return {
    ctx,
    versions: [...snap.versions],
    activeVersion: snap.activeVersion,
    runs: [...snap.runs],
    challengeRules: [...snap.challengeRules],
    issues: [...snap.issues],
  };
}

async function fetchBaseSnapshot(versionId: string | undefined): Promise<BaseSnapshot> {
  const options = { versionId };
  const [
    termRows,
    slotRows,
    deptRows,
    bldgRows,
    rtRows,
    roomRows,
    staffRows,
    groupRows,
    subRows,
    { enrollRows, studentRows },
    subjRows,
    offRows,
    ogRows,
    otRows,
    eligRows,
    fbRows,
    ccRows,
    versionRows,
    runRows,
    ruleRows,
    issueRows,
  ] = await Promise.all([
    db.select().from(terms),
    db.select().from(timeSlots),
    db.select().from(departments),
    db.select().from(buildings),
    db.select().from(roomTypes),
    db.select().from(rooms),
    db.select().from(staff),
    db.select().from(studentGroups),
    db.select().from(subgroups),
    // Students are only needed to resolve elective enrollments (H17); skip the large
    // `students` table entirely when there are none (Q01/Q21).
    db
      .select()
      .from(electiveEnrollments)
      .then(async (enrolls) => ({
        enrollRows: enrolls,
        studentRows: (enrolls.length > 0 ? await db.select().from(students) : []) as Student[],
      })),
    db.select().from(subjects),
    db.select().from(courseOfferings),
    db.select().from(offeringGroups),
    db.select().from(offeringTeachers),
    db.select().from(teacherSubjectEligibility),
    db.select().from(fixedBlocks),
    db.select().from(constraintConfigs),
    db.select().from(scheduleVersions).orderBy(desc(scheduleVersions.createdAt)).limit(VERSIONS_LIMIT),
    db.select().from(schedulingRuns).orderBy(desc(schedulingRuns.startedAt)).limit(RUNS_LIMIT),
    db.select().from(challengeRules).orderBy(desc(challengeRules.createdAt)),
    db.select().from(issueReports).orderBy(desc(issueReports.createdAt)).limit(ISSUES_LIMIT),
  ]);

  const rawTerm = termRows[0];
  const term: Term = rawTerm
    ? {
        id: rawTerm.id,
        academicYear: rawTerm.academicYear,
        semester: rawTerm.semester,
        startDate: toStr(rawTerm.startDate),
        endDate: toStr(rawTerm.endDate),
      }
    : { id: 'term-empty', academicYear: 2569, semester: 2, startDate: '2026-11-02', endDate: '2027-03-12' };

  const mappedVersions: ScheduleVersion[] = versionRows.map((v) => ({
    ...v,
    createdAt: toTimestampStr(v.createdAt),
  }));

  // `versions` is capped at VERSIONS_LIMIT; fall back to a direct lookup so an older
  // requested / published version still resolves exactly as before.
  const lookupVersion = async (
    where: ReturnType<typeof eq>,
  ): Promise<ScheduleVersion | undefined> => {
    const rows = await db
      .select()
      .from(scheduleVersions)
      .where(where)
      .orderBy(desc(scheduleVersions.createdAt))
      .limit(1);
    const v = rows[0];
    return v ? { ...v, createdAt: toTimestampStr(v.createdAt) } : undefined;
  };
  const truncatedVersions = versionRows.length >= VERSIONS_LIMIT;
  let requested: ScheduleVersion | undefined;
  if (options.versionId) {
    requested = mappedVersions.find((v) => v.id === options.versionId);
    if (!requested && truncatedVersions) requested = await lookupVersion(eq(scheduleVersions.id, options.versionId));
  }
  let published: ScheduleVersion | undefined;
  if (!requested) {
    published = mappedVersions.find((v) => v.status === 'published');
    if (!published && truncatedVersions) published = await lookupVersion(eq(scheduleVersions.status, 'published'));
  }
  const activeVersion = requested ?? published ?? mappedVersions[0] ?? null;

  let items: ScheduleItem[] = [];
  let itemTeachers: ScheduleItemTeacher[] = [];

  if (activeVersion) {
    const [rawItems, rawIt] = await Promise.all([
      db.select().from(scheduleItems).where(eq(scheduleItems.versionId, activeVersion.id)),
      db
        .select({ itemId: scheduleItemTeachers.itemId, staffId: scheduleItemTeachers.staffId })
        .from(scheduleItemTeachers)
        .innerJoin(scheduleItems, eq(scheduleItemTeachers.itemId, scheduleItems.id))
        .where(eq(scheduleItems.versionId, activeVersion.id)),
    ]);
    items = rawItems.map((i) => ({
      ...i,
      updatedAt: toTimestampStr(i.updatedAt),
    }));
    itemTeachers = rawIt;
  }

  const mappedTimeSlots: TimeSlot[] = slotRows.map((s) => ({
    ...s,
    startTime: String(s.startTime),
    endTime: String(s.endTime),
    openDays: s.openDays ?? [],
  }));

  const mappedRuns: SchedulingRun[] = runRows.map((r) => ({
    ...r,
    softScore: r.softScore != null ? Number(r.softScore) : null,
    fitness: r.fitness != null ? Number(r.fitness) : null,
    startedAt: toTimestampStr(r.startedAt),
    finishedAt: toTimestampStr(r.finishedAt),
  }));

  const mappedRules: ChallengeRule[] = ruleRows.map((r) => ({
    ...r,
    createdAt: toTimestampStr(r.createdAt),
  }));

  const mappedIssues: IssueReport[] = issueRows.map((i) => ({
    ...i,
    affectedDate: toStr(i.affectedDate),
    createdAt: toTimestampStr(i.createdAt),
  }));

  const ctx: BaseSnapshot['ctx'] = {
    term,
    timeSlots: mappedTimeSlots,
    departments: deptRows,
    buildings: bldgRows,
    roomTypes: rtRows,
    rooms: roomRows,
    staff: staffRows.map((s) => ({
      ...s,
      phoneEncrypted: s.phoneEncrypted ? new Uint8Array(s.phoneEncrypted) : null,
    })),
    studentGroups: groupRows,
    subgroups: subRows,
    students: studentRows,
    subjects: subjRows,
    offerings: offRows,
    offeringGroups: ogRows,
    offeringTeachers: otRows,
    eligibilities: eligRows,
    electiveEnrollments: enrollRows,
    fixedBlocks: fbRows,
    items,
    itemTeachers,
    constraintConfigs: ccRows,
  };

  return {
    ctx,
    versions: mappedVersions,
    activeVersion,
    runs: mappedRuns,
    challengeRules: mappedRules,
    issues: mappedIssues,
  };
}

/**
 * Commit a validated `Dataset7Bundle` into TiDB tables (replacing active term/dataset cleanly).
 */
export async function commitDataset7ToDb(params: {
  bundle: Dataset7Bundle;
  fileName: string;
  issues: ImportJob['issues'];
  stats: ImportJob['stats'];
  createdBy?: string | null;
}): Promise<{ jobId: string; counts: Record<string, number> }> {
  const { bundle } = params;
  const scope = `import:${Date.now()}`;
  const termRow: Term = {
    id: stableId(scope, 'term'),
    academicYear: 2569,
    semester: 2,
    startDate: '2026-11-02',
    endDate: '2027-03-12',
  };

  // Group timeslots by period -> union openDays
  const slotByPeriod = new Map<number, { start: string; end: string; shift: 'day' | 'evening'; days: Set<number> }>();
  for (const ts of bundle.timeslots) {
    if (ts.kind !== 'class') continue;
    const prev = slotByPeriod.get(ts.period);
    if (!prev) {
      slotByPeriod.set(ts.period, {
        start: ts.startTime.length === 5 ? `${ts.startTime}:00` : ts.startTime,
        end: ts.endTime.length === 5 ? `${ts.endTime}:00` : ts.endTime,
        shift: ts.shift,
        days: new Set([ts.day]),
      });
    } else {
      prev.days.add(ts.day);
    }
  }
  const slotRows: TimeSlot[] = [...slotByPeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([period, info]) => ({
      id: stableId(scope, 'slot', period),
      termId: termRow.id,
      period,
      startTime: info.start,
      endTime: info.end,
      shift: info.shift,
      openDays: [...info.days].sort((a, b) => a - b),
    }));

  const deptMap = new Map<string, Department>();
  const ensureDept = (code: string | null) => {
    const c = code || 'GEN';
    if (!deptMap.has(c)) {
      deptMap.set(c, { id: stableId(scope, 'dept', c), code: c, name: `แผนกวิชา ${c}` });
    }
    return deptMap.get(c)!.id;
  };
  for (const g of bundle.studentGroups) ensureDept(g.departmentCode);
  for (const t of bundle.teachers) ensureDept(t.departmentCode);

  const buildingMap = new Map<string, { id: string; code: string; name: string }>();
  const ensureBuilding = (code: string | null) => {
    const c = code || 'B1';
    if (!buildingMap.has(c)) {
      buildingMap.set(c, { id: stableId(scope, 'bldg', c), code: c, name: `อาคาร ${c}` });
    }
    return buildingMap.get(c)!.id;
  };

  const rtMap = new Map<string, RoomType>();
  const ensureRt = (code: string) => {
    const c = code || 'theory';
    if (!rtMap.has(c)) {
      rtMap.set(c, { id: stableId(scope, 'rt', c), code: c, name: c, isLab: c.startsWith('lab') });
    }
    return rtMap.get(c)!.id;
  };
  for (const r of bundle.rooms) ensureRt(r.roomType);
  for (const s of bundle.subjects) if (s.requiredRoomType) ensureRt(s.requiredRoomType);

  const roomRows: Room[] = bundle.rooms.map((r) => ({
    id: stableId(scope, 'room', r.roomCode),
    roomCode: r.roomCode,
    buildingId: ensureBuilding(r.buildingCode),
    roomTypeId: ensureRt(r.roomType),
    capacity: r.capacity,
    allowMultiGroup: r.roomType === 'activity_yard',
    features: null,
    unavailableSlots: null,
  }));

  const staffRows: Staff[] = bundle.teachers.map((t) => ({
    id: stableId(scope, 'staff', t.teacherCode),
    employeeCode: t.teacherCode,
    fullName: t.fullName,
    departmentId: ensureDept(t.departmentCode),
    position: 'ครูผู้สอน',
    staffType: 'teacher',
    phoneEncrypted: null,
    maxDailyPeriods: 6,
    maxConsecutive: 3,
    maxWeeklyPeriods: t.maxWeeklyPeriods ?? 24,
    dayOff: null,
    availableSlots: null,
    unavailableSlots: t.unavailableSlots.length > 0 ? t.unavailableSlots : null,
  }));
  const staffByCode = new Map(staffRows.map((s) => [s.employeeCode, s.id]));

  const groupRows: StudentGroup[] = bundle.studentGroups.map((g) => ({
    id: stableId(scope, 'group', g.groupCode),
    groupCode: g.groupCode,
    departmentId: ensureDept(g.departmentCode),
    level: g.level ?? 'ปวช.',
    yearNo: g.yearNo ?? 1,
    programType: 'ปกติ',
    studentCount: g.studentCount,
    lunchPeriod: g.lunchPeriod ?? (g.level === 'ปวส.' ? 5 : 4),
    allowedDays: g.allowedDays ?? [1, 2, 3, 4, 5],
    allowedShift: 'day',
    unavailableSlots: g.unavailableSlots.length > 0 ? g.unavailableSlots : null,
  }));
  const groupByCode = new Map(groupRows.map((g) => [g.groupCode, g.id]));

  const subjectRows: Subject[] = bundle.subjects.map((s) => ({
    id: stableId(scope, 'subj', s.subjectCode),
    subjectCode: s.subjectCode,
    curriculumYear: 2567,
    subjectName: s.subjectName,
    theoryHours: s.theoryHours,
    practiceHours: s.practiceHours,
    credits: s.credits,
    category: s.category ?? 'core',
    requiredRoomTypeId: s.requiredRoomType ? ensureRt(s.requiredRoomType) : null,
    defaultSplit: [Math.max(1, s.theoryHours + s.practiceHours)],
    mustBeConsecutive: s.mustBeConsecutive,
    timePreference: 'any',
  }));
  const subjByCode = new Map(subjectRows.map((s) => [s.subjectCode, s]));

  const offeringRows: CourseOffering[] = [];
  const ogRows: OfferingGroup[] = [];
  const otRows: OfferingTeacher[] = [];

  bundle.registers.forEach((reg, idx) => {
    const subj = subjByCode.get(reg.subjectCode);
    if (!subj) return;
    const ppw = reg.periodsPerWeek ?? Math.max(1, (subj.theoryHours ?? 0) + (subj.practiceHours ?? 0));
    const offId = stableId(scope, 'off', reg.offeringCode ?? `${reg.subjectCode}:${idx}`);
    offeringRows.push({
      id: offId,
      termId: termRow.id,
      subjectId: subj.id,
      offeringType: reg.groupCodes.length > 1 ? 'combined' : 'regular',
      periodsPerWeek: ppw,
      splitPattern: [ppw],
      roomTypeId: subj.requiredRoomTypeId,
      sectionNo: reg.sectionNo,
      maxStudents: null,
    });
    for (const gc of reg.groupCodes) {
      const gid = groupByCode.get(gc);
      if (gid) ogRows.push({ offeringId: offId, groupId: gid });
    }
    if (reg.teacherCode && staffByCode.has(reg.teacherCode)) {
      otRows.push({ offeringId: offId, staffId: staffByCode.get(reg.teacherCode)!, subgroupCode: null, role: 'main' });
    }
  });

  const eligSet = new Set<string>();
  const eligRows: TeacherSubjectEligibility[] = [];
  for (const t of bundle.teaches) {
    const sid = staffByCode.get(t.teacherCode);
    const subj = subjByCode.get(t.subjectCode);
    if (!sid || !subj) continue;
    const k = `${sid}|${subj.id}`;
    if (eligSet.has(k)) continue;
    eligSet.add(k);
    eligRows.push({
      staffId: sid,
      subjectId: subj.id,
      groupId: t.groupCode ? (groupByCode.get(t.groupCode) ?? null) : null,
    });
  }

  const fbRows: FixedBlock[] = [];
  const ccRows = buildCanonicalConstraintConfigs(scope);
  const jobId = `job:${Date.now()}`;

  await db.transaction(async (tx) => {
    for (const name of [...TABLE_NAMES].reverse()) {
      if (name === 'accounts' || name === 'consent_records') continue;
      await tx.delete(SCHEMA_TABLES[name]);
    }
    await tx.insert(terms).values(termRow as never);
    if (slotRows.length) await tx.insert(timeSlots).values(slotRows as never);
    const depts = [...deptMap.values()];
    if (depts.length) await tx.insert(departments).values(depts as never);
    const bldgs = [...buildingMap.values()];
    if (bldgs.length) await tx.insert(buildings).values(bldgs as never);
    const rts = [...rtMap.values()];
    if (rts.length) await tx.insert(roomTypes).values(rts as never);
    if (roomRows.length) await tx.insert(rooms).values(roomRows as never);
    if (staffRows.length) await tx.insert(staff).values(staffRows as never);
    if (groupRows.length) await tx.insert(studentGroups).values(groupRows as never);
    if (subjectRows.length) await tx.insert(subjects).values(subjectRows as never);
    if (offeringRows.length) await tx.insert(courseOfferings).values(offeringRows as never);
    if (ogRows.length) await tx.insert(offeringGroups).values(ogRows as never);
    if (otRows.length) await tx.insert(offeringTeachers).values(otRows as never);
    if (eligRows.length) await tx.insert(teacherSubjectEligibility).values(eligRows as never);
    if (fbRows.length) await tx.insert(fixedBlocks).values(fbRows as never);
    if (ccRows.length) await tx.insert(constraintConfigs).values(ccRows as never);
    await tx.insert(importJobs).values({
      id: jobId,
      fileName: params.fileName,
      status: 'committed',
      stats: params.stats,
      issues: params.issues,
      createdBy: params.createdBy ?? null,
    } as never);
  });

  invalidateWorkspaceCache();

  return {
    jobId,
    counts: {
      timeSlots: slotRows.length,
      rooms: roomRows.length,
      staff: staffRows.length,
      studentGroups: groupRows.length,
      subjects: subjectRows.length,
      offerings: offeringRows.length,
      eligibilities: eligRows.length,
    },
  };
}
