import { describe, expect, it } from 'vitest';
import { computeOfferingHours, EvaluationIndex } from '../../packages/shared/src';
import { ev, keysOf, penaltyOf, world } from './fixtures';

describe('H01 TEACHER_CLASH', () => {
  it('passes when a teacher teaches consecutive periods', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 1 }).place({ id: 'b', offering: 'O_TH_G2', start: 2, room: 'R2' });
    expect(ev(w, 'H01')).toEqual([]);
  });

  it('fails when one teacher has two items in the same cell', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 }).place({ id: 'b', offering: 'O_TH_G2', start: 2, room: 'R2' });
    const v = ev(w, 'H01');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'H01', name: 'TEACHER_CLASH', mode: 'hard', itemIds: ['a', 'b'], resourceId: 'T1', day: 1, period: 2 });
    expect(v[0]!.messageTh).toContain('ครูหนึ่ง');
    expect(v[0]!.messageTh).toContain('วันจันทร์ คาบ 2');
  });
});

describe('H02 ROOM_CLASH', () => {
  it('passes for different rooms and for multi-group rooms', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', room: 'R1' }).place({ id: 'b', offering: 'O_PE_G2', room: 'R2' });
    expect(ev(w, 'H02')).toEqual([]);
    const shared = world().place({ id: 'a', offering: 'O_TH_G1', room: 'HALL' }).place({ id: 'b', offering: 'O_PE_G2', room: 'HALL' });
    expect(ev(shared, 'H02')).toEqual([]);
  });

  it('fails when an exclusive room hosts two items at once', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', room: 'R1' }).place({ id: 'b', offering: 'O_PE_G2', room: 'R1' });
    const v = ev(w, 'H02');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ resourceType: 'room', resourceId: 'R1', itemIds: ['a', 'b'] });
  });
});

describe('H03 GROUP_CLASH', () => {
  it('passes for parallel subgroup A / B items of a split offering', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1', duration: 3 })
      .place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3B', room: 'R3', duration: 3 });
    expect(ev(w, 'H03')).toEqual([]);
  });

  it('fails when a whole-group item overlaps a subgroup item (reported on that subgroup)', () => {
    const w = world()
      .place({ id: 'w', offering: 'O_TH_G3', room: 'R1' })
      .place({ id: 'a', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1' });
    const v = ev(w, 'H03');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ resourceType: 'subgroup', resourceId: 'G3A', itemIds: ['a', 'w'] });
    expect(v[0]!.messageTh).toContain('IT1/2 กลุ่มย่อย A');
  });

  it('reports a whole-group clash once per group, not once per subgroup', () => {
    const w = world().place({ id: 'x', offering: 'O_TH_G3', room: 'R1' }).place({ id: 'y', offering: 'O_TH_G3', room: 'R2', segment: 1 });
    const v = ev(w, 'H03');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ resourceType: 'group', resourceId: 'G3' });
    const plain = world().place({ id: 'a', offering: 'O_TH_G1', room: 'R1' }).place({ id: 'b', offering: 'O_MATH_G1', room: 'R2' });
    expect(ev(plain, 'H03')).toHaveLength(1);
  });
});

describe('H04 ROOM_CAPACITY', () => {
  it('passes when students fit (group or subgroup size)', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', room: 'R1' }).place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1', start: 3 });
    expect(ev(w, 'H04')).toEqual([]);
  });

  it('fails for combined groups exceeding capacity (30 + 20 > 40)', () => {
    const v = ev(world().place({ id: 'a', offering: 'O_COMB', room: 'R1' }), 'H04');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ messageKey: 'H04.violation', params: { students: 50, capacity: 40 } });
  });

  it('sums concurrent students of all items in a multi-group room', () => {
    const ok = world().place({ id: 'a', offering: 'O_TH_G1', room: 'HALL' });
    expect(ev(ok, 'H04')).toEqual([]);
    const over = world().place({ id: 'a', offering: 'O_TH_G1', room: 'HALL' }).place({ id: 'b', offering: 'O_PE_G2', room: 'HALL' });
    const v = ev(over, 'H04');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ messageKey: 'H04.shared', itemIds: ['a', 'b'], params: { students: 50, count: 2 } });
  });
});

describe('H05 ROOM_TYPE', () => {
  it('passes when the room type matches the offering room type', () => {
    expect(ev(world().place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', duration: 3 }), 'H05')).toEqual([]);
    expect(ev(world().place({ id: 'a', offering: 'O_TH_G1', room: 'LAB1' }), 'H05')).toEqual([]); // no requirement
  });

  it('fails for a wrong room type or a missing room', () => {
    expect(keysOf(ev(world().place({ id: 'a', offering: 'O_LAB_G1', room: 'R1', duration: 3 }), 'H05'))).toEqual(['H05.violation']);
    expect(keysOf(ev(world().place({ id: 'a', offering: 'O_LAB_G1', room: null, duration: 3 }), 'H05'))).toEqual(['H05.no_room']);
  });

  it('supports soft mode and compatibleTypes params', () => {
    const w = world().place({ id: 'a', offering: 'O_LAB_G1', room: 'R1', duration: 3 });
    expect(ev(w, 'H05', { mode: 'soft' })[0]!.mode).toBe('soft');
    expect(ev(w, 'H05', { params: { compatibleTypes: { lab_com: ['theory'] } } })).toEqual([]);
  });
});

describe('H06 LUNCH_BREAK', () => {
  it('passes outside the lunch period of each level (ปวช. 4, ปวส. 5)', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 3 }).place({ id: 'b', offering: 'O_TH_G2', start: 4, room: 'R2', teachers: ['T2'] });
    expect(ev(w, 'H06')).toEqual([]);
  });

  it('fails on the lunch period (combined group checked per group)', () => {
    expect(ev(world().place({ id: 'a', offering: 'O_TH_G1', start: 4 }), 'H06')).toHaveLength(1);
    const v = ev(world().place({ id: 'c', offering: 'O_COMB', start: 4, duration: 2, room: 'HALL' }), 'H06');
    expect(v.map((x) => [x.resourceId, x.period])).toEqual([
      ['G1', 4],
      ['G2', 5],
    ]);
  });
});

describe('H07 AVAILABILITY', () => {
  it('passes for open slots with available teachers and rooms', () => {
    const w = world();
    w.staff('T2').availableSlots = [{ day: 1, period: 1 }];
    w.place({ id: 'a', offering: 'O_MATH_G1', day: 1, start: 1 });
    expect(ev(w, 'H07')).toEqual([]);
  });

  it('fails for teacher unavailability, whitelist misses and room outages', () => {
    const w = world();
    w.staff('T1').unavailableSlots = [{ day: 1, period: 2 }];
    w.staff('T2').availableSlots = [{ day: 1, period: 1 }];
    w.room('R2').unavailableSlots = [{ day: 2, period: 3 }];
    w.place({ id: 'a', offering: 'O_TH_G1', day: 1, start: 1, duration: 2 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 1, start: 3 })
      .place({ id: 'c', offering: 'O_TH_G2', day: 2, start: 3, room: 'R2', teachers: ['T3'] });
    const v = ev(w, 'H07');
    expect(keysOf(v)).toEqual(['H07.teacher', 'H07.teacher', 'H07.room']);
    expect(v[0]).toMatchObject({ resourceId: 'T1', severity: 1, params: { periods: '2' } });
  });

  it('fails for slots outside time_slots / openDays', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', day: 6 }).place({ id: 'b', offering: 'O_TH_G2', start: 9, room: 'R2' });
    expect(keysOf(ev(w, 'H07'))).toEqual(['H07.slot_invalid', 'H07.slot_invalid']);
  });
});

describe('H08 FIXED_BLOCK', () => {
  it('passes next to the block and for elective sections inside elective blocks', () => {
    const w = world().fixedBlock({ id: 'FB1', dayOfWeek: 3, startPeriod: 7, duration: 2 }).place({ id: 'a', offering: 'O_TH_G1', day: 3, start: 6 });
    expect(ev(w, 'H08')).toEqual([]);
    const el = world()
      .fixedBlock({ id: 'FB2', dayOfWeek: 2, startPeriod: 1, duration: 2, blockType: 'elective_block' })
      .place({ id: 'e', offering: 'O_EL', day: 2, start: 1 });
    expect(ev(el, 'H08')).toEqual([]);
  });

  it('fails when an item overlaps a block applying to its group, teacher or room', () => {
    const w = world()
      .fixedBlock({ id: 'FB1', dayOfWeek: 3, startPeriod: 7, duration: 2 })
      .fixedBlock({ id: 'FB2', dayOfWeek: 2, startPeriod: 1, duration: 2, appliesTo: { staffIds: ['T2'] } })
      .fixedBlock({ id: 'FB3', dayOfWeek: 1, startPeriod: 1, duration: 1, appliesTo: { levels: ['ปวส.'] } })
      .fixedBlock({ id: 'FB4', dayOfWeek: 4, startPeriod: 1, duration: 1, roomId: 'R2', appliesTo: {} })
      .place({ id: 'a', offering: 'O_TH_G1', day: 3, start: 6, duration: 2 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 2, start: 2 })
      .place({ id: 'c', offering: 'O_TH_G1', day: 1, start: 1, segment: 1 }) // ปวช. group → not blocked by FB3
      .place({ id: 'd', offering: 'O_TH_G2', day: 1, start: 1, room: 'R3' })
      .place({ id: 'e', offering: 'O_TH_G2', day: 4, start: 1, room: 'R2', segment: 1 });
    const v = ev(w, 'H08');
    expect(v.map((x) => x.itemIds[0])).toEqual(['a', 'b', 'd', 'e']);
    expect(v[1]!.params.target).toBe('ครู ครูสอง');
  });
});

describe('H09 CONSECUTIVE', () => {
  it('passes for a 3-period consecutive block before lunch and contiguous pieces', () => {
    expect(ev(world().place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', start: 1, duration: 3 }), 'H09')).toEqual([]);
    const pieces = world()
      .place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', start: 1, duration: 1 })
      .place({ id: 'b', offering: 'O_LAB_G1', room: 'LAB1', start: 2, duration: 2 });
    expect(ev(pieces, 'H09')).toEqual([]);
  });

  it('fails when crossing lunch, running past the last period, or crossing shifts', () => {
    expect(keysOf(ev(world().place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', start: 3, duration: 3 }), 'H09'))).toEqual(['H09.cross_lunch']);
    expect(keysOf(ev(world().place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', start: 7, duration: 3 }), 'H09'))).toEqual(['H09.out_of_day']);
    const shift = keysOf(ev(world().place({ id: 'a', offering: 'O_TH_G2', start: 8, duration: 3 }), 'H09'));
    expect(shift).toContain('H09.cross_shift');
  });

  it('fails when pieces of a consecutive segment are split across days; supports soft mode', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_LAB_G1', room: 'LAB1', day: 1, start: 1, duration: 1 })
      .place({ id: 'b', offering: 'O_LAB_G1', room: 'LAB1', day: 2, start: 1, duration: 2 });
    const v = ev(w, 'H09', { mode: 'soft' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ messageKey: 'H09.not_contiguous', mode: 'soft', itemIds: ['a', 'b'] });
  });
});

describe('H10 ALLOWED_DAYS', () => {
  it('passes on allowed days and shifts', () => {
    const w = world();
    w.group('G1').allowedDays = [1, 2, 3, 4];
    w.place({ id: 'a', offering: 'O_TH_G1', day: 4 }).place({ id: 'b', offering: 'O_TH_G2', day: 4, start: 10, room: 'R2' });
    expect(ev(w, 'H10')).toEqual([]);
  });

  it('fails on a disallowed day or shift', () => {
    const w = world();
    w.group('G1').allowedDays = [1, 2, 3, 4];
    w.place({ id: 'a', offering: 'O_TH_G1', day: 5 }).place({ id: 'b', offering: 'O_MATH_G1', day: 2, start: 10 });
    expect(keysOf(ev(w, 'H10'))).toEqual(['H10.day', 'H10.shift']);
  });
});

describe('H11 TEAM_TEACHING', () => {
  it('passes when every team teacher (and the subgroup teacher) is assigned', () => {
    expect(ev(world().place({ id: 'a', offering: 'O_TEAM', teachers: ['T2', 'T4'] }), 'H11')).toEqual([]);
    expect(ev(world().place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1' }), 'H11')).toEqual([]);
  });

  it('fails when a team teacher is missing', () => {
    const v = ev(world().place({ id: 'a', offering: 'O_TEAM', teachers: ['T2'] }), 'H11');
    expect(v).toHaveLength(1);
    expect(v[0]!.params).toMatchObject({ missing: 'ครูสี่', required: 2, assigned: 1 });
    expect(ev(world().place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1', teachers: ['T4'] }), 'H11')).toHaveLength(1);
  });
});

describe('H12 BUILDING_GAP', () => {
  it('passes with one free period between buildings (default gap 1)', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' }).place({ id: 'b', offering: 'O_TH_G2', start: 3, room: 'R3' });
    expect(ev(w, 'H12')).toEqual([]);
  });

  it('fails for back-to-back classes in different buildings (teacher or group)', () => {
    const teacher = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' }).place({ id: 'b', offering: 'O_TH_G2', start: 2, room: 'R3' });
    const v = ev(teacher, 'H12');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ resourceType: 'teacher', resourceId: 'T1', itemIds: ['a', 'b'] });
    const grp = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' }).place({ id: 'b', offering: 'O_MATH_G1', start: 2, room: 'R3' });
    expect(ev(grp, 'H12').map((x) => x.resourceType)).toEqual(['group']);
    const wider = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, room: 'R1' }).place({ id: 'b', offering: 'O_TH_G2', start: 3, room: 'R3' });
    expect(ev(wider, 'H12', { params: { gap: 2 } })).toHaveLength(1);
  });
});

describe('H13 TEACHER_DAILY_MAX', () => {
  it('passes within staff.maxDailyPeriods or a profile max', () => {
    const w = world();
    w.staff('T1').maxDailyPeriods = 2;
    w.place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 });
    expect(ev(w, 'H13')).toEqual([]);
    w.place({ id: 'b', offering: 'O_TH_G2', start: 5, room: 'R2' });
    expect(ev(w, 'H13', { params: { max: 3 } })).toEqual([]);
  });

  it('fails above the daily maximum', () => {
    const w = world();
    w.staff('T1').maxDailyPeriods = 2;
    w.place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 }).place({ id: 'b', offering: 'O_TH_G2', start: 5, room: 'R2' });
    const v = ev(w, 'H13');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 1, params: { count: 3, max: 2 } });
  });
});

describe('H14 TEACHER_CONSECUTIVE', () => {
  it('passes for runs ≤ staff.maxConsecutive (3)', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 }).place({ id: 'b', offering: 'O_TH_G2', start: 5, duration: 2, room: 'R2' });
    expect(ev(w, 'H14')).toEqual([]);
  });

  it('fails for 4 consecutive periods (unless params raise the cap)', () => {
    const w = world().place({ id: 'a', offering: 'O_TH_G1', start: 1, duration: 2 }).place({ id: 'b', offering: 'O_TH_G2', start: 3, duration: 2, room: 'R2' });
    const v = ev(w, 'H14');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 1, itemIds: ['a', 'b'], params: { count: 4, max: 3 } });
    expect(ev(w, 'H14', { params: { maxConsecutive: 4 } })).toEqual([]);
  });
});

describe('H15 DAY_OFF', () => {
  it('passes on working days', () => {
    const w = world();
    w.staff('T2').dayOff = 5;
    expect(ev(w.place({ id: 'a', offering: 'O_MATH_G1', day: 4 }), 'H15')).toEqual([]);
  });

  it('fails on the teacher day off', () => {
    const w = world();
    w.staff('T2').dayOff = 5;
    const v = ev(w.place({ id: 'a', offering: 'O_MATH_G1', day: 5 }), 'H15');
    expect(v).toHaveLength(1);
    expect(v[0]!.messageTh).toContain('ศุกร์');
  });
});

describe('H16 EVENING_AFTER_DAY', () => {
  const both = (days: number[]) => {
    const w = world();
    for (const d of days) {
      w.place({ id: `d${d}`, offering: 'O_TH_G2', day: d, start: 1 }).place({ id: `e${d}`, offering: 'O_TH_G2', day: d, start: 10, segment: 1 });
    }
    return w;
  };

  it('passes for ≤ 2 day+evening days', () => {
    expect(ev(both([1, 2]), 'H16')).toEqual([]);
  });

  it('fails for 3 day+evening days', () => {
    const v = ev(both([1, 2, 3]), 'H16');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 1, params: { count: 3, max: 2 } });
    expect(ev(both([1, 2, 3]), 'H16', { params: { maxDays: 3 } })).toEqual([]);
  });
});

describe('H17 ELECTIVE_CLASH', () => {
  const enrolled = () => {
    const w = world();
    w.ctx.electiveEnrollments.push(
      { studentId: 'ST1', termId: 'term1', subjectId: 'SUB_EL', offeringId: 'O_EL' },
      { studentId: 'ST2', termId: 'term1', subjectId: 'SUB_EL', offeringId: 'O_EL' },
    );
    return w.place({ id: 'el', offering: 'O_EL', day: 1, start: 1, room: 'R2' });
  };

  it('passes when compulsory classes are at other times or belong to another subgroup', () => {
    const w = enrolled().place({ id: 'c', offering: 'O_TH_G1', start: 2 }).place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3B', room: 'LAB1' });
    expect(ev(w, 'H17')).toEqual([]);
  });

  it('fails when an enrolled elective overlaps the student group or subgroup class', () => {
    const w = enrolled().place({ id: 'c', offering: 'O_TH_G1', start: 1 }).place({ id: 'a', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1' });
    const v = ev(w, 'H17');
    expect(v.map((x) => x.itemIds)).toEqual([
      ['el', 'c'],
      ['el', 'a'],
    ]);
    expect(v[0]!.params.students).toBe(1);
  });
});

describe('H18 REGISTERED_ONLY', () => {
  it('passes for offerings registered in the term with groups', () => {
    expect(ev(world().place({ id: 'a', offering: 'O_TH_G1' }), 'H18')).toEqual([]);
  });

  it('fails for unknown offerings, other terms, offerings without groups and foreign subgroups', () => {
    const w = world()
      .offering({ id: 'O_OLD', subject: 'SUB_TH', groups: ['G1'], ppw: 2, termId: 'term0' })
      .offering({ id: 'O_NOG', subject: 'SUB_TH', groups: [], ppw: 2 })
      .place({ id: 'a', offering: 'NOPE', status: 'unplaced_tray', day: null, start: null })
      .place({ id: 'b', offering: 'O_OLD' })
      .place({ id: 'c', offering: 'O_NOG' })
      .place({ id: 'd', offering: 'O_TH_G1', subgroup: 'G3A' });
    expect(keysOf(ev(w, 'H18'))).toEqual(['H18.unknown_offering', 'H18.wrong_term', 'H18.no_group', 'H18.subgroup_mismatch']);
  });
});

describe('H19 ELIGIBLE_TEACHER', () => {
  it('passes for eligible or listed teachers (group-scoped eligibility included)', () => {
    expect(ev(world().place({ id: 'a', offering: 'O_TH_G1' }), 'H19')).toEqual([]);
    const scoped = world().offering({ id: 'O_MATH_G2', subject: 'SUB_MATH', groups: ['G2'], ppw: 2, teachers: ['T2'] });
    expect(ev(scoped.place({ id: 'b', offering: 'O_MATH_G2', teachers: ['T4'] }), 'H19')).toEqual([]);
    expect(ev(world().place({ id: 'c', offering: 'O_PE_G2', teachers: [] }), 'H19')).toEqual([]); // activity
  });

  it('fails for ineligible teachers, out-of-scope groups and missing teachers', () => {
    const w = world()
      .place({ id: 'a', offering: 'O_TH_G1', teachers: ['T3'] })
      .place({ id: 'b', offering: 'O_MATH_G1', teachers: ['T4'], start: 2 })
      .place({ id: 'c', offering: 'O_TH_G2', teachers: [], start: 3 });
    expect(keysOf(ev(w, 'H19'))).toEqual(['H19.violation', 'H19.violation', 'H19.no_teacher']);
  });
});

describe('H20 HOURS_COMPLETE', () => {
  it('passes when every offering reaches periodsPerWeek', () => {
    const w = world().only('O_TH_G1', 'O_MATH_G1');
    w.place({ id: 'a', offering: 'O_TH_G1', duration: 2 })
      .place({ id: 'b', offering: 'O_MATH_G1', day: 2 })
      .place({ id: 'c', offering: 'O_MATH_G1', day: 3, segment: 1 });
    expect(ev(w, 'H20')).toEqual([]);
  });

  it('counts split A/B subgroups once per offering (3 + 3 ≠ 6)', () => {
    const w = world().only('O_LAB_G3');
    w.place({ id: 'a', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1', duration: 3 })
      .place({ id: 'b', offering: 'O_LAB_G3', subgroup: 'G3B', room: 'R3', duration: 3 });
    expect(ev(w, 'H20')).toEqual([]);
    const hours = computeOfferingHours(new EvaluationIndex(w.ctx));
    expect(hours[0]).toMatchObject({ required: 3, scheduled: 3, complete: true });
    expect(hours[0]!.tracks.map((t) => t.periods)).toEqual([3, 3]);
  });

  it('fails for a missing subgroup half, unplaced items, short, excess or invalid slots', () => {
    const half = world().only('O_LAB_G3').place({ id: 'a', offering: 'O_LAB_G3', subgroup: 'G3A', room: 'LAB1', duration: 3 });
    const v = ev(half, 'H20');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ messageKey: 'H20.incomplete', params: { scheduled: 0, required: 3 } });

    const tray = world().only('O_TH_G1').place({ id: 'a', offering: 'O_TH_G1', duration: 2, status: 'unplaced_tray', day: null, start: null });
    expect(keysOf(ev(tray, 'H20'))).toEqual(['H20.unplaced', 'H20.incomplete']);

    const short = world().only('O_TH_G1').place({ id: 'a', offering: 'O_TH_G1', duration: 1 });
    expect(penaltyOf(ev(short, 'H20'))).toBe(1);

    const excess = world().only('O_TH_G1').place({ id: 'a', offering: 'O_TH_G1', duration: 2 }).place({ id: 'b', offering: 'O_TH_G1', day: 2, duration: 2 });
    expect(keysOf(ev(excess, 'H20'))).toEqual(['H20.excess']);

    const invalid = world().only('O_TH_G1').place({ id: 'a', offering: 'O_TH_G1', day: 6, duration: 2 });
    expect(keysOf(ev(invalid, 'H20'))).toEqual(['H20.invalid_slot', 'H20.incomplete']);
  });
});

describe('H21 GROUP_AVAILABILITY', () => {
  it('passes when the group is available', () => {
    const w = world();
    w.group('G1').unavailableSlots = [{ day: 5, period: 1 }];
    expect(ev(w.place({ id: 'a', offering: 'O_TH_G1', day: 5, start: 2 }), 'H21')).toEqual([]);
  });

  it('fails on group-unavailable or closed slots', () => {
    const w = world();
    w.group('G1').unavailableSlots = [{ day: 5, period: 1 }];
    w.place({ id: 'a', offering: 'O_TH_G1', day: 5, start: 1 }).place({ id: 'b', offering: 'O_TH_G2', day: 7, start: 1 });
    expect(keysOf(ev(w, 'H21'))).toEqual(['H21.violation', 'H21.slot_invalid']);
  });
});
