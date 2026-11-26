/**
 * Constraint Engine entry point: resolve configs → run every active evaluator →
 * split Hard / Soft → fitness, multi-objective metrics and per-item XAI entries.
 */
import { renderMessageTh } from '../explain/messages.th';
import type { ConstraintCode, JsonObject, XaiExplanationEntry } from '../types';
import { CONSTRAINT_CATALOG, CONSTRAINT_CODES, isHardCode, resolveConstraintConfigs } from './catalog';
import { EvaluationIndex } from './context';
import { computeOfferingHours, HARD_EVALUATORS } from './hard';
import { round } from './params';
import { SOFT_EVALUATORS } from './soft';
import { evaluateS05, evaluateS06 } from './soft/teacher';
import type {
  ActiveConstraintMode,
  ConstraintEvaluator,
  ConstraintViolation,
  EvaluateOptions,
  EvaluationReport,
  MultiObjectiveMetrics,
  ResolvedConstraintConfigMap,
  ScheduleEvaluationContext,
  SoftPenaltyDetail,
  UnplacedOffering,
  ViolationDraft,
} from './types';

export function getEvaluator(code: ConstraintCode): ConstraintEvaluator {
  return isHardCode(code) ? HARD_EVALUATORS[code] : SOFT_EVALUATORS[code];
}

export function finalizeViolation(code: ConstraintCode, mode: ActiveConstraintMode, d: ViolationDraft): ConstraintViolation {
  const v: ConstraintViolation = {
    code,
    name: CONSTRAINT_CATALOG[code].key,
    mode,
    severity: d.severity ?? 1,
    itemIds: d.itemIds,
    messageKey: d.messageKey,
    params: d.params,
    messageTh: renderMessageTh(d.messageKey, d.params),
  };
  if (d.offeringId !== undefined) v.offeringId = d.offeringId;
  if (d.resourceType !== undefined) v.resourceType = d.resourceType;
  if (d.resourceId !== undefined) v.resourceId = d.resourceId;
  if (d.day !== undefined) v.day = d.day;
  if (d.period !== undefined) v.period = d.period;
  return v;
}

/**
 * Run one constraint regardless of the profile (useful for tests, the Repair Agent and
 * drag & drop previews). Mode defaults to the configured mode, or the catalog kind when off.
 */
export function evaluateConstraint(
  ctx: ScheduleEvaluationContext,
  code: ConstraintCode,
  options: { params?: JsonObject; mode?: ActiveConstraintMode; index?: EvaluationIndex } = {},
): ConstraintViolation[] {
  const { configs } = resolveConstraintConfigs(ctx);
  const cfg = configs[code];
  const mode: ActiveConstraintMode = options.mode ?? (cfg.mode === 'off' ? CONSTRAINT_CATALOG[code].kind : cfg.mode);
  const index = options.index ?? new EvaluationIndex(ctx);
  const drafts = getEvaluator(code)({ ctx, index, params: { ...cfg.params, ...(options.params ?? {}) }, mode });
  return drafts.map((d) => finalizeViolation(code, mode, d));
}

/** Teacher satisfaction (S05/S06-free teacher-days) and room utilisation. */
export function computeMultiObjective(
  ctx: ScheduleEvaluationContext,
  index: EvaluationIndex,
  configs: ResolvedConstraintConfigMap,
): MultiObjectiveMetrics {
  const teacherDayKeys = new Set<string>();
  for (const [staffId, days] of index.teacherTimelines()) for (const day of days.keys()) teacherDayKeys.add(`${staffId}|${day}`);
  const unhappy = new Set<string>();
  for (const [code, evaluator] of [
    ['S05', evaluateS05],
    ['S06', evaluateS06],
  ] as const) {
    for (const v of evaluator({ ctx, index, params: configs[code].params, mode: 'soft' })) {
      const key = `${v.resourceId}|${v.day}`;
      if (teacherDayKeys.has(key)) unhappy.add(key);
    }
  }
  const teacherDays = teacherDayKeys.size;
  const satisfiedTeacherDays = teacherDays - unhappy.size;

  const used = new Set<string>();
  for (const p of index.placed) {
    if (!p.room) continue;
    for (const period of p.periods) if (index.isSlotOpen(p.day, period)) used.add(`${p.room.id}|${p.day}|${period}`);
  }
  let availableRoomHours = 0;
  for (const room of ctx.rooms) {
    const unavailable = index.roomUnavailable.get(room.id);
    for (const slot of index.timeSlotByPeriod.values()) {
      for (const day of new Set(slot.openDays ?? [])) if (!unavailable?.has(`${day}:${slot.period}`)) availableRoomHours++;
    }
  }
  const scheduledRoomHours = used.size;
  return {
    teacherSatisfaction: teacherDays === 0 ? 1 : round(satisfiedTeacherDays / teacherDays),
    roomUtilization: availableRoomHours === 0 ? 0 : round(Math.min(1, scheduledRoomHours / availableRoomHours)),
    teacherDays,
    satisfiedTeacherDays,
    scheduledRoomHours,
    availableRoomHours,
  };
}

function buildExplanations(
  ctx: ScheduleEvaluationContext,
  index: EvaluationIndex,
  configs: ResolvedConstraintConfigMap,
  violations: ConstraintViolation[],
  includePassed: boolean,
): Record<string, XaiExplanationEntry[]> {
  const out: Record<string, XaiExplanationEntry[]> = {};
  const failed = new Map<string, Set<ConstraintCode>>();
  for (const item of ctx.items) {
    out[item.id] = [];
    failed.set(item.id, new Set());
  }
  for (const v of violations) {
    for (const itemId of v.itemIds) {
      const list = out[itemId];
      if (!list) continue;
      const entry: XaiExplanationEntry = {
        code: v.code,
        mode: v.mode,
        passed: false,
        messageKey: v.messageKey,
        params: v.params,
        messageTh: v.messageTh,
      };
      if (v.mode === 'soft') {
        entry.weight = configs[v.code].weight;
        entry.penalty = round(v.severity * configs[v.code].weight);
      }
      list.push(entry);
      failed.get(itemId)?.add(v.code);
    }
  }
  if (includePassed) {
    const active = CONSTRAINT_CODES.filter((c) => configs[c].mode !== 'off');
    for (const item of ctx.items) {
      if (!index.placedById.has(item.id)) continue;
      const bad = failed.get(item.id) ?? new Set<ConstraintCode>();
      for (const code of active) {
        if (bad.has(code)) continue;
        const mode = configs[code].mode as ActiveConstraintMode;
        out[item.id].push({
          code,
          mode,
          passed: true,
          messageKey: `${code}.pass`,
          params: {},
          messageTh: renderMessageTh(`${code}.pass`),
        });
      }
    }
  }
  return out;
}

export function evaluateSchedule(ctx: ScheduleEvaluationContext, options: EvaluateOptions = {}): EvaluationReport {
  const { profileName, configs } = resolveConstraintConfigs(ctx);
  const index = new EvaluationIndex(ctx);
  const hardViolations: ConstraintViolation[] = [];
  const hardCountsByCode: Partial<Record<ConstraintCode, number>> = {};
  const softPenalties: SoftPenaltyDetail[] = [];

  for (const code of CONSTRAINT_CODES) {
    const cfg = configs[code];
    if (cfg.mode === 'off') continue;
    const mode = cfg.mode;
    const violations = getEvaluator(code)({ ctx, index, params: cfg.params, mode }).map((d) => finalizeViolation(code, mode, d));
    if (mode === 'hard') {
      hardViolations.push(...violations);
      hardCountsByCode[code] = violations.length;
      continue;
    }
    const rawPenalty = round(violations.reduce((n, v) => n + v.severity, 0));
    const weightedPenalty = round(rawPenalty * cfg.weight);
    const name = CONSTRAINT_CATALOG[code].key;
    softPenalties.push({
      code,
      name,
      weight: cfg.weight,
      rawPenalty,
      weightedPenalty,
      violations,
      messageTh: renderMessageTh('soft.summary', {
        name: `${code} ${CONSTRAINT_CATALOG[code].nameTh}`,
        count: violations.length,
        raw: rawPenalty,
        weight: cfg.weight,
        weighted: weightedPenalty,
      }),
    });
  }

  const totalPenalty = round(softPenalties.reduce((n, s) => n + s.weightedPenalty, 0));
  const unplacedOfferings: UnplacedOffering[] = computeOfferingHours(index)
    .filter((h) => h.scheduled < h.required)
    .map((h) => ({
      offeringId: h.offering.id,
      subjectId: h.offering.subjectId,
      requiredPeriods: h.required,
      scheduledPeriods: h.scheduled,
      missingPeriods: h.required - h.scheduled,
    }));

  return {
    profileName,
    configs,
    hardViolations,
    hardCount: hardViolations.length,
    hardCountsByCode,
    softPenalties,
    totalPenalty,
    fitness: round(1000 / (1 + totalPenalty)),
    multiObjective: computeMultiObjective(ctx, index, configs),
    itemExplanations: buildExplanations(
      ctx,
      index,
      configs,
      [...hardViolations, ...softPenalties.flatMap((s) => s.violations)],
      options.includePassedExplanations ?? true,
    ),
    unplacedOfferings,
  };
}
