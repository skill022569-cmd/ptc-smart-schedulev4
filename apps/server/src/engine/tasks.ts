import type {
  CourseOffering,
  OfferingType,
  ScheduleEvaluationContext,
  ScheduleItem,
  TimePreference,
} from '@ptc/shared';

export interface ScheduleTask {
  taskId: string;
  offeringId: string;
  subjectId: string;
  segmentIndex: number;
  duration: number;
  subgroupId: string | null;
  groupIds: string[];
  audienceGroupIds: string[];
  studentCount: number;
  requiredRoomTypeId: string | null;
  mustBeConsecutive: boolean;
  timePreference: TimePreference;
  offeringType: OfferingType;
  isTeam: boolean;
  /** Fixed team teachers or pre-assigned subgroup teacher(s); may still be expanded from eligibility if empty. */
  preferredTeachers: string[];
  /** All eligible teacher IDs (for single-teacher offerings, any one of these is valid for H19). */
  eligibleTeachers: string[];
}

function stableTaskId(offeringId: string, segmentIndex: number, subgroupId: string | null): string {
  return `task:${offeringId}:${segmentIndex}:${subgroupId ?? 'all'}`;
}

export function taskNaturalKey(offeringId: string, segmentIndex: number, subgroupId: string | null): string {
  return `${offeringId}|${segmentIndex}|${subgroupId ?? ''}`;
}

/**
 * Expand `course_offerings` for `ctx.term` into schedulable segment tasks,
 * skipping segments already covered by `lockedItems`.
 */
export function buildScheduleTasks(
  ctx: ScheduleEvaluationContext,
  lockedItems: readonly ScheduleItem[] = [],
): ScheduleTask[] {
  const subjectById = new Map(ctx.subjects.map((s) => [s.id, s]));
  const groupById = new Map(ctx.studentGroups.map((g) => [g.id, g]));
  const subgroupsByGroup = new Map<string, typeof ctx.subgroups>();
  for (const sg of ctx.subgroups) {
    const list = subgroupsByGroup.get(sg.groupId) ?? [];
    list.push(sg);
    subgroupsByGroup.set(sg.groupId, list);
  }
  for (const list of subgroupsByGroup.values()) list.sort((a, b) => a.code.localeCompare(b.code));

  const groupsByOffering = new Map<string, string[]>();
  for (const og of ctx.offeringGroups) {
    const list = groupsByOffering.get(og.offeringId) ?? [];
    if (!list.includes(og.groupId)) list.push(og.groupId);
    groupsByOffering.set(og.offeringId, list);
  }

  const offeringTeachersByOffering = new Map<string, typeof ctx.offeringTeachers>();
  for (const ot of ctx.offeringTeachers) {
    const list = offeringTeachersByOffering.get(ot.offeringId) ?? [];
    list.push(ot);
    offeringTeachersByOffering.set(ot.offeringId, list);
  }

  const eligBySubject = new Map<string, typeof ctx.eligibilities>();
  for (const el of ctx.eligibilities) {
    const list = eligBySubject.get(el.subjectId) ?? [];
    list.push(el);
    eligBySubject.set(el.subjectId, list);
  }

  const enrollCount = new Map<string, number>();
  for (const e of ctx.electiveEnrollments) {
    if (e.offeringId) enrollCount.set(e.offeringId, (enrollCount.get(e.offeringId) ?? 0) + 1);
  }

  const lockedKeys = new Set(lockedItems.map((i) => taskNaturalKey(i.offeringId, i.segmentIndex, i.subgroupId ?? null)));
  const tasks: ScheduleTask[] = [];

  for (const o of ctx.offerings) {
    if (o.termId !== ctx.term.id) continue;
    const subject = subjectById.get(o.subjectId);
    const groupIds = groupsByOffering.get(o.id) ?? [];
    if (groupIds.length === 0) continue;

    const splitPattern =
      Array.isArray(o.splitPattern) && o.splitPattern.length > 0
        ? o.splitPattern
        : [Math.max(1, o.periodsPerWeek)];
    const offeringType: OfferingType = o.offeringType ?? 'regular';
    const requiredRoomTypeId = o.roomTypeId ?? subject?.requiredRoomTypeId ?? null;
    const mustBeConsecutive = Boolean(subject?.mustBeConsecutive);
    const timePreference: TimePreference = subject?.timePreference ?? 'any';
    const otRows = offeringTeachersByOffering.get(o.id) ?? [];
    const elRows = eligBySubject.get(o.subjectId) ?? [];

    const resolveEligible = (audienceGroups: string[]): string[] => {
      const matched = elRows
        .filter((r) => r.groupId === null || audienceGroups.includes(r.groupId))
        .map((r) => r.staffId);
      const fromOt = otRows.map((r) => r.staffId);
      return [...new Set([...fromOt, ...matched])];
    };

    if (offeringType === 'split') {
      const mainGroupId = groupIds[0]!;
      const subs = subgroupsByGroup.get(mainGroupId) ?? [];
      if (subs.length > 0) {
        for (const sg of subs) {
          const preferred = otRows
            .filter((r) => r.subgroupCode === sg.code || r.subgroupCode === null)
            .map((r) => r.staffId);
          const eligible = resolveEligible([mainGroupId]);
          splitPattern.forEach((duration, segmentIndex) => {
            if (lockedKeys.has(taskNaturalKey(o.id, segmentIndex, sg.id))) return;
            tasks.push({
              taskId: stableTaskId(o.id, segmentIndex, sg.id),
              offeringId: o.id,
              subjectId: o.subjectId,
              segmentIndex,
              duration,
              subgroupId: sg.id,
              groupIds,
              audienceGroupIds: [mainGroupId],
              studentCount: sg.studentCount,
              requiredRoomTypeId,
              mustBeConsecutive,
              timePreference,
              offeringType,
              isTeam: false,
              preferredTeachers: [...new Set(preferred)],
              eligibleTeachers: eligible.length > 0 ? eligible : [...new Set(preferred)],
            });
          });
        }
        continue;
      }
    }

    const wholeCount =
      offeringType === 'elective_section'
        ? enrollCount.get(o.id) ?? o.maxStudents ?? groupIds.reduce((s, g) => s + (groupById.get(g)?.studentCount ?? 0), 0)
        : groupIds.reduce((s, g) => s + (groupById.get(g)?.studentCount ?? 0), 0);

    const isTeam = offeringType === 'team' || otRows.filter((r) => r.subgroupCode === null).length > 1;
    const preferred = otRows.filter((r) => r.subgroupCode === null).map((r) => r.staffId);
    const eligible = resolveEligible(groupIds);

    splitPattern.forEach((duration, segmentIndex) => {
      if (lockedKeys.has(taskNaturalKey(o.id, segmentIndex, null))) return;
      tasks.push({
        taskId: stableTaskId(o.id, segmentIndex, null),
        offeringId: o.id,
        subjectId: o.subjectId,
        segmentIndex,
        duration,
        subgroupId: null,
        groupIds,
        audienceGroupIds: groupIds,
        studentCount: wholeCount,
        requiredRoomTypeId,
        mustBeConsecutive,
        timePreference,
        offeringType,
        isTeam,
        preferredTeachers: [...new Set(preferred)],
        eligibleTeachers: eligible.length > 0 ? eligible : [...new Set(preferred)],
      });
    });
  }

  return tasks;
}

export function offeringOfTask(offerings: readonly CourseOffering[], task: ScheduleTask): CourseOffering | undefined {
  return offerings.find((o) => o.id === task.offeringId);
}
