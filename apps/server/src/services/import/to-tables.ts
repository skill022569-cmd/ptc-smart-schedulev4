/**
 * Pure conversion of a parsed 7-CSV bundle into scenario tables (no DB), shared by
 * `commitDataset7ToDb` and the end-to-end test.
 */
import { stableId } from '../../db/scenario-builder';
import type {
  CourseOffering,
  Dataset7Bundle,
  Department,
  OfferingGroup,
  OfferingTeacher,
  Room,
  RoomType,
  Staff,
  StudentGroup,
  Subject,
  TeacherSubjectEligibility,
  Term,
  TimeSlot,
} from '@ptc/shared';

/** `${day}-${period}` -> original timeslot_id from timeslot.csv (for output.csv). */
export type TimeslotIdMap = Record<string, string>;

export function buildDataset7Tables(bundle: Dataset7Bundle, scope: string) {
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
    lunchPeriod: g.lunchPeriod ?? (g.level === 'ปวช.' ? 4 : 5),
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


  const timeslotIds: TimeslotIdMap = {};
  for (const ts of bundle.timeslots) if (ts.slotId) timeslotIds[`${ts.day}-${ts.period}`] = ts.slotId;

  return {
    term: termRow,
    timeSlots: slotRows,
    departments: [...deptMap.values()],
    buildings: [...buildingMap.values()],
    roomTypes: [...rtMap.values()],
    rooms: roomRows,
    staff: staffRows,
    studentGroups: groupRows,
    subjects: subjectRows,
    offerings: offeringRows,
    offeringGroups: ogRows,
    offeringTeachers: otRows,
    eligibilities: eligRows,
    timeslotIds,
  };
}
