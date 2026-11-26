import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_CATALOG,
  CONSTRAINT_CODES,
  HARD_CONSTRAINT_CODES,
  MESSAGE_TEMPLATES_TH,
  SOFT_CONSTRAINT_CODES,
  activeCodes,
  buildQualitySummary4D,
  evaluateSchedule,
  formatSlotTimeTh,
  getProfileConfigs,
  renderMessageTh,
  resolveConstraintConfigs,
  resolveProfile,
} from '../../packages/shared/src';
import { THAI, world } from './fixtures';

describe('Constraint Catalog & Built-in Profiles', () => {
  it('registers all 21 Hard (H01-H21) and 13 Soft (S01-S13) codes with Thai names', () => {
    expect(HARD_CONSTRAINT_CODES).toHaveLength(21);
    expect(SOFT_CONSTRAINT_CODES).toHaveLength(13);
    expect(CONSTRAINT_CODES).toHaveLength(34);
    for (const code of CONSTRAINT_CODES) {
      const entry = CONSTRAINT_CATALOG[code];
      expect(entry.nameTh).toMatch(THAI);
      expect(entry.descriptionTh).toMatch(THAI);
    }
  });

  it('configures `competition` profile with Core 10 Hard / 10 Soft and `default` with all Hard + S01-S07', () => {
    const comp = resolveProfile('competition');
    expect(activeCodes(comp, 'hard')).toEqual(['H01', 'H02', 'H03', 'H04', 'H07', 'H18', 'H19', 'H20', 'H21']);
    expect(activeCodes(comp, 'soft').sort()).toEqual(
      ['H05', 'H09', 'S01', 'S06', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13'].sort(),
    );
    expect(comp.H06.mode).toBe('off');
    expect(comp.H08.mode).toBe('off');
    expect(comp.H13.mode).toBe('off');

    const def = resolveProfile('default');
    expect(activeCodes(def, 'hard')).toEqual(HARD_CONSTRAINT_CODES);
    expect(activeCodes(def, 'soft')).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07']);
    expect(def.S01.weight).toBe(10);
    expect(def.S07.weight).toBe(20);
  });

  it('prioritises teacher metrics in `teacher_first` and room metrics in `room_first`', () => {
    const tf = resolveProfile('teacher_first');
    const rf = resolveProfile('room_first');
    expect(tf.S05.weight).toBeGreaterThan(rf.S05.weight);
    expect(tf.S06.weight).toBeGreaterThan(rf.S06.weight);
    expect(rf.S04.weight).toBeGreaterThan(tf.S04.weight);
    expect(rf.S10.weight).toBeGreaterThan(tf.S10.weight);
    expect(getProfileConfigs('competition')).toHaveLength(34);
  });

  it('merges catalog -> profile -> constraintConfigs -> overrides in order', () => {
    const w = world();
    w.ctx.profileName = 'competition';
    w.ctx.constraintConfigs = [
      { id: 'c1', profileName: 'competition', code: 'S01', mode: 'soft', weight: 25, params: { allowedGaps: 1 } },
      { id: 'c2', profileName: 'default', code: 'S01', mode: 'soft', weight: 99, params: null }, // ignored
    ];
    w.ctx.overrides = { H06: { mode: 'hard' }, S01: { weight: 30 } };
    const { profileName, configs } = resolveConstraintConfigs(w.ctx);
    expect(profileName).toBe('competition');
    expect(configs.H06.mode).toBe('hard');
    expect(configs.H06.source).toBe('override');
    expect(configs.S01.weight).toBe(30);
    expect(configs.S01.params).toMatchObject({ allowedGaps: 1 });
  });
});

describe('evaluateSchedule, Fitness, Multi-Objective & QualitySummary4D', () => {
  it('computes fitness = 1000 / (1 + totalPenalty) and clean evaluation on valid competition schedule', () => {
    const w = world()
      .only('O_TH_G1', 'O_LAB_G1')
      .place({ id: 'a', offering: 'O_TH_G1', day: 1, start: 1, duration: 2, room: 'R1' })
      .place({ id: 'b', offering: 'O_LAB_G1', day: 2, start: 1, duration: 3, room: 'LAB1' });
    w.ctx.profileName = 'competition';

    const report = evaluateSchedule(w.ctx);
    expect(report.hardCount).toBe(0);
    expect(report.unplacedOfferings).toEqual([]);
    const expectedPenalty = report.softPenalties.reduce((s, p) => s + p.weightedPenalty, 0);
    expect(report.totalPenalty).toBeCloseTo(expectedPenalty, 4);
    expect(report.fitness).toBeCloseTo(1000 / (1 + report.totalPenalty), 2);
    expect(report.multiObjective.teacherSatisfaction).toBe(1);
    expect(report.multiObjective.roomUtilization).toBeGreaterThan(0);

    // Explanations should exist for every placed item
    expect(report.itemExplanations.a.length).toBeGreaterThan(0);
    expect(report.itemExplanations.a.every((e) => e.passed && e.messageTh && THAI.test(e.messageTh))).toBe(true);
  });

  it('populates failed XAI entries with weights/penalties when soft/hard violations occur', () => {
    const w = world()
      .only('O_TH_G1', 'O_MATH_G1')
      .place({ id: 'a', offering: 'O_TH_G1', day: 1, start: 1, duration: 2, room: 'R1' })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 1, start: 5, duration: 1, room: 'R2', segment: 0 })
      .place({ id: 'c', offering: 'O_MATH_G1', day: 1, start: 7, duration: 1, room: 'R2', segment: 1 }); // S01 gaps + S10 room change
    w.ctx.profileName = 'competition';

    const report = evaluateSchedule(w.ctx, { includePassedExplanations: false });
    expect(report.hardCount).toBe(0);
    expect(report.totalPenalty).toBeGreaterThan(0);
    expect(report.fitness).toBeLessThan(1000);
    const bFail = report.itemExplanations.b.filter((e) => !e.passed);
    expect(bFail.some((e) => e.code === 'S01' && (e.penalty ?? 0) > 0)).toBe(true);
    expect(report.itemExplanations.b.every((e) => !e.passed)).toBe(true);
  });

  it('builds 4-dimension QualitySummary4D including clashes even when H01-H03 are off and deduplicating split hours', () => {
    const w = world()
      .only('O_LAB_G3', 'O_TH_G1')
      .place({ id: 'a', offering: 'O_LAB_G3', subgroup: 'G3A', day: 1, start: 1, duration: 3, room: 'LAB1' })
      .place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3B', day: 1, start: 1, duration: 3, room: 'R1' })
      .place({ id: 'c', offering: 'O_TH_G1', day: 1, start: 1, duration: 2, room: 'R1' }); // clashes with b in R1!
    w.ctx.profileName = 'competition';
    w.ctx.overrides = { H02: { mode: 'off' } };

    const report = evaluateSchedule(w.ctx);
    const summary = buildQualitySummary4D(w.ctx, report, { durationMs: 42, memoryMb: 12.5 });
    expect(summary.conflictDetection.roomClashes).toBe(2); // overlaps in periods 1 and 2
    expect(summary.conflictDetection.passed).toBe(false);
    expect(summary.scheduleCompleteness.requiredHours).toBe(5); // 3 (O_LAB_G3 split once) + 2 (O_TH_G1)
    expect(summary.scheduleCompleteness.scheduledHours).toBe(5);
    expect(summary.scheduleCompleteness.completenessPct).toBe(100);
    expect(summary.performance.durationMs).toBe(42);
    expect(summary.performance.memoryMb).toBe(12.5);
    expect(summary.passed).toBe(false);
  });
});

describe('Deterministic Thai XAI Formatting (messages.th.ts)', () => {
  it('formats real clock ranges from time_slots (e.g. 13:00-14:00 น.) and omits time if missing', () => {
    const w = world();
    expect(formatSlotTimeTh(1, 6, 1, w.ctx.timeSlots)).toBe('วันจันทร์ คาบ 6 (13:00–14:00 น.)');
    expect(formatSlotTimeTh(3, 1, 3, w.ctx.timeSlots)).toBe('วันพุธ คาบ 1–3 (08:00–11:00 น.)');
    expect(formatSlotTimeTh(2, 99, 1, w.ctx.timeSlots)).toBe('วันอังคาร คาบ 99');
  });

  it('provides both violation and pass templates for every H01-H21 and S01-S13 code', () => {
    for (const code of CONSTRAINT_CODES) {
      const hasPass = `${code}.pass` in MESSAGE_TEMPLATES_TH;
      const hasViolation = Object.keys(MESSAGE_TEMPLATES_TH).some((k) => k.startsWith(`${code}.`) && k !== `${code}.pass`);
      expect(hasPass, `missing ${code}.pass`).toBe(true);
      expect(hasViolation, `missing violation template for ${code}`).toBe(true);
      expect(renderMessageTh(`${code}.pass`)).toMatch(THAI);
    }
  });
});
