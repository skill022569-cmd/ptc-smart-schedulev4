import { resolveConstraintConfigs, type ScheduleEvaluationContext } from '@ptc/shared';
import { buildScheduleTasks } from '../tasks';

export interface PlannerDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  messageTh: string;
  suggestions: string[];
}

export interface PlannerResult {
  feasible: boolean;
  taskCount: number;
  totalRequiredPeriods: number;
  diagnostics: PlannerDiagnostic[];
  recommendedAlgorithm: 'greedy' | 'csp_ga' | 'csp_sa';
}

/**
 * Planner Agent (Plan step of Plan-Act-Check):
 * Checks resource capacity, open slot budgets, eligible teachers, and lab supply
 * before invoking the Solver.
 */
export function runPlanner(ctx: ScheduleEvaluationContext): PlannerResult {
  const { configs } = resolveConstraintConfigs(ctx);
  const tasks = buildScheduleTasks(ctx, []);
  const diagnostics: PlannerDiagnostic[] = [];

  const termSlots = ctx.timeSlots.filter((s) => s.termId === ctx.term.id);
  const slots = termSlots.length > 0 ? termSlots : ctx.timeSlots;
  const openSlotCells = new Set<string>();
  for (const s of slots) for (const d of s.openDays) openSlotCells.add(`${d}:${s.period}`);

  // 1. Check missing eligible teachers or rooms
  let missingTeachers = 0;
  let missingRooms = 0;
  const groupPeriods = new Map<string, number>();

  for (const t of tasks) {
    if (t.eligibleTeachers.length === 0) missingTeachers++;
    const hasCapRoom = ctx.rooms.some((r) => {
      if (configs.H04.mode === 'hard' && r.capacity < t.studentCount) return false;
      if (configs.H05.mode === 'hard' && t.requiredRoomTypeId && r.roomTypeId !== t.requiredRoomTypeId) return false;
      return true;
    });
    if (!hasCapRoom) missingRooms++;
    for (const gid of t.audienceGroupIds) {
      if (!t.subgroupId || t.subgroupId.endsWith('A')) {
        groupPeriods.set(gid, (groupPeriods.get(gid) ?? 0) + t.duration);
      }
    }
  }

  if (missingTeachers > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'PLAN_NO_TEACHER',
      messageTh: `พบ ${missingTeachers} ชิ้นวิชาที่ไม่มีครูผู้สอนที่มีสิทธิ์ใน teach.csv`,
      suggestions: ['เพิ่มข้อมูลครูที่สอนได้ในตาราง teacher_subject_eligibility (teach.csv)'],
    });
  }
  if (missingRooms > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'PLAN_NO_ROOM',
      messageTh: `พบ ${missingRooms} ชิ้นวิชาที่ไม่มีห้องขนาดเพียงพอหรือประเภทห้องตรงตามเงื่อนไข`,
      suggestions: ['เพิ่มห้องเรียน/ปรับความจุ หรือเปลี่ยน H05 ROOM_TYPE เป็นโหมด Soft'],
    });
  }

  // 2. Check group open periods budget
  for (const g of ctx.studentGroups) {
    const req = groupPeriods.get(g.id) ?? 0;
    const allowedShifts = g.allowedShift === 'both' ? new Set(['day', 'evening']) : new Set([g.allowedShift ?? 'day']);
    let avail = 0;
    for (const s of slots) {
      if (!allowedShifts.has(s.shift)) continue;
      if (configs.H06.mode === 'hard' && s.period === g.lunchPeriod) continue;
      for (const d of s.openDays) {
        if (configs.H10.mode === 'hard' && !g.allowedDays.includes(d)) continue;
        avail++;
      }
    }
    if (req > avail) {
      diagnostics.push({
        severity: 'error',
        code: 'PLAN_GROUP_SLOTS_EXCEEDED',
        messageTh: `กลุ่ม ${g.groupCode} ต้องเรียน ${req} คาบ/สัปดาห์ แต่มีคาบว่างเปิดสอนเพียง ${avail} คาบ`,
        suggestions: ['เปิดช่วงเวลาภาคค่ำ/เสาร์-อาทิตย์ หรือลดรายวิชาลงทะเบียน'],
      });
    }
  }

  const totalRequiredPeriods = tasks.reduce((s, t) => s + t.duration, 0);
  const feasible = !diagnostics.some((d) => d.severity === 'error');
  if (feasible) {
    diagnostics.push({
      severity: 'info',
      code: 'PLAN_READY',
      messageTh: `ตรวจความพร้อมผ่าน: ${tasks.length} ชิ้นวิชา (${totalRequiredPeriods} คาบ) บน ${openSlotCells.size} สล็อตเวลา`,
      suggestions: [],
    });
  }

  return {
    feasible,
    taskCount: tasks.length,
    totalRequiredPeriods,
    diagnostics,
    recommendedAlgorithm: tasks.length > 200 ? 'csp_ga' : 'csp_ga',
  };
}
