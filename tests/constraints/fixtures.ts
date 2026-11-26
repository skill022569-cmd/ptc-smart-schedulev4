/**
 * Small deterministic world for Constraint Engine unit tests.
 *
 * Grid: Mon–Fri, periods 1–8 = day shift (p1 08:00–09:00 …), 10–11 = evening shift.
 * Period 9 does not exist. Lunch: ปวช. = 4, ปวส. = 5.
 */
import type {
  ActiveConstraintMode,
  ConstraintCode,
  ConstraintViolation,
  CourseOffering,
  FixedBlock,
  JsonObject,
  OfferingType,
  Room,
  ScheduleEvaluationContext,
  ScheduleItem,
  ScheduleItemStatus,
  Staff,
  StudentGroup,
  Subject,
  TimeSlot,
} from '../../packages/shared/src';
import { expect } from 'vitest';
import { evaluateConstraint, hasTemplateTh, MESSAGE_TEMPLATES_TH } from '../../packages/shared/src';

export const THAI = /[฀-๿]/;

const pad = (n: number) => String(n).padStart(2, '0');

function timeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (const period of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) {
    const startHour = period <= 8 ? 7 + period : 7 + period - 1;
    slots.push({
      id: `ts${period}`,
      termId: 'term1',
      period,
      startTime: `${pad(startHour)}:00:00`,
      endTime: `${pad(startHour + 1)}:00:00`,
      shift: period <= 8 ? 'day' : 'evening',
      openDays: [1, 2, 3, 4, 5],
    });
  }
  return slots;
}

function staff(id: string, fullName: string): Staff {
  return {
    id,
    employeeCode: id,
    fullName,
    departmentId: 'D1',
    position: null,
    staffType: 'teacher',
    phoneEncrypted: null,
    maxDailyPeriods: 6,
    maxConsecutive: 3,
    maxWeeklyPeriods: 24,
    dayOff: null,
    availableSlots: null,
    unavailableSlots: null,
  };
}

function room(id: string, buildingId: string, roomTypeId: string, capacity: number, allowMultiGroup = false): Room {
  return { id, roomCode: id, buildingId, roomTypeId, capacity, allowMultiGroup, features: null, unavailableSlots: null };
}

function group(id: string, code: string, level: 'ปวช.' | 'ปวส.', studentCount: number, extra: Partial<StudentGroup> = {}): StudentGroup {
  return {
    id,
    groupCode: code,
    departmentId: 'D1',
    level,
    yearNo: 1,
    programType: 'ปกติ',
    studentCount,
    lunchPeriod: level === 'ปวช.' ? 4 : 5,
    allowedDays: [1, 2, 3, 4, 5],
    allowedShift: 'day',
    unavailableSlots: null,
    ...extra,
  };
}

function subject(id: string, name: string, theory: number, practice: number, extra: Partial<Subject> = {}): Subject {
  return {
    id,
    subjectCode: id,
    curriculumYear: 2567,
    subjectName: name,
    theoryHours: theory,
    practiceHours: practice,
    credits: 2,
    category: 'core',
    requiredRoomTypeId: null,
    defaultSplit: null,
    mustBeConsecutive: false,
    timePreference: 'any',
    ...extra,
  };
}

interface OfferingSpec {
  id: string;
  subject: string;
  groups: string[];
  ppw: number;
  split?: number[];
  type?: OfferingType;
  roomType?: string | null;
  teachers?: Array<string | { staffId: string; subgroupCode: string }>;
  termId?: string;
}

export interface PlaceSpec {
  id: string;
  offering: string;
  day?: number | null;
  start?: number | null;
  duration?: number;
  room?: string | null;
  teachers?: string[];
  subgroup?: string | null;
  segment?: number;
  status?: ScheduleItemStatus;
}

export function makeItem(spec: PlaceSpec): ScheduleItem {
  return {
    id: spec.id,
    versionId: 'v1',
    offeringId: spec.offering,
    segmentIndex: spec.segment ?? 0,
    subgroupId: spec.subgroup ?? null,
    roomId: spec.room === undefined ? 'R1' : spec.room,
    dayOfWeek: spec.day === undefined ? 1 : spec.day,
    startPeriod: spec.start === undefined ? 1 : spec.start,
    duration: spec.duration ?? 1,
    status: spec.status ?? 'scheduled',
    isLocked: false,
    explanation: null,
    rowVersion: 1,
    updatedBy: null,
    updatedAt: null,
  };
}

export class World {
  readonly ctx: ScheduleEvaluationContext;

  constructor() {
    this.ctx = {
      term: { id: 'term1', academicYear: 2569, semester: 1, startDate: '2026-05-16', endDate: '2026-09-30' },
      timeSlots: timeSlots(),
      departments: [{ id: 'D1', code: 'IT', name: 'เทคโนโลยีสารสนเทศ' }],
      buildings: [
        { id: 'B1', code: 'B1', name: 'อาคาร 1' },
        { id: 'B2', code: 'B2', name: 'อาคาร 2' },
      ],
      roomTypes: [
        { id: 'RT_TH', code: 'theory', name: 'ห้องทฤษฎี', isLab: false },
        { id: 'RT_LAB', code: 'lab_com', name: 'ห้องปฏิบัติการคอมพิวเตอร์', isLab: true },
        { id: 'RT_HALL', code: 'lecture_hall', name: 'ห้องบรรยายรวม', isLab: false },
      ],
      rooms: [
        room('R1', 'B1', 'RT_TH', 40),
        room('R2', 'B1', 'RT_TH', 40),
        room('R3', 'B2', 'RT_TH', 40),
        room('LAB1', 'B2', 'RT_LAB', 30),
        room('HALL', 'B1', 'RT_HALL', 40, true),
      ],
      staff: [staff('T1', 'ครูหนึ่ง'), staff('T2', 'ครูสอง'), staff('T3', 'ครูสาม'), staff('T4', 'ครูสี่')],
      studentGroups: [
        group('G1', 'IT1/1', 'ปวช.', 30),
        group('G2', 'IT2/1', 'ปวส.', 20, { allowedShift: 'both' }),
        group('G3', 'IT1/2', 'ปวช.', 30),
      ],
      subgroups: [
        { id: 'G3A', groupId: 'G3', code: 'A', studentCount: 15 },
        { id: 'G3B', groupId: 'G3', code: 'B', studentCount: 15 },
      ],
      students: [
        { id: 'ST1', studentCode: '001', fullName: 'นักเรียนหนึ่ง', groupId: 'G1', subgroupId: null },
        { id: 'ST2', studentCode: '002', fullName: 'นักเรียนสอง', groupId: 'G3', subgroupId: 'G3A' },
      ],
      subjects: [
        subject('SUB_TH', 'ภาษาไทย', 2, 0, { category: 'general' }),
        subject('SUB_MATH', 'คณิตศาสตร์', 2, 0, { category: 'general' }),
        subject('SUB_LAB', 'การเขียนโปรแกรม', 0, 3, { requiredRoomTypeId: 'RT_LAB', mustBeConsecutive: true }),
        subject('SUB_PE', 'พลศึกษา', 0, 2, { timePreference: 'morning', category: 'activity' }),
        subject('SUB_EL', 'วิชาเลือกเสรี', 1, 1, { category: 'elective' }),
      ],
      offerings: [],
      offeringGroups: [],
      offeringTeachers: [],
      eligibilities: [
        { staffId: 'T1', subjectId: 'SUB_TH', groupId: null },
        { staffId: 'T2', subjectId: 'SUB_MATH', groupId: null },
        { staffId: 'T2', subjectId: 'SUB_PE', groupId: null },
        { staffId: 'T3', subjectId: 'SUB_LAB', groupId: null },
        { staffId: 'T4', subjectId: 'SUB_LAB', groupId: null },
        { staffId: 'T4', subjectId: 'SUB_EL', groupId: null },
        { staffId: 'T4', subjectId: 'SUB_MATH', groupId: 'G2' },
      ],
      electiveEnrollments: [],
      fixedBlocks: [],
      items: [],
      itemTeachers: [],
    };
    this.offering({ id: 'O_TH_G1', subject: 'SUB_TH', groups: ['G1'], ppw: 2, teachers: ['T1'] });
    this.offering({ id: 'O_MATH_G1', subject: 'SUB_MATH', groups: ['G1'], ppw: 2, split: [1, 1], teachers: ['T2'] });
    this.offering({ id: 'O_TH_G2', subject: 'SUB_TH', groups: ['G2'], ppw: 2, teachers: ['T1'] });
    this.offering({ id: 'O_LAB_G1', subject: 'SUB_LAB', groups: ['G1'], ppw: 3, roomType: 'RT_LAB', teachers: ['T3'] });
    this.offering({
      id: 'O_LAB_G3',
      subject: 'SUB_LAB',
      groups: ['G3'],
      ppw: 3,
      type: 'split',
      roomType: 'RT_LAB',
      teachers: [
        { staffId: 'T3', subgroupCode: 'A' },
        { staffId: 'T4', subgroupCode: 'B' },
      ],
    });
    this.offering({ id: 'O_TH_G3', subject: 'SUB_TH', groups: ['G3'], ppw: 2, teachers: ['T1'] });
    this.offering({ id: 'O_COMB', subject: 'SUB_MATH', groups: ['G1', 'G2'], ppw: 2, type: 'combined', teachers: ['T2'] });
    this.offering({ id: 'O_PE_G2', subject: 'SUB_PE', groups: ['G2'], ppw: 2, type: 'activity', teachers: ['T2'] });
    this.offering({ id: 'O_TEAM', subject: 'SUB_MATH', groups: ['G2'], ppw: 2, type: 'team', teachers: ['T2', 'T4'] });
    this.offering({ id: 'O_EL', subject: 'SUB_EL', groups: ['G2'], ppw: 2, type: 'elective_section', teachers: ['T4'] });
  }

  offering(spec: OfferingSpec): this {
    const o: CourseOffering = {
      id: spec.id,
      termId: spec.termId ?? 'term1',
      subjectId: spec.subject,
      offeringType: spec.type ?? 'regular',
      periodsPerWeek: spec.ppw,
      splitPattern: spec.split ?? [spec.ppw],
      roomTypeId: spec.roomType ?? null,
      sectionNo: null,
      maxStudents: null,
    };
    this.ctx.offerings.push(o);
    for (const g of spec.groups) this.ctx.offeringGroups.push({ offeringId: spec.id, groupId: g });
    for (const t of spec.teachers ?? []) {
      const row = typeof t === 'string' ? { staffId: t, subgroupCode: null } : t;
      this.ctx.offeringTeachers.push({ offeringId: spec.id, staffId: row.staffId, subgroupCode: row.subgroupCode, role: 'main' });
    }
    return this;
  }

  /** Keep only these offerings (and their group / teacher rows). */
  only(...offeringIds: string[]): this {
    const keep = new Set(offeringIds);
    this.ctx.offerings = this.ctx.offerings.filter((o) => keep.has(o.id));
    this.ctx.offeringGroups = this.ctx.offeringGroups.filter((o) => keep.has(o.offeringId));
    this.ctx.offeringTeachers = this.ctx.offeringTeachers.filter((o) => keep.has(o.offeringId));
    return this;
  }

  place(spec: PlaceSpec): this {
    this.ctx.items.push(makeItem(spec));
    const teachers = spec.teachers ?? this.defaultTeachers(spec);
    for (const staffId of teachers) this.ctx.itemTeachers.push({ itemId: spec.id, staffId });
    return this;
  }

  private defaultTeachers(spec: PlaceSpec): string[] {
    const rows = this.ctx.offeringTeachers.filter((t) => t.offeringId === spec.offering);
    const code = spec.subgroup ? this.ctx.subgroups.find((s) => s.id === spec.subgroup)?.code : undefined;
    return rows.filter((r) => r.subgroupCode === null || r.subgroupCode === code).map((r) => r.staffId);
  }

  fixedBlock(block: Partial<FixedBlock> & Pick<FixedBlock, 'id' | 'dayOfWeek' | 'startPeriod' | 'duration'>): this {
    this.ctx.fixedBlocks.push({
      termId: 'term1',
      name: 'กิจกรรมหน้าเสาธง',
      blockType: 'activity',
      roomId: null,
      appliesTo: { all: true },
      ...block,
    });
    return this;
  }

  staff(id: string): Staff {
    return this.ctx.staff.find((s) => s.id === id)!;
  }

  group(id: string): StudentGroup {
    return this.ctx.studentGroups.find((g) => g.id === id)!;
  }

  room(id: string): Room {
    return this.ctx.rooms.find((r) => r.id === id)!;
  }

  subject(id: string): Subject {
    return this.ctx.subjects.find((s) => s.id === id)!;
  }
}

export const world = () => new World();

/** Every violation must use a known template whose placeholders are all supplied. */
export function expectWellFormed(vs: readonly ConstraintViolation[]): void {
  for (const v of vs) {
    expect(v.messageKey.startsWith(`${v.code}.`)).toBe(true);
    expect(hasTemplateTh(v.messageKey)).toBe(true);
    const placeholders = [...MESSAGE_TEMPLATES_TH[v.messageKey].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const name of placeholders) expect(v.params, `${v.messageKey} needs {${name}}`).toHaveProperty(name);
    expect(v.messageTh).toMatch(THAI);
    expect(v.messageTh).not.toMatch(/\{\w+\}/);
    expect(v.severity).toBeGreaterThan(0);
  }
}

export function ev(
  w: World,
  code: ConstraintCode,
  options: { params?: JsonObject; mode?: ActiveConstraintMode } = {},
): ConstraintViolation[] {
  const out = evaluateConstraint(w.ctx, code, options);
  expectWellFormed(out);
  return out;
}

export const keysOf = (vs: ConstraintViolation[]) => vs.map((v) => v.messageKey);
export const penaltyOf = (vs: ConstraintViolation[]) => vs.reduce((n, v) => n + v.severity, 0);
