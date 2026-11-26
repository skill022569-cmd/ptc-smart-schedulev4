/**
 * Constraint Catalog (H01–H21, S01–S13) + built-in profile presets.
 *
 * Every code is configurable (`hard | soft | off`, weight, JSON params) because
 * scenarios may conflict (e.g. Q09 caps teacher consecutive periods at 3 as Hard
 * while Core 1.3 allows 4 as Soft).
 */
import {
  HARD_CONSTRAINT_NAMES,
  SOFT_CONSTRAINT_NAMES,
  type ConstraintCode,
  type ConstraintConfig,
  type ConstraintMode,
  type HardConstraintCode,
  type JsonObject,
  type SoftConstraintCode,
} from '../types';
import type {
  BuiltInProfileName,
  ConstraintCatalogEntry,
  ConstraintCategory,
  ResolvedConstraintConfigMap,
  ScheduleEvaluationContext,
} from './types';

export const HARD_CONSTRAINT_CODES = Object.keys(HARD_CONSTRAINT_NAMES) as HardConstraintCode[];
export const SOFT_CONSTRAINT_CODES = Object.keys(SOFT_CONSTRAINT_NAMES) as SoftConstraintCode[];
export const CONSTRAINT_CODES: ConstraintCode[] = [...HARD_CONSTRAINT_CODES, ...SOFT_CONSTRAINT_CODES];

export function isConstraintCode(code: string): code is ConstraintCode {
  return Object.prototype.hasOwnProperty.call(HARD_CONSTRAINT_NAMES, code) || Object.prototype.hasOwnProperty.call(SOFT_CONSTRAINT_NAMES, code);
}

export function isHardCode(code: ConstraintCode): code is HardConstraintCode {
  return code.startsWith('H');
}

interface EntrySpec {
  nameTh: string;
  descriptionTh: string;
  category: ConstraintCategory;
  defaultWeight: number;
  defaultParams?: JsonObject;
  supportsSoftMode?: boolean;
}

const HARD_SPECS: Record<HardConstraintCode, EntrySpec> = {
  H01: { nameTh: 'ครูสอนซ้อน', descriptionTh: 'ครู 1 คนสอนได้ไม่เกิน 1 รายการในคาบเดียวกัน', category: 'clash', defaultWeight: 100, supportsSoftMode: false },
  H02: { nameTh: 'ห้องเรียนซ้อน', descriptionTh: 'ห้องที่ไม่อนุญาตหลายกลุ่มใช้ได้ไม่เกิน 1 รายการในคาบเดียวกัน', category: 'clash', defaultWeight: 100, supportsSoftMode: false },
  H03: { nameTh: 'กลุ่มเรียนซ้อน', descriptionTh: 'กลุ่มเรียน/กลุ่มย่อยเรียนได้ไม่เกิน 1 รายการในคาบเดียวกัน', category: 'clash', defaultWeight: 100, supportsSoftMode: false },
  H04: { nameTh: 'ความจุห้องเรียน', descriptionTh: 'จำนวนผู้เรียนต้องไม่เกินความจุของห้อง', category: 'room', defaultWeight: 10 },
  H05: { nameTh: 'ประเภทห้องตรงกับรายวิชา', descriptionTh: 'รายวิชาที่กำหนดประเภทห้องต้องจัดในห้องประเภทนั้น', category: 'room', defaultWeight: 6, defaultParams: { compatibleTypes: {} } },
  H06: { nameTh: 'คาบพักกลางวัน', descriptionTh: 'คาบพักกลางวันของกลุ่มเรียนต้องว่าง (ปวช. คาบ 4, ปวส. คาบ 5)', category: 'time', defaultWeight: 10, defaultParams: { lunchPeriodByLevel: { 'ปวช.': 4, 'ปวส.': 5 } } },
  H07: { nameTh: 'ช่วงเวลาที่ครูและห้องว่าง', descriptionTh: 'จัดเฉพาะคาบที่เปิดสอนและครู/ห้องว่าง', category: 'time', defaultWeight: 10 },
  H08: { nameTh: 'คาบกิจกรรม/คาบล็อก', descriptionTh: 'ห้ามจัดทับคาบกิจกรรมหรือคาบที่ล็อกไว้', category: 'time', defaultWeight: 10 },
  H09: { nameTh: 'เรียนต่อเนื่อง', descriptionTh: 'คาบที่ต้องเรียนต่อเนื่องต้องอยู่วันเดียวกัน ติดกัน และไม่คร่อมพักกลางวัน', category: 'curriculum', defaultWeight: 8 },
  H10: { nameTh: 'วันและช่วงเวลาที่กลุ่มเรียนได้', descriptionTh: 'จัดเฉพาะวันที่กลุ่มเรียนได้และภาค (ปกติ/ค่ำ) ที่ตรงกัน', category: 'student', defaultWeight: 10 },
  H11: { nameTh: 'สอนร่วม (Team Teaching)', descriptionTh: 'ครูผู้สอนร่วมทุกคนต้องอยู่ในคาบเดียวกัน', category: 'teacher', defaultWeight: 8 },
  H12: { nameTh: 'เวลาเดินข้ามอาคาร', descriptionTh: 'ย้ายอาคารระหว่างคาบติดกันต้องเว้นคาบตามที่กำหนด', category: 'room', defaultWeight: 5, defaultParams: { gap: 1 } },
  H13: { nameTh: 'ภาระสอนสูงสุดต่อวัน', descriptionTh: 'จำนวนคาบสอนของครูต่อวันต้องไม่เกินที่กำหนด', category: 'teacher', defaultWeight: 6 },
  H14: { nameTh: 'สอนต่อเนื่องสูงสุด', descriptionTh: 'ครูสอนต่อเนื่องได้ไม่เกินจำนวนคาบที่กำหนด', category: 'teacher', defaultWeight: 6 },
  H15: { nameTh: 'วันหยุดของครู', descriptionTh: 'ห้ามจัดสอนในวันหยุดประจำสัปดาห์ของครู', category: 'teacher', defaultWeight: 8 },
  H16: { nameTh: 'สอนภาคค่ำต่อจากภาคปกติ', descriptionTh: 'จำนวนวันที่ครูสอนทั้งภาคปกติและภาคค่ำต้องไม่เกินที่กำหนด', category: 'teacher', defaultWeight: 5, defaultParams: { maxDays: 2 } },
  H17: { nameTh: 'วิชาเลือกชนกับวิชาบังคับ', descriptionTh: 'วิชาเลือกที่นักเรียนลงทะเบียนต้องไม่ชนกับวิชาบังคับของนักเรียน', category: 'student', defaultWeight: 10 },
  H18: { nameTh: 'จัดเฉพาะรายวิชาที่ลงทะเบียน', descriptionTh: 'รายการในตารางต้องมาจากรายวิชาที่เปิดในภาคเรียนนี้และมีกลุ่มเรียน', category: 'curriculum', defaultWeight: 100, supportsSoftMode: false },
  H19: { nameTh: 'ครูมีสิทธิ์สอนรายวิชา', descriptionTh: 'ครูผู้สอนต้องมีสิทธิ์สอนรายวิชานั้น (teach.csv)', category: 'teacher', defaultWeight: 10 },
  H20: { nameTh: 'จัดชั่วโมงครบตามหลักสูตร', descriptionTh: 'ทุกรายวิชาต้องจัดครบจำนวนคาบต่อสัปดาห์และไม่มีรายการค้างในถาด', category: 'curriculum', defaultWeight: 20 },
  H21: { nameTh: 'ช่วงเวลาที่กลุ่มเรียนว่าง', descriptionTh: 'ห้ามจัดในคาบที่กลุ่มเรียนไม่ว่างหรือคาบที่ไม่เปิดสอน', category: 'student', defaultWeight: 10 },
};

const SOFT_SPECS: Record<SoftConstraintCode, EntrySpec> = {
  S01: { nameTh: 'คาบว่างระหว่างวันของนักเรียน', descriptionTh: 'ลดคาบว่างที่แทรกระหว่างคาบเรียนของกลุ่มเรียน (ไม่นับคาบพักกลางวัน)', category: 'student', defaultWeight: 10, defaultParams: { allowedGaps: 0 } },
  S02: { nameTh: 'กระจายรายวิชาตลอดสัปดาห์', descriptionTh: 'ส่วนของรายวิชาเดียวกันไม่ควรอยู่วันเดียวกันหรือวันติดกัน', category: 'curriculum', defaultWeight: 8, defaultParams: { sameDayPenalty: 1, adjacentDayPenalty: 0.5 } },
  S03: { nameTh: 'ช่วงเวลาที่รายวิชาต้องการ', descriptionTh: 'รายวิชาที่ต้องการช่วงเช้า/บ่ายควรจัดในช่วงนั้น', category: 'time', defaultWeight: 5, defaultParams: { morningPeriods: [1, 2, 3, 4], afternoonPeriods: [6, 7, 8, 9] } },
  S04: { nameTh: 'ขนาดห้องเหมาะสมกับผู้เรียน', descriptionTh: 'ลดที่นั่งว่างในห้อง (สัดส่วนที่นั่งว่าง × จำนวนคาบ)', category: 'room', defaultWeight: 3 },
  S05: { nameTh: 'ครูได้พักกลางวัน', descriptionTh: 'ครูควรมีคาบว่างอย่างน้อย 1 คาบในช่วงพักกลางวัน', category: 'teacher', defaultWeight: 5, defaultParams: { lunchWindow: [4, 5] } },
  S06: { nameTh: 'ภาระสอนของครูเหมาะสม', descriptionTh: 'ครูไม่ควรสอนต่อเนื่องหรือสอนต่อวันมากเกินไป', category: 'teacher', defaultWeight: 6, defaultParams: { maxConsecutive: 4, maxDaily: 6 } },
  S07: { nameTh: 'เปลี่ยนแปลงจากตารางเดิมน้อยที่สุด', descriptionTh: 'จำนวนรายการที่วัน/คาบ/ห้อง/ครูต่างจากตารางเดิม', category: 'stability', defaultWeight: 20 },
  S08: { nameTh: 'คาบว่างระหว่างวันของครู', descriptionTh: 'ลดคาบว่างที่แทรกระหว่างคาบสอนของครู (ยกเว้นพักกลางวัน 1 คาบ)', category: 'teacher', defaultWeight: 6, defaultParams: { lunchWindow: [4, 5] } },
  S09: { nameTh: 'เรียนทฤษฎีต่อเนื่องนานเกินไป', descriptionTh: 'กลุ่มเรียนไม่ควรเรียนวิชาทฤษฎีติดกันเกินจำนวนคาบที่กำหนด', category: 'student', defaultWeight: 5, defaultParams: { max: 2 } },
  S10: { nameTh: 'การย้ายห้องเรียนระหว่างวัน', descriptionTh: 'ลดจำนวนครั้งที่กลุ่มเรียนต้องย้ายห้องในวันเดียวกัน', category: 'room', defaultWeight: 4 },
  S11: { nameTh: 'ลำดับเนื้อหารายวิชา', descriptionTh: 'ส่วนที่มาก่อน (เช่น ทฤษฎี) ควรเรียนก่อนส่วนถัดไป (เช่น ปฏิบัติ) ในสัปดาห์', category: 'curriculum', defaultWeight: 5, defaultParams: { segmentOrder: true, sequences: [] } },
  S12: { nameTh: 'ช่วงเวลาเรียนต่อวันยาวเกินไป', descriptionTh: 'ช่วงตั้งแต่คาบแรกถึงคาบสุดท้ายของวันไม่ควรยาวเกินที่กำหนดโดยไม่จำเป็น', category: 'student', defaultWeight: 4, defaultParams: { maxSpan: 7 } },
  S13: { nameTh: 'จำนวนคาบต่อวันสมดุล', descriptionTh: 'จำนวนคาบเรียนแต่ละวันของกลุ่มเรียนควรใกล้เคียงค่าเฉลี่ย', category: 'student', defaultWeight: 8, defaultParams: { tolerance: 0 } },
};

function buildCatalog(): Record<ConstraintCode, ConstraintCatalogEntry> {
  const out = {} as Record<ConstraintCode, ConstraintCatalogEntry>;
  for (const code of HARD_CONSTRAINT_CODES) {
    const s = HARD_SPECS[code];
    out[code] = {
      code,
      kind: 'hard',
      key: HARD_CONSTRAINT_NAMES[code],
      nameTh: s.nameTh,
      descriptionTh: s.descriptionTh,
      category: s.category,
      defaultMode: 'hard',
      defaultWeight: s.defaultWeight,
      defaultParams: s.defaultParams ?? {},
      supportsSoftMode: s.supportsSoftMode ?? true,
    };
  }
  for (const code of SOFT_CONSTRAINT_CODES) {
    const s = SOFT_SPECS[code];
    out[code] = {
      code,
      kind: 'soft',
      key: SOFT_CONSTRAINT_NAMES[code],
      nameTh: s.nameTh,
      descriptionTh: s.descriptionTh,
      category: s.category,
      defaultMode: 'soft',
      defaultWeight: s.defaultWeight,
      defaultParams: s.defaultParams ?? {},
      supportsSoftMode: true,
    };
  }
  return out;
}

export const CONSTRAINT_CATALOG: Readonly<Record<ConstraintCode, ConstraintCatalogEntry>> = buildCatalog();

export function getCatalogEntry(code: ConstraintCode): ConstraintCatalogEntry {
  return CONSTRAINT_CATALOG[code];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

interface PresetEntry {
  mode: ConstraintMode;
  weight?: number;
  params?: JsonObject;
}

type ProfilePreset = Partial<Record<ConstraintCode, PresetEntry>>;

const hard = (): PresetEntry => ({ mode: 'hard' });
const soft = (weight: number, params?: JsonObject): PresetEntry => ({ mode: 'soft', weight, ...(params ? { params } : {}) });

function allHard(): ProfilePreset {
  const preset: ProfilePreset = {};
  for (const code of HARD_CONSTRAINT_CODES) preset[code] = hard();
  return preset;
}

/** Codes absent from a preset are `off`. */
const PROFILE_PRESETS: Record<BuiltInProfileName, ProfilePreset> = {
  // Competition Core Requirements (20 items): 9 Hard + 10 Soft (+ slot bounds inside H07/H21).
  competition: {
    H01: hard(),
    H02: hard(),
    H03: hard(),
    H18: hard(),
    H19: hard(),
    H20: hard(),
    H07: hard(),
    H21: hard(),
    H04: hard(),
    S13: soft(8),
    S01: soft(10),
    S08: soft(6),
    S06: soft(6),
    S09: soft(5),
    H09: soft(8),
    S10: soft(4),
    H05: soft(6),
    S11: soft(5),
    S12: soft(4),
  },
  // 25-scenario preset: all Hard codes + core Soft S01–S07.
  default: {
    ...allHard(),
    S01: soft(10),
    S02: soft(8),
    S03: soft(5),
    S04: soft(3),
    S05: soft(5),
    S06: soft(6),
    S07: soft(20),
  },
  teacher_first: {
    ...allHard(),
    S05: soft(15),
    S06: soft(15),
    S08: soft(12),
    S01: soft(6),
    S04: soft(2),
  },
  room_first: {
    ...allHard(),
    S04: soft(15),
    S10: soft(12),
    S01: soft(8),
    S05: soft(3),
    S06: soft(3),
  },
};

export const BUILT_IN_PROFILES = Object.keys(PROFILE_PRESETS) as BuiltInProfileName[];
export const DEFAULT_PROFILE_NAME: BuiltInProfileName = 'competition';

export function isBuiltInProfile(name: string): name is BuiltInProfileName {
  return Object.prototype.hasOwnProperty.call(PROFILE_PRESETS, name);
}

function presetFor(profileName: string): ProfilePreset {
  return isBuiltInProfile(profileName) ? PROFILE_PRESETS[profileName] : PROFILE_PRESETS.default;
}

/** Resolved map of one built-in profile (unknown names fall back to `default`). */
export function resolveProfile(profileName: string): ResolvedConstraintConfigMap {
  const preset = presetFor(profileName);
  const out = {} as ResolvedConstraintConfigMap;
  for (const code of CONSTRAINT_CODES) {
    const entry = CONSTRAINT_CATALOG[code];
    const p = preset[code];
    out[code] = {
      code,
      mode: p?.mode ?? 'off',
      weight: p?.weight ?? entry.defaultWeight,
      params: { ...entry.defaultParams, ...(p?.params ?? {}) },
      source: 'profile',
    };
  }
  return out;
}

/** `constraint_configs` rows (34, catalog order) for a profile — used for seeding. */
export function getProfileConfigs(profileName: string): ConstraintConfig[] {
  const resolved = resolveProfile(profileName);
  return CONSTRAINT_CODES.map((code) => ({
    id: `${profileName}:${code}`,
    profileName,
    code,
    mode: resolved[code].mode,
    weight: resolved[code].mode === 'soft' ? resolved[code].weight : 0,
    params: Object.keys(resolved[code].params).length > 0 ? { ...resolved[code].params } : null,
  }));
}

/**
 * Merge order: catalog defaults → built-in profile preset → `ctx.constraintConfigs`
 * rows of the same profile → `ctx.overrides`.
 */
export function resolveConstraintConfigs(
  ctx: Pick<ScheduleEvaluationContext, 'profileName' | 'constraintConfigs' | 'overrides'>,
): { profileName: string; configs: ResolvedConstraintConfigMap } {
  const profileName = ctx.profileName ?? ctx.constraintConfigs?.[0]?.profileName ?? DEFAULT_PROFILE_NAME;
  const configs = resolveProfile(profileName);

  for (const row of ctx.constraintConfigs ?? []) {
    if (row.profileName !== profileName || !isConstraintCode(row.code)) continue;
    const prev = configs[row.code];
    configs[row.code] = {
      code: row.code,
      mode: row.mode,
      weight: row.weight ?? prev.weight,
      params: { ...prev.params, ...(row.params ?? {}) },
      source: 'config',
    };
  }

  for (const code of CONSTRAINT_CODES) {
    const o = ctx.overrides?.[code];
    if (!o) continue;
    const prev = configs[code];
    configs[code] = {
      code,
      mode: o.mode ?? prev.mode,
      weight: o.weight ?? prev.weight,
      params: { ...prev.params, ...(o.params ?? {}) },
      source: 'override',
    };
  }
  return { profileName, configs };
}

export function activeCodes(configs: ResolvedConstraintConfigMap, mode?: 'hard' | 'soft'): ConstraintCode[] {
  return CONSTRAINT_CODES.filter((c) => (mode ? configs[c].mode === mode : configs[c].mode !== 'off'));
}
