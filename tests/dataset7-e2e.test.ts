/**
 * End-to-end check against the official competition dataset format
 * (ไฟล์ชุดข้อมูล (Data set) ตัวอย่าง): 7 CSV in -> solver -> output.csv out,
 * then verify the 8 scheduling rules of the sample dataset on the exported file.
 */
import { describe, expect, it } from 'vitest';
import { createEvaluationContext } from '../packages/shared/src';
import { runAgenticPipeline } from '../apps/server/src/engine';
import { parseDataset7 } from '../apps/server/src/services/import/dataset7';
import { validateDataset7 } from '../apps/server/src/services/import/validator';
import { buildDataset7Tables } from '../apps/server/src/services/import/to-tables';
import { exportCompetitionOutputCsv } from '../apps/server/src/services/export/csv';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
let timeslot = 'timeslot_id,day,period,start,end\n';
let id = 1;
for (const d of DAYS) {
  for (let p = 1; p <= 12; p++) {
    const h = 7 + p;
    timeslot += `${id++},${d},${p},${String(h).padStart(2, '0')}:00,${String(h + 1).padStart(2, '0')}:00\n`;
  }
}

// subject: theory+practice periods (sample file uses 3, 5 and 4-period subjects)
const SUBJECTS: [string, string, number, number][] = [
  ['30000-1501', 'ภาษาไทยเพื่อการสื่อสาร', 3, 0],
  ['30000-1201', 'ภาษาอังกฤษเพื่อการสื่อสาร', 2, 0],
  ['30000-1401', 'คณิตศาสตร์', 3, 0],
  ['31901-2002', 'การเขียนโปรแกรม', 1, 4],
  ['31901-2006', 'ระบบฐานข้อมูล', 0, 4],
  ['31901-2101', 'ปัญญาประดิษฐ์เบื้องต้น', 2, 2],
  ['31901-2102', 'การเรียนรู้ของเครื่อง', 1, 4],
];
const files = {
  timeslot,
  student_group:
    'group_id,group_name,student_count,advisor\n' +
    ['G1', 'G2', 'G3', 'G4'].map((g, i) => `${g},กลุ่ม ${g},${25 + i},T0${i + 1}`).join('\n'),
  subject:
    'subject_id,subject_name,theory,practice,credit\n' +
    SUBJECTS.map(([c, n, t, p]) => `${c},${n},${t},${p},${t + Math.ceil(p / 2)}`).join('\n'),
  teacher: 'teacher_id,teacher_name\n' + Array.from({ length: 8 }, (_, i) => `T0${i + 1},ครู ${i + 1}`).join('\n'),
  teach:
    'teacher_id,subject_id\n' +
    [
      'T01,31901-2002', 'T02,30000-1501', 'T03,31901-2006', 'T04,30000-1201', 'T05,30000-1401',
      'T06,31901-2101', 'T07,31901-2102', 'T08,31901-2002', 'T08,31901-2006', 'T02,30000-1201',
    ].join('\n'),
  room: 'room_id,room_name\n5306,ห้อง 5306\n6204,ห้องคอม 6204\n6405,ห้องคอม 6405\n6406,ห้องคอม 6406\n',
  register:
    'group_id,subject_id\n' +
    ['G1', 'G2', 'G3', 'G4'].flatMap((g) => SUBJECTS.map(([c]) => `${g},${c}`)).join('\n'),
};

function parseCsv(text: string) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head!.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i]!, v])));
}

describe('Official 7-CSV dataset -> output.csv', () => {
  const bundle = parseDataset7(files);
  const validation = validateDataset7(bundle);

  it('accepts the official file layout (room.csv without capacity, timeslot_id kept)', () => {
    expect(validation.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(bundle.timeslots[0]?.slotId).toBe('1');
  });

  it('produces output.csv that satisfies all 8 rules of the sample dataset', () => {
    const t = buildDataset7Tables(bundle, 'e2e');
    const ctx = createEvaluationContext(
      {
        terms: [t.term],
        time_slots: t.timeSlots,
        departments: t.departments,
        buildings: t.buildings,
        room_types: t.roomTypes,
        rooms: t.rooms,
        staff: t.staff,
        student_groups: t.studentGroups,
        subjects: t.subjects,
        course_offerings: t.offerings,
        offering_groups: t.offeringGroups,
        offering_teachers: t.offeringTeachers,
        teacher_subject_eligibility: t.eligibilities,
        constraint_configs: [],
      },
      { profileName: 'competition' },
    );
    const res = runAgenticPipeline({ ctx, algorithm: 'csp_ga', seed: 2026, maxIterations: 10, timeLimitSec: 30, versionId: 'ver:e2e' });
    expect(res.report.hardCount).toBe(0);
    expect(res.qualitySummary.scheduleCompleteness.unplacedCount).toBe(0);

    const csv = exportCompetitionOutputCsv({ ...ctx, items: res.items, itemTeachers: res.itemTeachers }, t.timeslotIds).toString('utf8');
    expect(csv.split('\n')[0]).toBe('group_id,timeslot_id,day,period,subject_id,teacher_id,room_id');
    const rows = parseCsv(csv);
    const periodsOf = new Map(SUBJECTS.map(([c, , th, pr]) => [c, th + pr]));
    const teachable = new Set(files.teach.split('\n').slice(1));

    for (const g of ['G1', 'G2', 'G3', 'G4']) {
      const mine = rows.filter((r) => r.group_id === g);
      // 1 & 3: every registered subject, with exactly theory+practice periods
      for (const [code, n] of periodsOf) expect(mine.filter((r) => r.subject_id === code).length, `${g} ${code}`).toBe(n);
      expect(new Set(mine.map((r) => r.subject_id)).size).toBe(SUBJECTS.length);
      // 4: total periods
      expect(mine.length).toBe([...periodsOf.values()].reduce((a, b) => a + b, 0));
      // 5: at most 10 periods per day
      for (const d of DAYS) expect(mine.filter((r) => r.day === d).length).toBeLessThanOrEqual(10);
    }
    // 2: period 5 is the break
    expect(rows.filter((r) => r.period === '5')).toEqual([]);
    // timeslot_id matches the imported timeslot.csv
    for (const r of rows) expect(r.timeslot_id).toBe(String(DAYS.indexOf(r.day!) * 12 + Number(r.period)));
    // 6 & 7: no teacher or room double-booked in the same timeslot
    const seen = new Set<string>();
    for (const r of rows) {
      for (const k of [`T|${r.teacher_id}|${r.timeslot_id}`, `R|${r.room_id}|${r.timeslot_id}`]) {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
    }
    // 8: teacher only teaches subjects listed in teach.csv
    for (const r of rows) expect(teachable.has(`${r.teacher_id},${r.subject_id}`), `${r.teacher_id},${r.subject_id}`).toBe(true);
  });
});
