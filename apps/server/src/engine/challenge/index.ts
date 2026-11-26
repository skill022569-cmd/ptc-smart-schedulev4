import {
  evaluateSchedule,
  renderMessageTh,
  type ChallengeRule,
  type ConstraintCode,
  type ConstraintOverride,
  type EvaluationReport,
  type FixedBlockAppliesTo,
  type ScheduleEvaluationContext,
  type ScheduleItem,
  type SlotRef,
} from '@ptc/shared';

export interface ChallengeImpactReport {
  modifiedCtx: ScheduleEvaluationContext;
  report: EvaluationReport;
  violatedItemIds: string[];
  affectedGroupIds: string[];
  affectedStaffIds: string[];
  violationCount: number;
}

export interface MovedItemDiff {
  itemId: string;
  offeringId: string;
  subjectCode: string;
  subjectName: string;
  beforeText: string;
  afterText: string;
  reasonTh: string;
}

export interface BeforeAfterDiff {
  movedCount: number;
  movedItems: MovedItemDiff[];
  beforeHardCount: number;
  afterHardCount: number;
  beforePenalty: number;
  afterPenalty: number;
  beforeFitness: number;
  afterFitness: number;
  affectedGroupCount: number;
  affectedTeacherCount: number;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function asNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
}

function expandSlots(params: Record<string, unknown>): SlotRef[] {
  if (Array.isArray(params.slots)) {
    return params.slots
      .map((s) => {
        const o = s as Record<string, unknown>;
        return { day: Number(o.day), period: Number(o.period) };
      })
      .filter((s) => Number.isFinite(s.day) && Number.isFinite(s.period));
  }
  const days = asNumberArray(params.days);
  const periods = asNumberArray(params.periods);
  const out: SlotRef[] = [];
  for (const day of days) for (const period of periods) out.push({ day, period });
  return out;
}

/**
 * Clone `ctx` and apply active `challenge_rules` (all 4 Lucky Challenge categories)
 * without mutating the caller's context.
 */
export function applyChallengeRules(
  ctx: ScheduleEvaluationContext,
  rules: readonly ChallengeRule[],
): ScheduleEvaluationContext {
  const active = rules.filter((r) => r.isActive !== false);
  const next: ScheduleEvaluationContext = {
    ...ctx,
    timeSlots: ctx.timeSlots.map((s) => ({ ...s, openDays: [...s.openDays] })),
    rooms: ctx.rooms.map((r) => ({ ...r, unavailableSlots: r.unavailableSlots ? [...r.unavailableSlots] : null })),
    staff: ctx.staff.map((s) => ({
      ...s,
      availableSlots: s.availableSlots ? [...s.availableSlots] : null,
      unavailableSlots: s.unavailableSlots ? [...s.unavailableSlots] : null,
    })),
    studentGroups: ctx.studentGroups.map((g) => ({
      ...g,
      allowedDays: [...g.allowedDays],
      unavailableSlots: g.unavailableSlots ? [...g.unavailableSlots] : null,
    })),
    subjects: ctx.subjects.map((s) => ({ ...s })),
    offerings: ctx.offerings.map((o) => ({ ...o })),
    offeringGroups: ctx.offeringGroups.map((og) => ({ ...og })),
    offeringTeachers: ctx.offeringTeachers.map((ot) => ({ ...ot })),
    fixedBlocks: ctx.fixedBlocks.map((fb) => ({ ...fb })),
    overrides: { ...(ctx.overrides ?? {}) },
  };

  const setOverride = (code: ConstraintCode, o: ConstraintOverride) => {
    next.overrides![code] = { ...(next.overrides![code] ?? {}), ...o };
  };

  for (const rule of active) {
    const target = (rule.target ?? {}) as Record<string, unknown>;
    const params = (rule.params ?? {}) as Record<string, unknown>;
    const mode = rule.mode === 'soft' ? 'soft' : 'hard';

    switch (rule.ruleType) {
      case 'block_slots': {
        const days = asNumberArray(params.days);
        const periods = asNumberArray(params.periods);
        const sortedP = [...periods].sort((a, b) => a - b);
        const startPeriod = sortedP[0] ?? 7;
        const duration = Math.max(1, sortedP.length);
        const appliesTo: FixedBlockAppliesTo = target.all
          ? { all: true }
          : {
              groupIds: asStringArray(target.group_ids ?? target.groupIds),
              staffIds: asStringArray(target.staff_ids ?? target.staffIds),
            };
        for (const day of days.length > 0 ? days : [3]) {
          next.fixedBlocks.push({
            id: `challenge:${rule.id}:${day}`,
            termId: next.term.id,
            name: rule.description || 'Lucky Challenge Block',
            blockType: 'activity',
            dayOfWeek: day,
            startPeriod,
            duration,
            roomId: typeof target.room_id === 'string' ? target.room_id : null,
            appliesTo,
          });
        }
        setOverride('H08', { mode });
        break;
      }
      case 'group_lunch': {
        const gIds = new Set(asStringArray(target.group_ids ?? target.groupIds));
        const lunchPeriod = Number(params.lunch_period ?? params.lunchPeriod ?? 4);
        for (const g of next.studentGroups) {
          if (target.all || gIds.has(g.id) || gIds.has(g.groupCode)) g.lunchPeriod = lunchPeriod;
        }
        setOverride('H06', { mode });
        break;
      }
      case 'group_days': {
        const gIds = new Set(asStringArray(target.group_ids ?? target.groupIds));
        const days = asNumberArray(params.days ?? params.allowed_days);
        if (days.length > 0) {
          for (const g of next.studentGroups) {
            if (target.all || gIds.has(g.id) || gIds.has(g.groupCode)) g.allowedDays = [...days];
          }
        }
        setOverride('H10', { mode });
        break;
      }
      case 'add_slots': {
        const addPeriods = asNumberArray(params.periods);
        const openDays = asNumberArray(params.days);
        for (const ts of next.timeSlots) {
          for (const d of openDays) if (!ts.openDays.includes(d)) ts.openDays.push(d);
          ts.openDays.sort((a, b) => a - b);
        }
        for (const p of addPeriods) {
          if (!next.timeSlots.some((ts) => ts.period === p)) {
            const hour = 7 + p;
            next.timeSlots.push({
              id: `challenge-ts-${p}`,
              termId: next.term.id,
              period: p,
              startTime: `${String(hour).padStart(2, '0')}:00:00`,
              endTime: `${String(hour + 1).padStart(2, '0')}:00:00`,
              shift: p >= 10 ? 'evening' : 'day',
              openDays: openDays.length > 0 ? [...openDays] : [1, 2, 3, 4, 5],
            });
          }
        }
        if (typeof params.max_days === 'number') setOverride('H16', { mode, params: { maxDays: params.max_days } });
        break;
      }
      case 'room_closed': {
        const rIds = new Set(asStringArray(target.room_ids ?? target.roomIds));
        const slots = expandSlots(params);
        for (const r of next.rooms) {
          if (target.all || rIds.has(r.id) || rIds.has(r.roomCode)) {
            r.unavailableSlots = [...(r.unavailableSlots ?? []), ...slots];
          }
        }
        setOverride('H07', { mode: 'hard' });
        break;
      }
      case 'room_capacity': {
        const rIds = new Set(asStringArray(target.room_ids ?? target.roomIds));
        const cap = Number(params.capacity);
        if (Number.isFinite(cap) && cap > 0) {
          for (const r of next.rooms) {
            if (target.all || rIds.has(r.id) || rIds.has(r.roomCode)) r.capacity = cap;
          }
        }
        setOverride('H04', { mode: 'hard' });
        break;
      }
      case 'room_type_strict': {
        setOverride('H05', { mode: 'hard' });
        break;
      }
      case 'building_gap': {
        const gap = Number(params.gap ?? 1);
        setOverride('H12', { mode, params: { gap } });
        break;
      }
      case 'consecutive': {
        const sIds = new Set(asStringArray(target.subject_ids ?? target.subjectIds));
        for (const s of next.subjects) {
          if (target.all || sIds.has(s.id) || sIds.has(s.subjectCode)) s.mustBeConsecutive = true;
        }
        setOverride('H09', { mode });
        break;
      }
      case 'combine_groups': {
        const oIds = new Set(asStringArray(target.offering_ids ?? target.offeringIds));
        const extraGroups = asStringArray(params.group_ids ?? params.groupIds);
        for (const o of next.offerings) {
          if (!oIds.has(o.id)) continue;
          o.offeringType = 'combined';
          for (const gid of extraGroups) {
            if (!next.offeringGroups.some((og) => og.offeringId === o.id && og.groupId === gid)) {
              next.offeringGroups.push({ offeringId: o.id, groupId: gid });
            }
          }
        }
        break;
      }
      case 'split_group': {
        const oIds = new Set(asStringArray(target.offering_ids ?? target.offeringIds));
        for (const o of next.offerings) {
          if (oIds.has(o.id)) o.offeringType = 'split';
        }
        break;
      }
      case 'spread_days':
      case 'time_of_day': {
        if (rule.ruleType === 'spread_days') {
          setOverride('S02', { mode, weight: Number(params.weight ?? 10) });
        } else {
          const sIds = new Set(asStringArray(target.subject_ids ?? target.subjectIds));
          const pref = params.preference === 'afternoon' ? 'afternoon' : 'morning';
          for (const s of next.subjects) {
            if (target.all || sIds.has(s.id) || sIds.has(s.subjectCode)) s.timePreference = pref;
          }
          setOverride('S03', { mode, weight: Number(params.weight ?? 10) });
        }
        break;
      }
      case 'teacher_leave': {
        const stIds = new Set(asStringArray(target.staff_ids ?? target.staffIds));
        const slots = expandSlots(params);
        for (const st of next.staff) {
          if (target.all || stIds.has(st.id) || stIds.has(st.employeeCode)) {
            st.unavailableSlots = [...(st.unavailableSlots ?? []), ...slots];
          }
        }
        setOverride('H07', { mode: 'hard' });
        break;
      }
      case 'teacher_window': {
        const stIds = new Set(asStringArray(target.staff_ids ?? target.staffIds));
        const slots = expandSlots(params);
        for (const st of next.staff) {
          if (target.all || stIds.has(st.id) || stIds.has(st.employeeCode)) {
            st.availableSlots = slots;
          }
        }
        setOverride('H07', { mode: 'hard' });
        break;
      }
      case 'teacher_day_off': {
        const stIds = new Set(asStringArray(target.staff_ids ?? target.staffIds));
        const dayOff = Number(params.day ?? params.day_off ?? 5);
        for (const st of next.staff) {
          if (target.all || stIds.has(st.id) || stIds.has(st.employeeCode)) st.dayOff = dayOff;
        }
        setOverride('H15', { mode: 'hard' });
        break;
      }
      case 'teacher_limits': {
        const maxDaily = Number(params.max_daily ?? params.maxDaily ?? 6);
        const maxCons = Number(params.max_consecutive ?? params.maxConsecutive ?? 3);
        const stIds = new Set(asStringArray(target.staff_ids ?? target.staffIds));
        for (const st of next.staff) {
          if (target.all || stIds.size === 0 || stIds.has(st.id) || stIds.has(st.employeeCode)) {
            st.maxDailyPeriods = maxDaily;
            st.maxConsecutive = maxCons;
          }
        }
        setOverride('H13', { mode, params: { max: maxDaily } });
        setOverride('H14', { mode, params: { max: maxCons } });
        break;
      }
      case 'team_teaching': {
        const oIds = new Set(asStringArray(target.offering_ids ?? target.offeringIds));
        const coStaff = asStringArray(params.staff_ids ?? params.staffIds);
        for (const o of next.offerings) {
          if (!oIds.has(o.id)) continue;
          o.offeringType = 'team';
          for (const sid of coStaff) {
            if (!next.offeringTeachers.some((ot) => ot.offeringId === o.id && ot.staffId === sid)) {
              next.offeringTeachers.push({ offeringId: o.id, staffId: sid, subgroupCode: null, role: 'co' });
            }
          }
        }
        setOverride('H11', { mode: 'hard' });
        break;
      }
    }
  }

  return next;
}

/** Immediately inspect which items/groups/teachers in the current schedule violate active Lucky Challenge rules. */
export function evaluateChallengeImpact(
  ctx: ScheduleEvaluationContext,
  rules: readonly ChallengeRule[],
): ChallengeImpactReport {
  const modifiedCtx = applyChallengeRules(ctx, rules);
  const report = evaluateSchedule(modifiedCtx, { includePassedExplanations: false });
  const violatedSet = new Set<string>();
  const groupSet = new Set<string>();
  const staffSet = new Set<string>();

  const itemById = new Map(modifiedCtx.items.map((i) => [i.id, i]));
  const groupsByOff = new Map<string, string[]>();
  for (const og of modifiedCtx.offeringGroups) {
    const l = groupsByOff.get(og.offeringId) ?? [];
    l.push(og.groupId);
    groupsByOff.set(og.offeringId, l);
  }
  const teachersByItem = new Map<string, string[]>();
  for (const it of modifiedCtx.itemTeachers) {
    const l = teachersByItem.get(it.itemId) ?? [];
    l.push(it.staffId);
    teachersByItem.set(it.itemId, l);
  }

  for (const v of report.hardViolations) {
    for (const id of v.itemIds) {
      violatedSet.add(id);
      const item = itemById.get(id);
      if (item) {
        for (const g of groupsByOff.get(item.offeringId) ?? []) groupSet.add(g);
        for (const t of teachersByItem.get(id) ?? []) staffSet.add(t);
      }
    }
    if (v.resourceType === 'group' && v.resourceId) groupSet.add(v.resourceId);
    if (v.resourceType === 'teacher' && v.resourceId) staffSet.add(v.resourceId);
  }

  return {
    modifiedCtx,
    report,
    violatedItemIds: [...violatedSet],
    affectedGroupIds: [...groupSet],
    affectedStaffIds: [...staffSet],
    violationCount: report.hardCount,
  };
}

/** Build a Before/After summary comparing an original schedule against a repaired/re-solved schedule. */
export function diffScheduleVersions(
  beforeCtx: ScheduleEvaluationContext,
  afterCtx: ScheduleEvaluationContext,
  beforeReport: EvaluationReport,
  afterReport: EvaluationReport,
): BeforeAfterDiff {
  const roomById = new Map(afterCtx.rooms.map((r) => [r.id, r]));
  const offById = new Map(afterCtx.offerings.map((o) => [o.id, o]));
  const subjById = new Map(afterCtx.subjects.map((s) => [s.id, s]));
  const groupsByOff = new Map<string, string[]>();
  for (const og of afterCtx.offeringGroups) {
    const l = groupsByOff.get(og.offeringId) ?? [];
    l.push(og.groupId);
    groupsByOff.set(og.offeringId, l);
  }
  const teachersByItem = new Map<string, string[]>();
  for (const it of afterCtx.itemTeachers) {
    const l = teachersByItem.get(it.itemId) ?? [];
    l.push(it.staffId);
    teachersByItem.set(it.itemId, l);
  }

  const key = (i: ScheduleItem) => `${i.offeringId}|${i.segmentIndex}|${i.subgroupId ?? ''}`;
  const beforeMap = new Map(beforeCtx.items.map((i) => [key(i), i]));
  const fmt = (i: ScheduleItem | undefined) => {
    if (!i || i.dayOfWeek === null || i.startPeriod === null) return 'ถาดรอจัด';
    const r = i.roomId ? roomById.get(i.roomId)?.roomCode ?? i.roomId : '-';
    return `วัน ${i.dayOfWeek} คาบ ${i.startPeriod} (${i.duration} ชม.) ห้อง ${r}`;
  };

  const movedItems: MovedItemDiff[] = [];
  const affectedGroups = new Set<string>();
  const affectedTeachers = new Set<string>();

  for (const afterItem of afterCtx.items) {
    const prev = beforeMap.get(key(afterItem));
    const changed =
      !prev ||
      prev.dayOfWeek !== afterItem.dayOfWeek ||
      prev.startPeriod !== afterItem.startPeriod ||
      (prev.roomId ?? null) !== (afterItem.roomId ?? null);
    if (!changed) continue;
    const off = offById.get(afterItem.offeringId);
    const subj = off ? subjById.get(off.subjectId) : undefined;
    const beforeText = fmt(prev);
    const afterText = fmt(afterItem);
    movedItems.push({
      itemId: afterItem.id,
      offeringId: afterItem.offeringId,
      subjectCode: subj?.subjectCode ?? afterItem.offeringId,
      subjectName: subj?.subjectName ?? '',
      beforeText,
      afterText,
      reasonTh: renderMessageTh('S07.changed', {
        subject: subj ? `${subj.subjectCode} ${subj.subjectName}` : afterItem.offeringId,
        before: beforeText,
        after: afterText,
      }),
    });
    for (const g of groupsByOff.get(afterItem.offeringId) ?? []) affectedGroups.add(g);
    for (const t of teachersByItem.get(afterItem.id) ?? []) affectedTeachers.add(t);
  }

  return {
    movedCount: movedItems.length,
    movedItems,
    beforeHardCount: beforeReport.hardCount,
    afterHardCount: afterReport.hardCount,
    beforePenalty: beforeReport.totalPenalty,
    afterPenalty: afterReport.totalPenalty,
    beforeFitness: beforeReport.fitness,
    afterFitness: afterReport.fitness,
    affectedGroupCount: affectedGroups.size,
    affectedTeacherCount: affectedTeachers.size,
  };
}
