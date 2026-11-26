import {
  DEFAULT_EVENING_START_PERIOD,
  OccupancyIndex,
  resolveConstraintConfigs,
  slotKey,
  toSlotKeySet,
  type ResolvedConstraintConfigMap,
  type Room,
  type ScheduleEvaluationContext,
  type ScheduleItem,
  type ScheduleItemTeacher,
  type Staff,
  type StudentGroup,
  type TimeSlot,
} from '@ptc/shared';
import type { ScheduleTask } from './tasks';

export interface SolverPlacement {
  task: ScheduleTask;
  itemId: string;
  day: number;
  startPeriod: number;
  roomId: string;
  teacherIds: string[];
}

export interface CandidateMove {
  day: number;
  startPeriod: number;
  roomId: string;
  teacherIds: string[];
  softEstimate: number;
}

/**
 * Stateful incremental solver board backed by `@ptc/shared`'s `OccupancyIndex`.
 * Tracks Hard constraint feasibility and fast local soft-cost estimates so Greedy,
 * CSP, GA, SA, and Repair run quickly even at college scale (Q21: 60 groups / 564 offerings).
 */
export class SolverBoard {
  readonly ctx: ScheduleEvaluationContext;
  readonly configs: ResolvedConstraintConfigMap;
  readonly occupancy: OccupancyIndex;
  readonly placements = new Map<string, SolverPlacement>();
  readonly groupById: Map<string, StudentGroup>;
  readonly roomById: Map<string, Room>;
  readonly staffById: Map<string, Staff>;
  readonly slotByPeriod: Map<number, TimeSlot>;
  readonly openDays: number[];
  readonly periods: number[];
  readonly staffUnavailable: Map<string, Set<string>>;
  readonly staffAvailable: Map<string, Set<string>>;
  readonly roomUnavailable: Map<string, Set<string>>;
  readonly groupUnavailable: Map<string, Set<string>>;
  readonly teacherDailyPeriods = new Map<string, Map<number, Set<number>>>();
  readonly groupDailyPeriods = new Map<string, Map<number, Set<number>>>();
  readonly offeringPlacements = new Map<string, Set<string>>();

  constructor(ctx: ScheduleEvaluationContext) {
    this.ctx = ctx;
    this.configs = resolveConstraintConfigs(ctx).configs;
    this.occupancy = new OccupancyIndex(ctx.subgroups);
    if (this.configs.H08.mode === 'hard') {
      this.occupancy.seedFixedBlocks(ctx.fixedBlocks, ctx.studentGroups, ctx.subgroups, {
        staff: ctx.staff,
        rooms: ctx.rooms,
      });
    }
    this.groupById = new Map(ctx.studentGroups.map((g) => [g.id, g]));
    this.roomById = new Map(ctx.rooms.map((r) => [r.id, r]));
    this.staffById = new Map(ctx.staff.map((s) => [s.id, s]));
    const termSlots = ctx.timeSlots.filter((s) => s.termId === ctx.term.id);
    const slots = termSlots.length > 0 ? termSlots : ctx.timeSlots;
    this.slotByPeriod = new Map(slots.map((s) => [s.period, s]));
    this.periods = [...this.slotByPeriod.keys()].sort((a, b) => a - b);
    const daySet = new Set<number>();
    for (const s of slots) for (const d of s.openDays ?? []) daySet.add(d);
    this.openDays = [...daySet].sort((a, b) => a - b);

    this.staffUnavailable = new Map(ctx.staff.map((s) => [s.id, toSlotKeySet(s.unavailableSlots)]));
    this.staffAvailable = new Map(
      ctx.staff.filter((s) => (s.availableSlots?.length ?? 0) > 0).map((s) => [s.id, toSlotKeySet(s.availableSlots)]),
    );
    this.roomUnavailable = new Map(ctx.rooms.map((r) => [r.id, toSlotKeySet(r.unavailableSlots)]));
    this.groupUnavailable = new Map(ctx.studentGroups.map((g) => [g.id, toSlotKeySet(g.unavailableSlots)]));
  }

  private isHard(code: keyof ResolvedConstraintConfigMap): boolean {
    return this.configs[code].mode === 'hard';
  }

  private shiftOf(period: number): 'day' | 'evening' {
    return this.slotByPeriod.get(period)?.shift ?? (period >= DEFAULT_EVENING_START_PERIOD ? 'evening' : 'day');
  }

  isSlotOpen(day: number, period: number): boolean {
    const slot = this.slotByPeriod.get(period);
    return Boolean(slot && (slot.openDays ?? []).includes(day));
  }

  /** Rooms meeting capacity + hard room-type constraints, ordered by best fit (smallest sufficient capacity first). */
  candidateRoomsFor(task: ScheduleTask): Room[] {
    const reqType = task.requiredRoomTypeId;
    const hardType = this.isHard('H05') && reqType !== null;
    const compatible = (this.configs.H05.params.compatibleTypes as Record<string, string[]> | undefined) ?? {};
    const roomTypeById = new Map(this.ctx.roomTypes.map((rt) => [rt.id, rt]));
    const reqCode = reqType ? roomTypeById.get(reqType)?.code : undefined;
    const allowedCodes = reqCode ? new Set([reqCode, ...(compatible[reqCode] ?? [])]) : null;

    const matching: Room[] = [];
    const fallback: Room[] = [];

    for (const r of this.ctx.rooms) {
      if (this.isHard('H04') && r.capacity < task.studentCount) continue;
      const rCode = roomTypeById.get(r.roomTypeId)?.code;
      const typeOk = !reqType || r.roomTypeId === reqType || (allowedCodes && rCode ? allowedCodes.has(rCode) : false);
      if (typeOk) {
        matching.push(r);
      } else if (!hardType) {
        fallback.push(r);
      }
    }
    const byFit = (a: Room, b: Room) => a.capacity - b.capacity || a.roomCode.localeCompare(b.roomCode);
    matching.sort(byFit);
    fallback.sort(byFit);
    return [...matching, ...fallback];
  }

  /** Valid teacher combinations for `task` ordered by preferred -> least weekly load. */
  candidateTeacherSetsFor(task: ScheduleTask): string[][] {
    if (task.isTeam || (this.isHard('H11') && task.preferredTeachers.length > 0)) {
      return task.preferredTeachers.length > 0 ? [task.preferredTeachers] : [];
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
      if (!seen.has(id) && this.staffById.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    };
    for (const id of task.preferredTeachers) add(id);
    const rest = [...task.eligibleTeachers].filter((id) => !seen.has(id));
    rest.sort((a, b) => this.teacherWeeklyLoad(a) - this.teacherWeeklyLoad(b) || a.localeCompare(b));
    for (const id of rest) add(id);
    return ordered.map((id) => [id]);
  }

  teacherWeeklyLoad(staffId: string): number {
    const days = this.teacherDailyPeriods.get(staffId);
    if (!days) return 0;
    let total = 0;
    for (const ps of days.values()) total += ps.size;
    return total;
  }

  /** Fast group + slot-grid feasibility (independent of room and teacher) to prune impossible slots in O(1). */
  isSlotGroupFeasible(task: ScheduleTask, day: number, startPeriod: number): boolean {
    const periods = Array.from({ length: task.duration }, (_, i) => startPeriod + i);
    for (const p of periods) {
      if (!this.isSlotOpen(day, p)) return false;
    }
    const shifts = new Set(periods.map((p) => this.shiftOf(p)));
    if (this.isHard('H09') && (task.mustBeConsecutive || periods.length > 1) && shifts.size > 1) return false;

    for (const gid of task.audienceGroupIds) {
      const g = this.groupById.get(gid);
      if (!g) continue;
      if (this.isHard('H10')) {
        if ((g.allowedDays?.length ?? 0) > 0 && !g.allowedDays.includes(day)) return false;
        if (g.allowedShift && g.allowedShift !== 'both' && periods.some((p) => this.shiftOf(p) !== g.allowedShift)) return false;
      }
      if (this.isHard('H06') && periods.includes(g.lunchPeriod)) return false;
      if (this.isHard('H09') && (task.mustBeConsecutive || periods.length > 1)) {
        if (startPeriod < g.lunchPeriod && startPeriod + task.duration - 1 > g.lunchPeriod) return false;
      }
      if (this.isHard('H21')) {
        const gUnavail = this.groupUnavailable.get(gid);
        if (gUnavail && periods.some((p) => gUnavail.has(slotKey(day, p)))) return false;
      }
    }

    if (this.isHard('H03')) {
      const gClashes = this.occupancy.findClashes({
        itemId: task.taskId,
        day,
        startPeriod,
        duration: task.duration,
        groupIds: task.audienceGroupIds,
        subgroupId: task.subgroupId,
      });
      if (gClashes.length > 0) return false;
    }
    return true;
  }

  /** Fast teacher feasibility + clash check before looping over rooms. */
  isTeacherFeasible(task: ScheduleTask, day: number, startPeriod: number, teacherIds: readonly string[]): boolean {
    const periods = Array.from({ length: task.duration }, (_, i) => startPeriod + i);
    for (const tid of teacherIds) {
      const t = this.staffById.get(tid);
      if (!t) return false;
      if (this.isHard('H15') && t.dayOff === day) return false;
      if (this.isHard('H07')) {
        const tUnavail = this.staffUnavailable.get(tid);
        if (tUnavail && periods.some((p) => tUnavail.has(slotKey(day, p)))) return false;
        const tAvail = this.staffAvailable.get(tid);
        if (tAvail && tAvail.size > 0 && periods.some((p) => !tAvail.has(slotKey(day, p)))) return false;
      }
      const existing = this.teacherDailyPeriods.get(tid)?.get(day);
      if (this.isHard('H13')) {
        const maxDaily = typeof this.configs.H13.params.max === 'number'
          ? this.configs.H13.params.max
          : t.maxDailyPeriods ?? 6;
        const union = new Set(existing);
        for (const p of periods) union.add(p);
        if (union.size > maxDaily) return false;
      }
      if (this.isHard('H14')) {
        const maxCons = typeof this.configs.H14.params.max === 'number'
          ? this.configs.H14.params.max
          : t.maxConsecutive ?? 3;
        const union = new Set(existing);
        for (const p of periods) union.add(p);
        if (maxRunLength([...union]) > maxCons) return false;
      }
      if (this.isHard('H16')) {
        const maxDays = typeof this.configs.H16.params.maxDays === 'number'
          ? this.configs.H16.params.maxDays
          : typeof this.configs.H16.params.max_days === 'number'
            ? this.configs.H16.params.max_days
            : 2;
        if (this.countTeacherBothShiftDays(tid, day, periods) > maxDays) return false;
      }
    }
    if (this.isHard('H01')) {
      const tClashes = this.occupancy.findClashes({
        itemId: task.taskId,
        day,
        startPeriod,
        duration: task.duration,
        teacherIds,
      });
      if (tClashes.length > 0) return false;
    }
    return true;
  }

  /** Fast check ignoring occupancy clashes (checks slot bounds, availability, capacity, teacher caps, lunch, etc.). */
  isIntrinsicallyFeasible(
    task: ScheduleTask,
    day: number,
    startPeriod: number,
    room: Room,
    teacherIds: readonly string[],
  ): boolean {
    const periods = Array.from({ length: task.duration }, (_, i) => startPeriod + i);

    // Every period must exist in time_slots and be open on `day` (H07/H20/H21)
    for (const p of periods) {
      if (!this.isSlotOpen(day, p)) return false;
    }

    // H04 capacity
    if (this.isHard('H04') && room.capacity < task.studentCount) return false;

    // H07 room availability
    if (this.isHard('H07')) {
      const rUnavail = this.roomUnavailable.get(room.id);
      if (rUnavail && periods.some((p) => rUnavail.has(slotKey(day, p)))) return false;
    }

    // Group-level checks: H06 lunch, H10 allowedDays/shift, H21 group unavailable, H09 consecutive/lunch/shift
    const shifts = new Set(periods.map((p) => this.shiftOf(p)));
    if (this.isHard('H09') && (task.mustBeConsecutive || periods.length > 1) && shifts.size > 1) return false;

    for (const gid of task.audienceGroupIds) {
      const g = this.groupById.get(gid);
      if (!g) continue;
      if (this.isHard('H10')) {
        if ((g.allowedDays?.length ?? 0) > 0 && !g.allowedDays.includes(day)) return false;
        if (g.allowedShift && g.allowedShift !== 'both') {
          if (periods.some((p) => this.shiftOf(p) !== g.allowedShift)) return false;
        }
      }
      if (this.isHard('H06')) {
        if (periods.includes(g.lunchPeriod)) return false;
      }
      if (this.isHard('H09') && (task.mustBeConsecutive || periods.length > 1)) {
        if (startPeriod < g.lunchPeriod && startPeriod + task.duration - 1 > g.lunchPeriod) return false;
      }
      if (this.isHard('H21')) {
        const gUnavail = this.groupUnavailable.get(gid);
        if (gUnavail && periods.some((p) => gUnavail.has(slotKey(day, p)))) return false;
      }
    }

    // Teacher checks: H07, H13, H14, H15, H16, H12
    for (const tid of teacherIds) {
      const t = this.staffById.get(tid);
      if (!t) return false;
      if (this.isHard('H15') && t.dayOff === day) return false;
      if (this.isHard('H07')) {
        const tUnavail = this.staffUnavailable.get(tid);
        if (tUnavail && periods.some((p) => tUnavail.has(slotKey(day, p)))) return false;
        const tAvail = this.staffAvailable.get(tid);
        if (tAvail && tAvail.size > 0 && periods.some((p) => !tAvail.has(slotKey(day, p)))) return false;
      }
      const existing = this.teacherDailyPeriods.get(tid)?.get(day);
      if (this.isHard('H13')) {
        const maxDaily = typeof this.configs.H13.params.max === 'number'
          ? this.configs.H13.params.max
          : t.maxDailyPeriods ?? 6;
        const union = new Set(existing);
        for (const p of periods) union.add(p);
        if (union.size > maxDaily) return false;
      }
      if (this.isHard('H14')) {
        const maxCons = typeof this.configs.H14.params.max === 'number'
          ? this.configs.H14.params.max
          : t.maxConsecutive ?? 3;
        const union = new Set(existing);
        for (const p of periods) union.add(p);
        if (maxRunLength([...union]) > maxCons) return false;
      }
      if (this.isHard('H16')) {
        const maxDays = typeof this.configs.H16.params.maxDays === 'number'
          ? this.configs.H16.params.maxDays
          : typeof this.configs.H16.params.max_days === 'number'
            ? this.configs.H16.params.max_days
            : 2;
        if (this.countTeacherBothShiftDays(tid, day, periods) > maxDays) return false;
      }
      if (this.isHard('H12') && existing && existing.size > 0) {
        if (!this.checkTeacherBuildingGap(tid, day, periods, room.buildingId)) return false;
      }
    }

    // Group building gap H12
    if (this.isHard('H12')) {
      for (const gid of task.audienceGroupIds) {
        if (!this.checkGroupBuildingGap(gid, day, periods, room.buildingId)) return false;
      }
    }

    // Elective clash H17 (rare unless enrollments exist)
    if (this.isHard('H17') && this.ctx.electiveEnrollments.length > 0) {
      if (this.hasElectiveClash(task, day, periods)) return false;
    }

    return true;
  }

  private countTeacherBothShiftDays(staffId: string, addDay: number, addPeriods: number[]): number {
    const days = this.teacherDailyPeriods.get(staffId);
    let count = 0;
    const allDays = new Set<number>([...(days?.keys() ?? []), addDay]);
    for (const d of allDays) {
      const ps = new Set(days?.get(d));
      if (d === addDay) for (const p of addPeriods) ps.add(p);
      let hasDay = false;
      let hasEve = false;
      for (const p of ps) {
        if (this.shiftOf(p) === 'day') hasDay = true;
        else hasEve = true;
      }
      if (hasDay && hasEve) count++;
    }
    return count;
  }

  private checkTeacherBuildingGap(staffId: string, day: number, periods: number[], buildingId: string): boolean {
    const gap = typeof this.configs.H12.params.gap === 'number' ? this.configs.H12.params.gap : 1;
    const minP = periods[0]! - gap;
    const maxP = periods[periods.length - 1]! + gap;
    for (const pl of this.placements.values()) {
      if (pl.day !== day || !pl.teacherIds.includes(staffId)) continue;
      const plRoom = this.roomById.get(pl.roomId);
      if (!plRoom || plRoom.buildingId === buildingId) continue;
      const plEnd = pl.startPeriod + pl.task.duration - 1;
      if ((plEnd >= minP && plEnd < periods[0]!) || (pl.startPeriod > periods[periods.length - 1]! && pl.startPeriod <= maxP)) {
        return false;
      }
    }
    return true;
  }

  private checkGroupBuildingGap(groupId: string, day: number, periods: number[], buildingId: string): boolean {
    const gap = typeof this.configs.H12.params.gap === 'number' ? this.configs.H12.params.gap : 1;
    const minP = periods[0]! - gap;
    const maxP = periods[periods.length - 1]! + gap;
    for (const pl of this.placements.values()) {
      if (pl.day !== day || !pl.task.audienceGroupIds.includes(groupId)) continue;
      const plRoom = this.roomById.get(pl.roomId);
      if (!plRoom || plRoom.buildingId === buildingId) continue;
      const plEnd = pl.startPeriod + pl.task.duration - 1;
      if ((plEnd >= minP && plEnd < periods[0]!) || (pl.startPeriod > periods[periods.length - 1]! && pl.startPeriod <= maxP)) {
        return false;
      }
    }
    return true;
  }

  private hasElectiveClash(task: ScheduleTask, day: number, periods: number[]): boolean {
    for (const en of this.ctx.electiveEnrollments) {
      if (!en.offeringId) continue;
      const st = this.ctx.students.find((s) => s.id === en.studentId);
      if (!st) continue;
      if (task.offeringId === en.offeringId) {
        // Placing elective -> check compulsory items of student's group
        for (const pl of this.placements.values()) {
          if (pl.day !== day || !pl.task.audienceGroupIds.includes(st.groupId)) continue;
          if (pl.task.subgroupId && st.subgroupId && pl.task.subgroupId !== st.subgroupId) continue;
          const plEnd = pl.startPeriod + pl.task.duration - 1;
          if (periods.some((p) => p >= pl.startPeriod && p <= plEnd)) return true;
        }
      } else if (task.audienceGroupIds.includes(st.groupId) && (!task.subgroupId || task.subgroupId === st.subgroupId)) {
        for (const pl of this.placements.values()) {
          if (pl.day !== day || pl.task.offeringId !== en.offeringId) continue;
          const plEnd = pl.startPeriod + pl.task.duration - 1;
          if (periods.some((p) => p >= pl.startPeriod && p <= plEnd)) return true;
        }
      }
    }
    return false;
  }

  findBlockingItemIds(
    task: ScheduleTask,
    day: number,
    startPeriod: number,
    room: Room,
    teacherIds: readonly string[],
  ): { canPlace: boolean; blockingItemIds: string[]; hitsFixedBlock: boolean } {
    const clashes = this.occupancy.findClashes({
      itemId: task.taskId,
      day,
      startPeriod,
      duration: task.duration,
      teacherIds: this.isHard('H01') ? teacherIds : [],
      groupIds: this.isHard('H03') ? task.audienceGroupIds : [],
      subgroupId: task.subgroupId,
      room: this.isHard('H02') || (this.isHard('H04') && room.allowMultiGroup) ? room : null,
      studentCount: task.studentCount,
    });
    if (clashes.length === 0) return { canPlace: true, blockingItemIds: [], hitsFixedBlock: false };
    const blockers = new Set<string>();
    let hitsFixedBlock = false;
    for (const c of clashes) {
      for (const bid of c.blockingItemIds) {
        if (bid.startsWith('fixed:')) hitsFixedBlock = true;
        else blockers.add(bid);
      }
    }
    return { canPlace: false, blockingItemIds: [...blockers], hitsFixedBlock };
  }

  /** Fast local heuristic penalty for candidate ordering (lower is better). */
  scoreCandidate(
    task: ScheduleTask,
    day: number,
    startPeriod: number,
    room: Room,
    teacherIds: readonly string[],
  ): number {
    let score = 0;
    const periods = Array.from({ length: task.duration }, (_, i) => startPeriod + i);

    // Prefer exact/preferred teachers slightly unless teacher load is heavily skewed
    for (const tid of teacherIds) {
      if (!task.preferredTeachers.includes(tid)) score += 3;
      const load = this.teacherWeeklyLoad(tid);
      score += load * 0.4;
      const dayMap = this.teacherDailyPeriods.get(tid);
      const daySet = dayMap?.get(day);
      if (daySet && daySet.size > 0) {
        const union = [...daySet, ...periods].sort((a, b) => a - b);
        const span = union[union.length - 1]! - union[0]! + 1;
        const internalGaps = Math.max(0, span - union.length - 1);
        score += internalGaps * (this.configs.S08.mode === 'soft' ? this.configs.S08.weight * 0.5 : 1);
        if ([4, 5].every((lp) => union.includes(lp))) {
          score += this.configs.S05.mode === 'soft' ? this.configs.S05.weight : 4;
        }
        if (maxRunLength(union) > 4 || union.length > 6) {
          score += this.configs.S06.mode === 'soft' ? this.configs.S06.weight : 4;
        }
      }
    }

    // Room type match (H05 soft)
    if (task.requiredRoomTypeId && room.roomTypeId !== task.requiredRoomTypeId) {
      score += this.configs.H05.mode === 'soft' ? this.configs.H05.weight * 4 : 10;
    }

    // Room capacity fit (S04)
    if (!room.allowMultiGroup && room.capacity > 0) {
      const wastedRatio = Math.max(0, room.capacity - task.studentCount) / room.capacity;
      score += wastedRatio * periods.length * (this.configs.S04.mode === 'soft' ? this.configs.S04.weight : 1.5);
    }

    // Group lunch soft aversion even when H06 is off, plus daily balance S13, gaps S01, room changes S10
    for (const gid of task.audienceGroupIds) {
      const g = this.groupById.get(gid);
      if (g && periods.includes(g.lunchPeriod)) score += 25;
      const gDays = this.groupDailyPeriods.get(gid);
      const existingOnDay = gDays?.get(day);
      if (existingOnDay && existingOnDay.size > 0) {
        const union = [...existingOnDay, ...periods].sort((a, b) => a - b);
        const span = union[union.length - 1]! - union[0]! + 1;
        const lunchInSpan = g && g.lunchPeriod > union[0]! && g.lunchPeriod < union[union.length - 1]! && !union.includes(g.lunchPeriod) ? 1 : 0;
        const gaps = Math.max(0, span - union.length - lunchInSpan);
        score += gaps * (this.configs.S01.mode === 'soft' ? this.configs.S01.weight * 0.6 : 2);
        score += existingOnDay.size * 0.8; // encourages daily balance (S13)
      } else {
        score -= 1.5; // mildly prefer spreading onto unused days (S13 / S02)
      }
    }

    // Time preference (S03)
    if (task.timePreference === 'morning') {
      const bad = periods.filter((p) => p > 4).length;
      score += bad * (this.configs.S03.mode === 'soft' ? this.configs.S03.weight : 1.5);
    } else if (task.timePreference === 'afternoon') {
      const bad = periods.filter((p) => p < 6).length;
      score += bad * (this.configs.S03.mode === 'soft' ? this.configs.S03.weight : 1.5);
    }

    // Same offering segment spread / content order (S02 / S11)
    const siblingIds = this.offeringPlacements.get(task.offeringId);
    if (siblingIds) {
      for (const sid of siblingIds) {
        const sib = this.placements.get(sid);
        if (!sib || sib.task.subgroupId !== task.subgroupId) continue;
        if (sib.day === day) score += 8;
        else if (Math.abs(sib.day - day) === 1) score += 2.5;
        if (sib.task.segmentIndex < task.segmentIndex && day * 100 + startPeriod < sib.day * 100 + sib.startPeriod) {
          score += 12;
        } else if (sib.task.segmentIndex > task.segmentIndex && day * 100 + startPeriod > sib.day * 100 + sib.startPeriod) {
          score += 12;
        }
      }
    }

    return score;
  }

  place(p: SolverPlacement): void {
    if (this.placements.has(p.itemId)) this.unplace(p.itemId);
    const room = this.roomById.get(p.roomId) ?? null;
    this.occupancy.addItem({
      itemId: p.itemId,
      day: p.day,
      startPeriod: p.startPeriod,
      duration: p.task.duration,
      teacherIds: p.teacherIds,
      groupIds: p.task.audienceGroupIds,
      subgroupId: p.task.subgroupId,
      room,
      studentCount: p.task.studentCount,
    });
    this.placements.set(p.itemId, p);
    const offSet = this.offeringPlacements.get(p.task.offeringId) ?? new Set<string>();
    offSet.add(p.itemId);
    this.offeringPlacements.set(p.task.offeringId, offSet);

    for (const tid of p.teacherIds) {
      const days = this.teacherDailyPeriods.get(tid) ?? new Map<number, Set<number>>();
      const ps = days.get(p.day) ?? new Set<number>();
      for (let per = p.startPeriod; per < p.startPeriod + p.task.duration; per++) ps.add(per);
      days.set(p.day, ps);
      this.teacherDailyPeriods.set(tid, days);
    }
    for (const gid of p.task.audienceGroupIds) {
      const days = this.groupDailyPeriods.get(gid) ?? new Map<number, Set<number>>();
      const ps = days.get(p.day) ?? new Set<number>();
      for (let per = p.startPeriod; per < p.startPeriod + p.task.duration; per++) ps.add(per);
      days.set(p.day, ps);
      this.groupDailyPeriods.set(gid, days);
    }
  }

  unplace(itemId: string): SolverPlacement | undefined {
    const p = this.placements.get(itemId);
    if (!p) return undefined;
    this.occupancy.removeItem(itemId);
    this.placements.delete(itemId);
    this.offeringPlacements.get(p.task.offeringId)?.delete(itemId);

    for (const tid of p.teacherIds) {
      const ps = this.teacherDailyPeriods.get(tid)?.get(p.day);
      if (ps) {
        for (let per = p.startPeriod; per < p.startPeriod + p.task.duration; per++) ps.delete(per);
        if (ps.size === 0) this.teacherDailyPeriods.get(tid)?.delete(p.day);
      }
    }
    for (const gid of p.task.audienceGroupIds) {
      const ps = this.groupDailyPeriods.get(gid)?.get(p.day);
      if (ps) {
        for (let per = p.startPeriod; per < p.startPeriod + p.task.duration; per++) ps.delete(per);
        if (ps.size === 0) this.groupDailyPeriods.get(gid)?.delete(p.day);
      }
    }
    return p;
  }

  /** Materialize board placements + optional unplaced tasks into `ScheduleItem[]` & `ScheduleItemTeacher[]`. */
  toScheduleRows(
    versionId: string,
    lockedIds: ReadonlySet<string> = new Set(),
    unplacedTasks: readonly ScheduleTask[] = [],
  ): { items: ScheduleItem[]; itemTeachers: ScheduleItemTeacher[] } {
    const items: ScheduleItem[] = [];
    const itemTeachers: ScheduleItemTeacher[] = [];
    for (const p of this.placements.values()) {
      items.push({
        id: p.itemId,
        versionId,
        offeringId: p.task.offeringId,
        segmentIndex: p.task.segmentIndex,
        subgroupId: p.task.subgroupId,
        roomId: p.roomId,
        dayOfWeek: p.day,
        startPeriod: p.startPeriod,
        duration: p.task.duration,
        status: 'scheduled',
        isLocked: lockedIds.has(p.itemId),
        explanation: null,
        rowVersion: 1,
        updatedBy: 'solver',
        updatedAt: null,
      });
      for (const tid of p.teacherIds) {
        itemTeachers.push({ itemId: p.itemId, staffId: tid });
      }
    }
    for (const ut of unplacedTasks) {
      const itemId = `unplaced:${ut.taskId}`;
      items.push({
        id: itemId,
        versionId,
        offeringId: ut.offeringId,
        segmentIndex: ut.segmentIndex,
        subgroupId: ut.subgroupId,
        roomId: null,
        dayOfWeek: null,
        startPeriod: null,
        duration: ut.duration,
        status: 'unplaced_tray',
        isLocked: false,
        explanation: null,
        rowVersion: 1,
        updatedBy: 'solver',
        updatedAt: null,
      });
      for (const tid of ut.preferredTeachers) {
        itemTeachers.push({ itemId, staffId: tid });
      }
    }
    return { items, itemTeachers };
  }
}

function maxRunLength(sortedOrSet: number[]): number {
  if (sortedOrSet.length === 0) return 0;
  const s = [...new Set(sortedOrSet)].sort((a, b) => a - b);
  let best = 1;
  let cur = 1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1]! + 1) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}
