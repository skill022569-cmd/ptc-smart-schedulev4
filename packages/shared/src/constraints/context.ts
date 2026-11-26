/**
 * Pre-computed lookups shared by all evaluators of one evaluation run.
 * Pure & deterministic: iteration order follows the input arrays, ties sorted by id.
 */
import { formatSlotTimeTh } from '../explain/messages.th';
import { OccupancyIndex } from '../occupancy';
import type {
  Building,
  CourseOffering,
  EducationLevel,
  OfferingTeacher,
  Room,
  RoomType,
  ScenarioTables,
  ScheduleItem,
  ScheduleItemTeacher,
  Shift,
  SlotRef,
  Staff,
  Student,
  StudentGroup,
  Subgroup,
  Subject,
  TimeSlot,
} from '../types';
import type { ScheduleEvaluationContext } from './types';

export interface AudienceUnit {
  /** `group:<id>` or `subgroup:<id>` — the same resource keys as `slot_occupancy`. */
  key: string;
  type: 'group' | 'subgroup';
  id: string;
  groupId: string;
}

export interface PlacedItem {
  item: ScheduleItem;
  day: number;
  start: number;
  /** Last period (inclusive). */
  end: number;
  periods: number[];
  teacherIds: string[];
  /** Groups of the offering (`offering_groups`). */
  groupIds: string[];
  /** Groups whose students attend this item (only the subgroup's group for split items). */
  audienceGroupIds: string[];
  /** Student timetables this item occupies (mirrors slot_occupancy group/subgroup rows). */
  units: AudienceUnit[];
  offering: CourseOffering | undefined;
  subject: Subject | undefined;
  room: Room | undefined;
  studentCount: number;
}

export interface TimelineEntry {
  period: number;
  placed: PlacedItem;
}

/** day → entries sorted by period, then item id. */
export type DayTimeline = Map<number, TimelineEntry[]>;

export interface UnitTimeline {
  unit: AudienceUnit;
  days: DayTimeline;
}

export const DEFAULT_LUNCH_BY_LEVEL: Record<EducationLevel, number> = { 'ปวช.': 4, 'ปวส.': 5 };
export const DEFAULT_EVENING_START_PERIOD = 10;

export const slotKey = (day: number, period: number) => `${day}:${period}`;

export function toSlotKeySet(slots: readonly SlotRef[] | null | undefined): Set<string> {
  return new Set((slots ?? []).map((s) => slotKey(s.day, s.period)));
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

function sortTimeline(days: DayTimeline): void {
  for (const list of days.values()) {
    list.sort((a, b) => a.period - b.period || a.placed.item.id.localeCompare(b.placed.item.id));
  }
}

export class EvaluationIndex {
  readonly ctx: ScheduleEvaluationContext;
  readonly roomById: Map<string, Room>;
  readonly roomTypeById: Map<string, RoomType>;
  readonly buildingById: Map<string, Building>;
  readonly staffById: Map<string, Staff>;
  readonly groupById: Map<string, StudentGroup>;
  readonly subgroupById: Map<string, Subgroup>;
  readonly studentById: Map<string, Student>;
  readonly subjectById: Map<string, Subject>;
  readonly offeringById: Map<string, CourseOffering>;
  readonly subgroupsByGroup: Map<string, Subgroup[]>;
  readonly groupIdsByOffering: Map<string, string[]>;
  readonly offeringTeachersByOffering: Map<string, OfferingTeacher[]>;
  readonly teacherIdsByItem: Map<string, string[]>;
  readonly timeSlotByPeriod: Map<number, TimeSlot>;
  /** Periods defined in `time_slots` (sorted). */
  readonly periods: number[];
  readonly maxPeriod: number;
  /** Offerings of `ctx.term` (H18/H20 scope). */
  readonly termOfferings: CourseOffering[];
  /** Items with status `scheduled` (or null) and a day + start period. */
  readonly placed: PlacedItem[];
  readonly placedById: Map<string, PlacedItem>;
  readonly placedByOffering: Map<string, PlacedItem[]>;
  /** Items in the `unplaced_tray` or missing day/start. */
  readonly unplacedItems: ScheduleItem[];
  readonly staffUnavailable: Map<string, Set<string>>;
  readonly staffAvailable: Map<string, Set<string>>;
  readonly roomUnavailable: Map<string, Set<string>>;
  readonly groupUnavailable: Map<string, Set<string>>;

  private teacherTimelineCache: Map<string, DayTimeline> | undefined;
  private unitTimelineCache: Map<string, UnitTimeline> | undefined;
  private occupancyCache: OccupancyIndex | undefined;

  constructor(ctx: ScheduleEvaluationContext) {
    this.ctx = ctx;
    this.roomById = byId(ctx.rooms);
    this.roomTypeById = byId(ctx.roomTypes);
    this.buildingById = byId(ctx.buildings);
    this.staffById = byId(ctx.staff);
    this.groupById = byId(ctx.studentGroups);
    this.subgroupById = byId(ctx.subgroups);
    this.studentById = byId(ctx.students);
    this.subjectById = byId(ctx.subjects);
    this.offeringById = byId(ctx.offerings);
    this.subgroupsByGroup = groupBy(ctx.subgroups, (s) => s.groupId);
    for (const list of this.subgroupsByGroup.values()) list.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
    this.groupIdsByOffering = new Map(
      [...groupBy(ctx.offeringGroups, (g) => g.offeringId)].map(([k, rows]) => [k, [...new Set(rows.map((r) => r.groupId))]]),
    );
    this.offeringTeachersByOffering = groupBy(ctx.offeringTeachers, (t) => t.offeringId);
    this.teacherIdsByItem = new Map(
      [...groupBy(ctx.itemTeachers, (t: ScheduleItemTeacher) => t.itemId)].map(([k, rows]) => [k, [...new Set(rows.map((r) => r.staffId))]]),
    );
    const termSlots = ctx.timeSlots.filter((s) => s.termId === ctx.term.id);
    const slots = termSlots.length > 0 ? termSlots : ctx.timeSlots;
    this.timeSlotByPeriod = new Map(slots.map((s) => [s.period, s]));
    this.periods = [...this.timeSlotByPeriod.keys()].sort((a, b) => a - b);
    this.maxPeriod = this.periods.length > 0 ? this.periods[this.periods.length - 1] : 0;
    this.termOfferings = ctx.offerings.filter((o) => o.termId === ctx.term.id);

    this.staffUnavailable = new Map(ctx.staff.map((s) => [s.id, toSlotKeySet(s.unavailableSlots)]));
    this.staffAvailable = new Map(
      ctx.staff.filter((s) => (s.availableSlots?.length ?? 0) > 0).map((s) => [s.id, toSlotKeySet(s.availableSlots)]),
    );
    this.roomUnavailable = new Map(ctx.rooms.map((r) => [r.id, toSlotKeySet(r.unavailableSlots)]));
    this.groupUnavailable = new Map(ctx.studentGroups.map((g) => [g.id, toSlotKeySet(g.unavailableSlots)]));

    const enrollCount = new Map<string, number>();
    for (const e of ctx.electiveEnrollments) {
      if (e.offeringId) enrollCount.set(e.offeringId, (enrollCount.get(e.offeringId) ?? 0) + 1);
    }

    this.placed = [];
    this.unplacedItems = [];
    for (const item of ctx.items) {
      if (item.status === 'unplaced_tray' || item.dayOfWeek === null || item.startPeriod === null) {
        this.unplacedItems.push(item);
        continue;
      }
      this.placed.push(this.buildPlaced(item, enrollCount));
    }
    this.placedById = new Map(this.placed.map((p) => [p.item.id, p]));
    this.placedByOffering = groupBy(this.placed, (p) => p.item.offeringId);
  }

  private buildPlaced(item: ScheduleItem, enrollCount: Map<string, number>): PlacedItem {
    const day = item.dayOfWeek as number;
    const start = item.startPeriod as number;
    const duration = Math.max(1, item.duration);
    const periods = Array.from({ length: duration }, (_, i) => start + i);
    const offering = this.offeringById.get(item.offeringId);
    const subject = offering ? this.subjectById.get(offering.subjectId) : undefined;
    const groupIds = this.groupIdsByOffering.get(item.offeringId) ?? [];
    const room = item.roomId ? this.roomById.get(item.roomId) : undefined;
    const teacherIds = this.teacherIdsByItem.get(item.id) ?? [];

    let audienceGroupIds: string[];
    let units: AudienceUnit[];
    let studentCount: number;
    const sub = item.subgroupId ? this.subgroupById.get(item.subgroupId) : undefined;
    if (item.subgroupId) {
      const groupId = sub?.groupId ?? groupIds[0] ?? '';
      audienceGroupIds = groupId ? [groupId] : [];
      units = [{ key: `subgroup:${item.subgroupId}`, type: 'subgroup', id: item.subgroupId, groupId }];
      studentCount = sub?.studentCount ?? 0;
    } else {
      audienceGroupIds = groupIds;
      units = [];
      for (const groupId of groupIds) {
        const subs = this.subgroupsByGroup.get(groupId);
        if (subs && subs.length > 0) {
          for (const s of subs) units.push({ key: `subgroup:${s.id}`, type: 'subgroup', id: s.id, groupId });
        } else {
          units.push({ key: `group:${groupId}`, type: 'group', id: groupId, groupId });
        }
      }
      studentCount = groupIds.reduce((n, g) => n + (this.groupById.get(g)?.studentCount ?? 0), 0);
      if (offering?.offeringType === 'elective_section') {
        studentCount = enrollCount.get(offering.id) ?? offering.maxStudents ?? studentCount;
      }
    }
    return {
      item,
      day,
      start,
      end: start + duration - 1,
      periods,
      teacherIds,
      groupIds,
      audienceGroupIds,
      units,
      offering,
      subject,
      room,
      studentCount,
    };
  }

  // -------------------------------------------------------------------------
  // Grid helpers
  // -------------------------------------------------------------------------

  /** Period exists in `time_slots` and is open on that weekday. */
  isSlotOpen(day: number, period: number): boolean {
    const slot = this.timeSlotByPeriod.get(period);
    return !!slot && (slot.openDays ?? []).includes(day);
  }

  shiftOf(period: number, eveningStartPeriod = DEFAULT_EVENING_START_PERIOD): Shift {
    return this.timeSlotByPeriod.get(period)?.shift ?? (period >= eveningStartPeriod ? 'evening' : 'day');
  }

  /** Number of open (day, period) cells in the weekly grid. */
  openCellCount(): number {
    let n = 0;
    for (const slot of this.timeSlotByPeriod.values()) n += new Set(slot.openDays ?? []).size;
    return n;
  }

  lunchPeriodOf(groupId: string, byLevel?: Record<string, unknown>): number | undefined {
    const g = this.groupById.get(groupId);
    if (!g) return undefined;
    if (typeof g.lunchPeriod === 'number' && g.lunchPeriod > 0) return g.lunchPeriod;
    const fromParams = byLevel?.[g.level];
    if (typeof fromParams === 'number') return fromParams;
    return DEFAULT_LUNCH_BY_LEVEL[g.level];
  }

  // -------------------------------------------------------------------------
  // Derived structures (lazy, cached)
  // -------------------------------------------------------------------------

  /** staffId → day → entries (one per taught period). */
  teacherTimelines(): Map<string, DayTimeline> {
    if (this.teacherTimelineCache) return this.teacherTimelineCache;
    const out = new Map<string, DayTimeline>();
    for (const p of this.placed) {
      for (const staffId of p.teacherIds) {
        const days = out.get(staffId) ?? new Map<number, TimelineEntry[]>();
        const list = days.get(p.day) ?? [];
        for (const period of p.periods) list.push({ period, placed: p });
        days.set(p.day, list);
        out.set(staffId, days);
      }
    }
    for (const days of out.values()) sortTimeline(days);
    this.teacherTimelineCache = out;
    return out;
  }

  /** unitKey → student timetable of a group (no subgroups) or subgroup. */
  unitTimelines(): Map<string, UnitTimeline> {
    if (this.unitTimelineCache) return this.unitTimelineCache;
    const out = new Map<string, UnitTimeline>();
    for (const p of this.placed) {
      for (const unit of p.units) {
        const entry = out.get(unit.key) ?? { unit, days: new Map<number, TimelineEntry[]>() };
        const list = entry.days.get(p.day) ?? [];
        for (const period of p.periods) list.push({ period, placed: p });
        entry.days.set(p.day, list);
        out.set(unit.key, entry);
      }
    }
    for (const t of out.values()) sortTimeline(t.days);
    this.unitTimelineCache = out;
    return out;
  }

  /** Occupancy of all placed items (fixed blocks excluded — they are checked by H08). */
  occupancy(): OccupancyIndex {
    if (this.occupancyCache) return this.occupancyCache;
    const occ = new OccupancyIndex(this.ctx.subgroups);
    for (const p of this.placed) {
      const roomRef = p.item.roomId
        ? { id: p.item.roomId, allowMultiGroup: p.room?.allowMultiGroup ?? false, capacity: p.room?.capacity ?? null }
        : null;
      occ.addItem({
        itemId: p.item.id,
        day: p.day,
        startPeriod: p.start,
        duration: p.periods.length,
        teacherIds: p.teacherIds,
        groupIds: p.groupIds,
        subgroupId: p.item.subgroupId,
        room: roomRef,
        studentCount: p.studentCount,
      });
    }
    this.occupancyCache = occ;
    return occ;
  }

  // -------------------------------------------------------------------------
  // Labels for Thai messages
  // -------------------------------------------------------------------------

  slotText(day: number, start: number, duration = 1): string {
    return formatSlotTimeTh(day, start, duration, [...this.timeSlotByPeriod.values()]);
  }

  placedSlotText(p: PlacedItem): string {
    return this.slotText(p.day, p.start, p.periods.length);
  }

  teacherLabel(staffId: string): string {
    return this.staffById.get(staffId)?.fullName ?? staffId;
  }

  roomLabel(roomId: string | null | undefined): string {
    if (!roomId) return '-';
    return this.roomById.get(roomId)?.roomCode ?? roomId;
  }

  roomTypeLabel(roomTypeId: string | null | undefined): string {
    if (!roomTypeId) return '-';
    const t = this.roomTypeById.get(roomTypeId);
    return t ? t.name || t.code : roomTypeId;
  }

  buildingOf(roomId: string | null | undefined): string | undefined {
    if (!roomId) return undefined;
    return this.roomById.get(roomId)?.buildingId;
  }

  buildingLabel(buildingId: string | undefined): string {
    if (!buildingId) return '-';
    const b = this.buildingById.get(buildingId);
    return b ? b.name || b.code || buildingId : buildingId;
  }

  groupLabel(groupId: string): string {
    return this.groupById.get(groupId)?.groupCode ?? groupId;
  }

  subgroupLabel(subgroupId: string): string {
    const sg = this.subgroupById.get(subgroupId);
    if (!sg) return subgroupId;
    return `${this.groupLabel(sg.groupId)} กลุ่มย่อย ${sg.code}`;
  }

  unitLabel(unit: AudienceUnit): string {
    return unit.type === 'subgroup' ? this.subgroupLabel(unit.id) : this.groupLabel(unit.id);
  }

  subjectLabel(offeringId: string | undefined): string {
    if (!offeringId) return '-';
    const offering = this.offeringById.get(offeringId);
    const subject = offering ? this.subjectById.get(offering.subjectId) : undefined;
    if (!subject) return offeringId;
    return `${subject.subjectCode} ${subject.subjectName}`;
  }
}

/** Distinct items of one day timeline, ordered by start period then id. */
export function itemsInOrder(entries: readonly TimelineEntry[]): PlacedItem[] {
  const seen = new Map<string, PlacedItem>();
  for (const e of entries) if (!seen.has(e.placed.item.id)) seen.set(e.placed.item.id, e.placed);
  return [...seen.values()].sort((a, b) => a.start - b.start || a.item.id.localeCompare(b.item.id));
}

/** Distinct occupied periods of one day timeline (sorted). */
export function periodsOf(entries: readonly TimelineEntry[]): number[] {
  return [...new Set(entries.map((e) => e.period))].sort((a, b) => a - b);
}

/** Build an evaluation context from scenario tables (+ a solution). */
export function createEvaluationContext(
  tables: Partial<ScenarioTables>,
  solution: {
    items?: ScheduleItem[];
    itemTeachers?: ScheduleItemTeacher[];
    baselineItems?: ScheduleItem[];
    baselineItemTeachers?: ScheduleItemTeacher[];
    profileName?: string;
    overrides?: ScheduleEvaluationContext['overrides'];
    termId?: string;
  } = {},
): ScheduleEvaluationContext {
  const terms = tables.terms ?? [];
  const term = (solution.termId ? terms.find((t) => t.id === solution.termId) : terms[0]) ?? {
    id: 'term',
    academicYear: 0,
    semester: 1,
    startDate: '',
    endDate: '',
  };
  return {
    term,
    timeSlots: tables.time_slots ?? [],
    departments: tables.departments ?? [],
    buildings: tables.buildings ?? [],
    roomTypes: tables.room_types ?? [],
    rooms: tables.rooms ?? [],
    staff: tables.staff ?? [],
    studentGroups: tables.student_groups ?? [],
    subgroups: tables.subgroups ?? [],
    students: tables.students ?? [],
    subjects: tables.subjects ?? [],
    offerings: tables.course_offerings ?? [],
    offeringGroups: tables.offering_groups ?? [],
    offeringTeachers: tables.offering_teachers ?? [],
    eligibilities: tables.teacher_subject_eligibility ?? [],
    electiveEnrollments: tables.elective_enrollments ?? [],
    fixedBlocks: tables.fixed_blocks ?? [],
    items: solution.items ?? tables.schedule_items ?? [],
    itemTeachers: solution.itemTeachers ?? tables.schedule_item_teachers ?? [],
    baselineItems: solution.baselineItems,
    baselineItemTeachers: solution.baselineItemTeachers,
    profileName: solution.profileName,
    constraintConfigs: tables.constraint_configs,
    overrides: solution.overrides,
  };
}
