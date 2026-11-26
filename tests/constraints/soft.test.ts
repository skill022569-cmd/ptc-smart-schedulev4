import { describe, expect, it } from 'vitest';
import { ev, keysOf, makeItem, penaltyOf, world } from './fixtures';

describe('S01 STUDENT_GAPS', () => {
  it('passes when periods are contiguous or only separated by lunch break', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 3 })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 5, room: 'R2' }); // period 4 is ปวช. lunch
    expect(ev(w, 'S01')).toEqual([]);
  });

  it('penalises internal open gaps excluding lunch and supports allowedGaps param', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1 })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 6, room: 'R2' }); // gaps at periods 2, 3, 5 (4 is lunch) -> 3 gaps
    const v = ev(w, 'S01');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S01', severity: 3, resourceId: 'G1', day: 1 });
    expect(ev(w, 'S01', { params: { allowedGaps: 3 } })).toEqual([]);
  });

  it('deduplicates identical whole-group days across subgroups (G3A and G3B)', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G3', start: 1, duration: 1 })
      .place({ id: 'b', offering: 'O_TH_G3', start: 3, duration: 1, segment: 1 }); // gap at period 2
    const v = ev(w, 'S01');
    expect(v).toHaveLength(1);
    expect(penaltyOf(v)).toBe(1);
  });
});

describe('S02 SUBJECT_SPREAD', () => {
  it('passes when segments of the same offering are at least 2 days apart', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_MATH_G1', day: 1, start: 1, segment: 0 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 4, start: 1, segment: 1 });
    expect(ev(w, 'S02')).toEqual([]);
  });

  it('penalises same-day (1) and adjacent-day (0.5) segments', () => {
    const same = world()
      .place({ id: 'a', offering: 'O_MATH_G1', day: 1, start: 1, segment: 0 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 1, start: 3, segment: 1 });
    const sv = ev(same, 'S02');
    expect(keysOf(sv)).toEqual(['S02.same_day']);
    expect(penaltyOf(sv)).toBe(1);

    const adj = world()
      .place({ id: 'a', offering: 'O_MATH_G1', day: 1, start: 1, segment: 0 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 2, start: 1, segment: 1 });
    const av = ev(adj, 'S02');
    expect(keysOf(av)).toEqual(['S02.adjacent_day']);
    expect(penaltyOf(av)).toBe(0.5);
  });
});

describe('S03 TIME_PREFERENCE', () => {
  it('passes for `any` preference and for `morning`/`afternoon` placed in matching periods', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_PE_G2', start: 1, duration: 2 }) // SUB_PE has timePreference = 'morning' (1-4)
      .place({ id: 'b', offering: 'O_TH_G1', start: 7 }); // 'any'
    expect(ev(w, 'S03')).toEqual([]);
  });

  it('penalises per period placed outside preferred morning or afternoon range', () => {
    const w = world();
    w.subject('SUB_TH').timePreference = 'afternoon';
    w.place({ id: 'a', offering: 'O_PE_G2', start: 6, duration: 2 }) // morning subject placed in 6-7 -> 2
      .place({ id: 'b', offering: 'O_TH_G1', start: 3, duration: 2 }); // afternoon subject in 3-4 -> 2
    const v = ev(w, 'S03');
    expect(v).toHaveLength(2);
    expect(penaltyOf(v)).toBe(4);
  });
});

describe('S04 ROOM_BEST_FIT', () => {
  it('passes when capacity matches student count (or for allowMultiGroup rooms)', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', duration: 3 }) // 30 students in 30-seat LAB1
      .place({ id: 'b', offering: 'O_TH_G2', room: 'HALL', start: 3, duration: 2 }); // 20 students in multi-group HALL
    expect(ev(w, 'S04')).toEqual([]);
  });

  it('penalises wasted seat ratio multiplied by period duration', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G2', room: 'R1', duration: 2 }); // 20 in 40 seats = 0.5 * 2 = 1.0
    const v = ev(w, 'S04');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S04', severity: 1, resourceId: 'R1' });
    expect(ev(w, 'S04', { params: { toleranceRatio: 0.5 } })).toEqual([]);
  });
});

describe('S05 TEACHER_LUNCH', () => {
  it('passes when teacher has at least one free period in lunch window [4, 5]', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 3 })
      .place({ id: 'b', offering: 'O_TH_G2', start: 5, room: 'R2' }); // period 4 free
    expect(ev(w, 'S05')).toEqual([]);
  });

  it('fails when teacher teaches every open period in the lunch window on a day', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 4 })
      .place({ id: 'b', offering: 'O_TH_G2', start: 5, room: 'R2' });
    const v = ev(w, 'S05');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S05', resourceId: 'T1', day: 1, itemIds: ['a', 'b'] });
  });
});

describe('S06 TEACHER_LOAD', () => {
  it('passes when consecutive periods <= 4 and daily periods <= 6', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_TH_G2', start: 3, duration: 2, room: 'R2' })
      .place({ id: 'c', offering: 'O_TH_G3', start: 6, duration: 2, room: 'R3' }); // max streak 4, daily 6
    expect(ev(w, 'S06')).toEqual([]);
  });

  it('penalises exceeding soft consecutive cap (4) and daily cap (6)', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 3 })
      .place({ id: 'b', offering: 'O_TH_G2', start: 4, duration: 3, room: 'R2' })
      .place({ id: 'c', offering: 'O_TH_G3', start: 7, duration: 1, room: 'R3' }); // 7 consecutive (+3) and 7 daily (+1) = 4
    const v = ev(w, 'S06');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S06', resourceId: 'T1', severity: 4 });
  });
});

describe('S07 MIN_CHANGES', () => {
  it('passes with no baseline or when items match baseline day/start/room/teachers', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' });
    expect(ev(w, 'S07')).toEqual([]);
    w.ctx.baselineItems = [makeItem({ id: 'base_a', offering: 'O_TH_G1', start: 1, room: 'R1' })];
    w.ctx.baselineItemTeachers = [{ itemId: 'base_a', staffId: 'T1' }];
    expect(ev(w, 'S07')).toEqual([]); // matches by (offeringId, segmentIndex, subgroupId)
  });

  it('detects changed, added, and removed items relative to baseline', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', day: 2, start: 1, room: 'R1' }) // changed day
      .place({ id: 'n', offering: 'O_PE_G2', day: 1, start: 1, room: 'R2' }); // added
    w.ctx.baselineItems = [
      makeItem({ id: 'a', offering: 'O_TH_G1', day: 1, start: 1, room: 'R1' }),
      makeItem({ id: 'old', offering: 'O_MATH_G1', day: 1, start: 2, room: 'R2' }), // removed
    ];
    w.ctx.baselineItemTeachers = [
      { itemId: 'a', staffId: 'T1' },
      { itemId: 'old', staffId: 'T2' },
    ];
    const v = ev(w, 'S07');
    expect(keysOf(v)).toEqual(['S07.changed', 'S07.added', 'S07.removed']);
    expect(penaltyOf(v)).toBe(3);
  });
});

describe('S08 TEACHER_GAPS', () => {
  it('passes when teacher has contiguous blocks or only 1 lunch-window gap', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 3 })
      .place({ id: 'b', offering: 'O_TH_G2', start: 5, room: 'R2' }); // gap at 4 is free lunch allowance
    expect(ev(w, 'S08')).toEqual([]);
  });

  it('penalises extra idle periods in a teacher daily schedule', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1 })
      .place({ id: 'b', offering: 'O_TH_G2', start: 7, room: 'R2' }); // gaps 2,3,4,5,6 -> 5 gaps, 1 lunch allowance = 4
    const v = ev(w, 'S08');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S08', resourceId: 'T1', severity: 4 });
  });
});

describe('S09 THEORY_STREAK', () => {
  it('passes when theory-only streak is <= 2 or broken by practice/activity', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_LAB_G1', start: 3, duration: 1, room: 'LAB1' }); // LAB has practiceHours > 0
    expect(ev(w, 'S09')).toEqual([]);
  });

  it('penalises consecutive theory-only periods exceeding max (default 2)', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 3, duration: 1, room: 'R2' }); // 3 consecutive theory periods
    const v = ev(w, 'S09');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S09', severity: 1, resourceId: 'G1' });
    expect(ev(w, 'S09', { params: { max: 3 } })).toEqual([]);
  });
});

describe('S10 ROOM_CHANGES', () => {
  it('passes when all classes of a group on a day stay in the same room', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 2, room: 'R1' });
    expect(ev(w, 'S10')).toEqual([]);
  });

  it('counts room changes between successive classes on the same day', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 2, room: 'R2' })
      .place({ id: 'c', offering: 'O_LAB_G1', start: 3, room: 'LAB1', duration: 1 });
    const v = ev(w, 'S10');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S10', severity: 2, resourceId: 'G1' });
  });
});

describe('S11 CONTENT_SEQUENCE', () => {
  it('passes when earlier segment precedes later segment and prerequisite subject precedes dependent', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_MATH_G1', day: 1, start: 1, segment: 0 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 3, start: 1, segment: 1 })
      .place({ id: 'c', offering: 'O_TH_G1', day: 2, start: 1, duration: 2 });
    expect(ev(w, 'S11', { params: { sequences: [{ before: 'SUB_MATH', after: 'SUB_TH' }] } })).toEqual([]);
  });

  it('fails when segment order is inverted or prerequisite subject comes after dependent subject', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_MATH_G1', day: 4, start: 1, segment: 0 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 2, start: 1, segment: 1 }) // segment 1 before segment 0
      .place({ id: 'c', offering: 'O_TH_G1', day: 1, start: 1, duration: 2 }); // SUB_TH on Mon while SUB_MATH earliest is Tue
    const v = ev(w, 'S11', { params: { sequences: [['SUB_MATH', 'SUB_TH']] } });
    expect(keysOf(v)).toEqual(['S11.segment_order', 'S11.sequence']);
  });
});

describe('S12 DAY_SPAN', () => {
  it('passes when daily span stays within maxSpan (7) or matches needed contiguous + lunch periods', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 5, duration: 2, room: 'R2' }); // span 1..6 = 6 <= 7
    expect(ev(w, 'S12')).toEqual([]);
  });

  it('penalises unnecessary wide span exceeding maxSpan and needed periods', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 1 })
      .place({ id: 'b', offering: 'O_MATH_G1', start: 8, duration: 1, room: 'R2' }); // span=8, maxSpan=7, needed=3 -> excess 1
    const v = ev(w, 'S12');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S12', severity: 1, resourceId: 'G1' });
  });
});

describe('S13 GROUP_DAILY_BALANCE', () => {
  it('passes when active teaching days are evenly balanced around average', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', day: 1, start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 2, start: 1, duration: 1, segment: 0 })
      .place({ id: 'c', offering: 'O_MATH_G1', day: 2, start: 2, duration: 1, segment: 1 }); // Mon=2, Tue=2
    expect(ev(w, 'S13')).toEqual([]);
  });

  it('penalises uneven daily period loads across active days', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', day: 1, start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_LAB_G1', day: 1, start: 5, duration: 3, room: 'LAB1' }) // Mon = 5
      .place({ id: 'c', offering: 'O_MATH_G1', day: 2, start: 1, duration: 1 }); // Tue = 1 (avg 3, |5-3|+|3-1| = 4)
    const v = ev(w, 'S13');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'S13', severity: 4, resourceId: 'G1' });
    expect(ev(w, 'S13', { params: { tolerance: 2 } })).toEqual([]);
  });
});

describe('Soft-mode support for H05 and H09 (Competition Profile)', () => {
  it('H05 passes in soft mode for matching room and penalises mismatch as soft violation', () => {
    const ok = world().place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', duration: 3 });
    expect(ev(ok, 'H05', { mode: 'soft' })).toEqual([]);

    const bad = world().place({ id: 'a', offering: 'O_LAB_G1', room: 'R1', duration: 3 });
    const v = ev(bad, 'H05', { mode: 'soft' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'H05', mode: 'soft', messageKey: 'H05.violation' });
  });

  it('H09 passes in soft mode when contiguous and penalises split/non-contiguous as soft violation', () => {
    const ok = world().place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', start: 1, duration: 3 });
    expect(ev(ok, 'H09', { mode: 'soft' })).toEqual([]);

    const bad = world()
      .place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', start: 1, duration: 1 })
      .place({ id: 'b', offering: 'O_LAB_G1', room: 'LAB1', start: 3, duration: 2 });
    const v = ev(bad, 'H09', { mode: 'soft' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'H09', mode: 'soft', messageKey: 'H09.not_contiguous' });
  });
});
