/**
 * Deterministic scenario builders (Q01, Q21) + conversion of a scenario to the competition
 * 7-CSV format. Pure functions: same input → byte-identical output (seeded RNG, hashed IDs,
 * deterministic demo password salts). `generate-scenarios.ts` writes the results to disk.
 */
import { createHash } from 'node:crypto';
import type {
  Account,
  Building,
  ConsentRecord,
  ConstraintConfig,
  ConstraintMode,
  CourseOffering,
  Dataset7FileKey,
  Department,
  EducationLevel,
  FixedBlock,
  HardConstraintCode,
  JsonObject,
  OfferingGroup,
  OfferingTeacher,
  Room,
  RoomType,
  RoomTypeCode,
  ScenarioDataset,
  ScenarioDemoAccount,
  ScenarioTables,
  SlotRef,
  SoftConstraintCode,
  Staff,
  Student,
  StudentGroup,
  Subgroup,
  Subject,
  SubjectCategory,
  TableName,
  TeacherSubjectEligibility,
  Term,
  TimePreference,
  TimeSlot,
} from '@ptc/shared';
import { HARD_CONSTRAINT_NAMES, SOFT_CONSTRAINT_NAMES, TABLE_NAMES } from '@ptc/shared';
import { hashDemoPassword } from '../lib/password';

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

/** UUID-shaped (v5-style) ID derived from a SHA-1 of the parts. */
export function stableId(...parts: Array<string | number>): string {
  const h = createHash('sha1').update(`ptc-smart-schedulev4|${parts.join('|')}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** mulberry32 seeded PRNG → [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const intBetween = (rng: () => number, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

// ---------------------------------------------------------------------------
// Static catalogs
// ---------------------------------------------------------------------------

export const LUNCH_PERIOD_BY_LEVEL: Record<EducationLevel, number> = { 'ปวช.': 4, 'ปวส.': 5 };
const DAYS = [1, 2, 3, 4, 5];
const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8];
const ACADEMIC_YEAR = 2569;
const CURRICULUM_YEAR: Record<EducationLevel, number> = { 'ปวช.': 2562, 'ปวส.': 2563 };

const ROOM_TYPE_DEFS: ReadonlyArray<{ code: RoomTypeCode; name: string; isLab: boolean }> = [
  { code: 'theory', name: 'ห้องเรียนทฤษฎี', isLab: false },
  { code: 'lecture_hall', name: 'ห้องบรรยายรวม', isLab: false },
  { code: 'lab_com', name: 'ห้องปฏิบัติการคอมพิวเตอร์', isLab: true },
  { code: 'lab_network', name: 'ห้องปฏิบัติการเครือข่าย', isLab: true },
  { code: 'lab_ai', name: 'ห้องปฏิบัติการปัญญาประดิษฐ์', isLab: true },
  { code: 'lab_graphic', name: 'ห้องปฏิบัติการกราฟิก', isLab: true },
  { code: 'activity_yard', name: 'ลานกิจกรรม', isLab: false },
];

type Discipline = 'thai' | 'english' | 'math' | 'science' | 'social' | 'pe' | 'business' | 'computer';
type LevelYear = 'ปวช.1' | 'ปวช.2' | 'ปวช.3' | 'ปวส.1' | 'ปวส.2';

interface SubjectDef {
  code: string;
  name: string;
  t: number;
  p: number;
  c: number;
  category: SubjectCategory;
  roomType: RoomTypeCode | null;
  consecutive: boolean;
  pref: TimePreference;
  discipline: Discipline | null;
  level: EducationLevel;
  /** dept code for core subjects (eligibility = that dept's core teachers). */
  dept: string | null;
}

const gen = (
  level: EducationLevel,
  code: string,
  name: string,
  t: number,
  p: number,
  c: number,
  discipline: Discipline,
  opts: { roomType?: RoomTypeCode; pref?: TimePreference; category?: SubjectCategory; consecutive?: boolean } = {},
): SubjectDef => ({
  code,
  name,
  t,
  p,
  c,
  category: opts.category ?? 'general',
  roomType: opts.roomType ?? null,
  consecutive: opts.consecutive ?? false,
  pref: opts.pref ?? 'any',
  discipline,
  level,
  dept: null,
});

/** General-education + basic vocational subjects per level/year (curriculum ปวช. 2562 / ปวส. 2563). */
const GENERAL_SUBJECTS: Record<LevelYear, SubjectDef[]> = {
  'ปวช.1': [
    gen('ปวช.', '20000-1101', 'ภาษาไทยพื้นฐาน', 1, 0, 1, 'thai'),
    gen('ปวช.', '20000-1201', 'ภาษาอังกฤษในชีวิตจริง', 0, 2, 1, 'english'),
    gen('ปวช.', '20000-1401', 'คณิตศาสตร์พื้นฐานอาชีพ', 2, 0, 2, 'math', { pref: 'morning' }),
    gen('ปวช.', '20000-1301', 'วิทยาศาสตร์เพื่อพัฒนาทักษะชีวิต', 1, 2, 2, 'science'),
    gen('ปวช.', '20000-1501', 'หน้าที่พลเมืองและศีลธรรม', 1, 0, 1, 'social'),
    gen('ปวช.', '20000-1601', 'การพัฒนาสุขภาพ', 0, 2, 1, 'pe', { roomType: 'activity_yard', pref: 'afternoon', consecutive: true }),
    gen('ปวช.', '20001-1001', 'คอมพิวเตอร์และสารสนเทศเพื่องานอาชีพ', 1, 2, 2, 'computer', {
      roomType: 'lab_com',
      category: 'core',
      consecutive: true,
    }),
  ],
  'ปวช.2': [
    gen('ปวช.', '20000-1102', 'ภาษาไทยเพื่ออาชีพ', 1, 0, 1, 'thai'),
    gen('ปวช.', '20000-1202', 'ภาษาอังกฤษสื่อสารในชีวิตประจำวัน', 0, 2, 1, 'english'),
    gen('ปวช.', '20000-1402', 'คณิตศาสตร์และสถิติเพื่องานอาชีพ', 2, 0, 2, 'math', { pref: 'morning' }),
    gen('ปวช.', '20000-1302', 'วิทยาศาสตร์เพื่องานอาชีพ', 1, 2, 2, 'science'),
    gen('ปวช.', '20000-1503', 'ประวัติศาสตร์ชาติไทย', 1, 0, 1, 'social'),
  ],
  'ปวช.3': [
    gen('ปวช.', '20000-1203', 'ภาษาอังกฤษในงานอาชีพ', 0, 2, 1, 'english'),
    gen('ปวช.', '20000-1602', 'พลศึกษาเพื่อพัฒนาสุขภาพ', 0, 2, 1, 'pe', { roomType: 'activity_yard', pref: 'afternoon', consecutive: true }),
    gen('ปวช.', '20001-1002', 'การเป็นผู้ประกอบการ', 1, 2, 2, 'business', { category: 'core' }),
  ],
  'ปวส.1': [
    gen('ปวส.', '30000-1101', 'ทักษะภาษาไทยเชิงวิชาชีพ', 1, 0, 1, 'thai'),
    gen('ปวส.', '30000-1201', 'ภาษาอังกฤษสำหรับการปฏิบัติงาน', 0, 2, 1, 'english'),
    gen('ปวส.', '30000-1401', 'คณิตศาสตร์เพื่อพัฒนาทักษะการคิด', 2, 0, 2, 'math', { pref: 'morning' }),
    gen('ปวส.', '30000-1301', 'วิทยาศาสตร์เพื่องานอาชีพ', 1, 2, 2, 'science'),
    gen('ปวส.', '30000-1501', 'ทักษะชีวิตเพื่อการทำงาน', 1, 0, 1, 'social'),
    gen('ปวส.', '30001-1001', 'การบริหารงานคุณภาพในองค์การ', 2, 0, 2, 'business', { category: 'core' }),
  ],
  'ปวส.2': [
    gen('ปวส.', '30000-1202', 'ภาษาอังกฤษเพื่อการสื่อสารในงานอาชีพ', 0, 2, 1, 'english'),
    gen('ปวส.', '30000-1402', 'สถิติและการวางแผนการทดลอง', 2, 0, 2, 'math', { pref: 'morning' }),
    gen('ปวส.', '30000-1502', 'การพัฒนาตนเองและบุคลิกภาพ', 1, 0, 1, 'social'),
    gen('ปวส.', '30001-1002', 'การเป็นผู้ประกอบการธุรกิจ', 2, 0, 2, 'business', { category: 'core' }),
  ],
};

/** Combined (multi-group) general subjects used in large scenarios, taught in a lecture hall. */
const COMBINED_SUBJECT_CODES = new Set(['30001-1001', '30001-1002']);

interface DeptDef {
  code: string;
  name: string;
  /** Short Thai field name used in group display names. */
  field: string;
  pvc: string;
  pvs: string;
  labs: RoomTypeCode[];
  /** 12 ปวช. core names (4 per year) followed by 8 ปวส. core names (4 per year). */
  cores: string[];
}

const split = (s: string) => s.split('|');

const DEPARTMENTS: Record<string, DeptDef> = {
  IT: {
    code: 'IT',
    name: 'แผนกวิชาเทคโนโลยีสารสนเทศ',
    field: 'เทคโนโลยีสารสนเทศ',
    pvc: '20901',
    pvs: '30901',
    labs: ['lab_com', 'lab_network', 'lab_ai'],
    cores: split(
      'คอมพิวเตอร์และการบำรุงรักษา|หลักการเขียนโปรแกรม|ระบบปฏิบัติการเบื้องต้น|คณิตศาสตร์คอมพิวเตอร์|การเขียนโปรแกรมภาษาไพทอน|ระบบฐานข้อมูลเบื้องต้น|เครือข่ายคอมพิวเตอร์เบื้องต้น|การออกแบบเว็บไซต์|การพัฒนาเว็บแอปพลิเคชัน|ปัญญาประดิษฐ์เบื้องต้น|การพัฒนาแอปพลิเคชันบนมือถือ|ความปลอดภัยไซเบอร์เบื้องต้น|' +
        'การวิเคราะห์และออกแบบระบบ|การเขียนโปรแกรมเชิงวัตถุ|การบริหารจัดการเครือข่าย|ระบบฐานข้อมูลขั้นสูง|การเรียนรู้ของเครื่อง|การประมวลผลคลาวด์|อินเทอร์เน็ตของสรรพสิ่ง|การทดสอบซอฟต์แวร์',
    ),
  },
  BCT: {
    code: 'BCT',
    name: 'แผนกวิชาคอมพิวเตอร์ธุรกิจ',
    field: 'คอมพิวเตอร์ธุรกิจ',
    pvc: '20204',
    pvs: '30204',
    labs: ['lab_com'],
    cores: split(
      'การใช้โปรแกรมประมวลผลคำ|การใช้โปรแกรมตารางงาน|คอมพิวเตอร์ในงานธุรกิจ|การเขียนโปรแกรมเบื้องต้น|การสร้างงานนำเสนอ|ระบบฐานข้อมูลในงานธุรกิจ|การออกแบบเว็บเพจ|การตลาดดิจิทัลเบื้องต้น|การผลิตสื่อสิ่งพิมพ์|การสร้างเว็บไซต์ธุรกิจ|การเขียนโปรแกรมบนเว็บ|ระบบสารสนเทศในงานธุรกิจ|' +
        'การวิเคราะห์ระบบงานธุรกิจ|การพัฒนาโปรแกรมธุรกิจ|การจัดการฐานข้อมูลธุรกิจ|พาณิชย์อิเล็กทรอนิกส์|การวิเคราะห์ข้อมูลธุรกิจ|การจัดการเครือข่ายในสำนักงาน|การพัฒนาระบบ ERP เบื้องต้น|ธุรกิจดิจิทัล',
    ),
  },
  ACC: {
    code: 'ACC',
    name: 'แผนกวิชาการบัญชี',
    field: 'การบัญชี',
    pvc: '20201',
    pvs: '30201',
    labs: ['lab_com'],
    cores: split(
      'บัญชีเบื้องต้น 1|บัญชีเบื้องต้น 2|การบัญชีห้างหุ้นส่วน|กฎหมายพาณิชย์|การบัญชีบริษัทจำกัด|การบัญชีต้นทุนเบื้องต้น|โปรแกรมสำเร็จรูปทางการบัญชี|การบัญชีภาษีอากร|การบัญชีสินค้า|การบัญชีเจ้าหนี้และลูกหนี้|การจัดทำงบการเงิน|การตรวจสอบภายในเบื้องต้น|' +
        'การบัญชีชั้นกลาง 1|การบัญชีชั้นกลาง 2|การบัญชีต้นทุน|ระบบสารสนเทศทางการบัญชี|การวางระบบบัญชี|การสอบบัญชี|การบัญชีเพื่อการจัดการ|การวิเคราะห์งบการเงิน',
    ),
  },
  MKT: {
    code: 'MKT',
    name: 'แผนกวิชาการตลาด',
    field: 'การตลาด',
    pvc: '20202',
    pvs: '30202',
    labs: [],
    cores: split(
      'หลักการตลาด|การขายเบื้องต้น|การบริการลูกค้า|พฤติกรรมผู้บริโภค|การจัดแสดงสินค้า|การโฆษณาและประชาสัมพันธ์|การส่งเสริมการขาย|การตลาดออนไลน์|การค้าปลีก|การวิจัยตลาดเบื้องต้น|การจัดการสินค้า|การขายตรง|' +
        'การบริหารการตลาด|การวิจัยการตลาด|การตลาดดิจิทัล|การจัดการตราสินค้า|การตลาดระหว่างประเทศ|การบริหารงานขาย|การจัดการลูกค้าสัมพันธ์|กลยุทธ์การตลาด',
    ),
  },
  AUTO: {
    code: 'AUTO',
    name: 'แผนกวิชาช่างยนต์',
    field: 'ช่างยนต์',
    pvc: '20101',
    pvs: '30101',
    labs: [],
    cores: split(
      'งานเครื่องยนต์เล็ก|งานจักรยานยนต์|งานเครื่องยนต์แก๊สโซลีน|งานเครื่องยนต์ดีเซล|งานส่งกำลังรถยนต์|งานไฟฟ้ารถยนต์|งานเครื่องล่างรถยนต์|งานปรับอากาศรถยนต์|งานบำรุงรักษารถยนต์|งานเชื้อเพลิงและระบบฉีด|งานตรวจวินิจฉัยเครื่องยนต์|งานถอดประกอบเครื่องยนต์|' +
        'งานเครื่องยนต์หัวฉีดอิเล็กทรอนิกส์|งานระบบควบคุมรถยนต์|งานรถยนต์ไฟฟ้าเบื้องต้น|งานระบบส่งกำลังอัตโนมัติ|งานวิเคราะห์ปัญหาเครื่องยนต์|งานระบบเบรกและช่วงล่าง|งานบริหารศูนย์บริการ|งานยานยนต์ไฮบริด',
    ),
  },
  ELEC: {
    code: 'ELEC',
    name: 'แผนกวิชาช่างไฟฟ้ากำลัง',
    field: 'ช่างไฟฟ้ากำลัง',
    pvc: '20104',
    pvs: '30104',
    labs: [],
    cores: split(
      'เขียนแบบไฟฟ้า|วงจรไฟฟ้ากระแสตรง|วงจรไฟฟ้ากระแสสลับ|การติดตั้งไฟฟ้าในอาคาร|เครื่องวัดไฟฟ้า|เครื่องกลไฟฟ้า|การควบคุมมอเตอร์ไฟฟ้า|หม้อแปลงไฟฟ้า|การติดตั้งไฟฟ้านอกอาคาร|เครื่องทำความเย็น|การประมาณการติดตั้งไฟฟ้า|การบำรุงรักษาระบบไฟฟ้า|' +
        'การออกแบบระบบไฟฟ้า|ระบบควบคุมในงานอุตสาหกรรม|การโปรแกรมพีแอลซี|อิเล็กทรอนิกส์กำลัง|ระบบไฟฟ้ากำลัง|พลังงานทดแทน|การส่งและจ่ายไฟฟ้า|มาตรฐานการติดตั้งทางไฟฟ้า',
    ),
  },
  GD: {
    code: 'GD',
    name: 'แผนกวิชาคอมพิวเตอร์กราฟิก',
    field: 'คอมพิวเตอร์กราฟิก',
    pvc: '20412',
    pvs: '30412',
    labs: ['lab_graphic', 'lab_com'],
    cores: split(
      'การวาดเส้นเบื้องต้น|องค์ประกอบศิลป์|คอมพิวเตอร์กราฟิกเบื้องต้น|การถ่ายภาพดิจิทัล|การออกแบบกราฟิก|การสร้างภาพเคลื่อนไหว 2 มิติ|การออกแบบสิ่งพิมพ์|การตัดต่อวิดีโอ|การสร้างโมเดล 3 มิติ|การออกแบบอัตลักษณ์องค์กร|การออกแบบส่วนติดต่อผู้ใช้|การผลิตสื่อโฆษณา|' +
        'การออกแบบสื่อดิจิทัล|แอนิเมชัน 3 มิติ|การออกแบบประสบการณ์ผู้ใช้|เทคนิคพิเศษทางภาพ|การกำกับศิลป์|การออกแบบเกมเบื้องต้น|การผลิตภาพยนตร์สั้น|การบริหารงานออกแบบ',
    ),
  },
  ELN: {
    code: 'ELN',
    name: 'แผนกวิชาช่างอิเล็กทรอนิกส์',
    field: 'ช่างอิเล็กทรอนิกส์',
    pvc: '20105',
    pvs: '30105',
    labs: [],
    cores: split(
      'อุปกรณ์อิเล็กทรอนิกส์|วงจรไฟฟ้าเบื้องต้น|เครื่องมือวัดอิเล็กทรอนิกส์|วงจรดิจิทัล|ไมโครคอนโทรลเลอร์เบื้องต้น|เครื่องรับวิทยุ|ระบบเสียง|งานบัดกรีและประกอบวงจร|เซนเซอร์และทรานสดิวเซอร์|เครื่องเสียงและภาพ|ระบบสื่อสารเบื้องต้น|การซ่อมอุปกรณ์อิเล็กทรอนิกส์|' +
        'ไมโครโปรเซสเซอร์|ระบบสมองกลฝังตัว|อิเล็กทรอนิกส์อุตสาหกรรม|ระบบโทรคมนาคม|การออกแบบแผ่นวงจรพิมพ์|ระบบควบคุมอัตโนมัติ|หุ่นยนต์เบื้องต้น|อินเทอร์เน็ตของสรรพสิ่งในงานอิเล็กทรอนิกส์',
    ),
  },
  HOTEL: {
    code: 'HOTEL',
    name: 'แผนกวิชาการโรงแรม',
    field: 'การโรงแรม',
    pvc: '20701',
    pvs: '30701',
    labs: [],
    cores: split(
      'ความรู้เบื้องต้นธุรกิจโรงแรม|งานบริการส่วนหน้า|งานแม่บ้านโรงแรม|งานบริการอาหารและเครื่องดื่ม|ภาษาอังกฤษสำหรับงานโรงแรม 1|การผสมเครื่องดื่ม|งานครัวเบื้องต้น|มารยาทและบุคลิกภาพในงานบริการ|ภาษาอังกฤษสำหรับงานโรงแรม 2|การจัดเลี้ยงและประชุม|ภาษาจีนสำหรับงานโรงแรม|ระบบสำรองห้องพัก|' +
        'การจัดการงานส่วนหน้า|การจัดการงานแม่บ้าน|การจัดการงานอาหารและเครื่องดื่ม|การจัดการธุรกิจไมซ์|การตลาดธุรกิจโรงแรม|กฎหมายธุรกิจโรงแรม|การจัดการทรัพยากรมนุษย์ในโรงแรม|การจัดการคุณภาพบริการ',
    ),
  },
};

const GEN_DEPT = { code: 'GEN', name: 'แผนกวิชาสามัญสัมพันธ์' };

/** Dept core subjects for one level/year: 4 cores (lab 1-3-2 / theory 2-2-3 alternating) + final project. */
function deptCores(dept: DeptDef, ly: LevelYear): SubjectDef[] {
  const level: EducationLevel = ly.startsWith('ปวช.') ? 'ปวช.' : 'ปวส.';
  const year = Number(ly.slice(-1));
  const prefix = level === 'ปวช.' ? dept.pvc : dept.pvs;
  const offset = level === 'ปวช.' ? 0 : 12;
  const result: SubjectDef[] = [];
  for (let i = 0; i < 4; i++) {
    const idx = (year - 1) * 4 + i;
    const lab = i % 2 === 0;
    const labType = lab && dept.labs.length > 0 ? dept.labs[Math.floor(idx / 2) % dept.labs.length]! : null;
    result.push({
      code: `${prefix}-${2001 + idx}`,
      name: dept.cores[offset + idx]!,
      t: lab ? 1 : 2,
      p: lab ? 3 : 2,
      c: lab ? 2 : 3,
      category: 'core',
      roomType: labType,
      consecutive: lab,
      pref: 'any',
      discipline: null,
      level,
      dept: dept.code,
    });
  }
  const finalYear = (level === 'ปวช.' && year === 3) || (level === 'ปวส.' && year === 2);
  if (finalYear) {
    result.push({
      code: `${prefix}-8501`,
      name: level === 'ปวช.' ? `โครงงาน${dept.field}` : `โครงการ${dept.field}`,
      t: 0,
      p: 4,
      c: 2,
      category: 'core',
      roomType: dept.labs[0] ?? null,
      consecutive: true,
      pref: 'afternoon',
      discipline: null,
      level,
      dept: dept.code,
    });
  }
  return result;
}

function splitPatternFor(total: number, consecutive: boolean, practice: number): number[] {
  if (consecutive || total <= 3) return [total];
  if (total === 4) return practice >= 3 ? [4] : [2, 2];
  const parts: number[] = [];
  let left = total;
  while (left > 0) {
    const chunk = left > 4 ? 3 : left;
    parts.push(chunk);
    left -= chunk;
  }
  return parts;
}

// Thai demo names (fictional combinations).
const MALE_NAMES = split('สมชาย|ธนากร|กิตติพงษ์|ณัฐวุฒิ|ภานุวัฒน์|ศุภชัย|อนุชา|วีรพล|ปิยะพงษ์|จักรพันธ์|ธีรเดช|พงศกร|ชยพล|ณัฐพล|สุรเชษฐ์|อภิสิทธิ์|เกียรติศักดิ์|วรวุฒิ|ธนพล|กฤษดา');
const FEMALE_NAMES = split('สุภาพร|กมลชนก|ณัฐธิดา|พิมพ์ชนก|ศิริพร|อรอุมา|จิราพร|ปวีณา|ธิดารัตน์|วรรณิภา|สุนิสา|ชนิดา|กัญญารัตน์|พรทิพย์|มณีรัตน์|นภัสสร|รัตนาภรณ์|อัญชลี|ปิยธิดา|เบญจวรรณ');
const LAST_NAMES = split('ใจดี|ศรีสุข|ทองมา|วงศ์ใหญ่|แก้วประเสริฐ|บุญมี|สายทอง|พรหมมา|ศักดิ์ดี|รุ่งเรือง|จันทร์เพ็ญ|มีสุข|เพชรรัตน์|สมบูรณ์|ชัยมงคล|อินทร์แก้ว|บุญเรือง|ศรีวงศ์|พิทักษ์ไทย|ทองคำ|ประเสริฐสุข|แสงอรุณ|เจริญผล|สุวรรณภูมิ|ธนสาร|มั่นคง|รักษาดี|ภูมิพัฒน์|วัฒนกุล|นาคสวัสดิ์');

function personName(rng: () => number, adult: boolean): string {
  const female = rng() < 0.5;
  const first = pick(rng, female ? FEMALE_NAMES : MALE_NAMES);
  const last = pick(rng, LAST_NAMES);
  const prefix = female ? (adult && rng() < 0.5 ? 'นาง' : 'นางสาว') : 'นาย';
  return `${prefix}${first} ${last}`;
}

// ---------------------------------------------------------------------------
// Constraint profiles
// ---------------------------------------------------------------------------

const SOFT_WEIGHTS: Record<SoftConstraintCode, number> = {
  S01: 10,
  S02: 8,
  S03: 5,
  S04: 3,
  S05: 5,
  S06: 6,
  S07: 20,
  S08: 6,
  S09: 4,
  S10: 3,
  S11: 5,
  S12: 4,
  S13: 4,
};

const CONSTRAINT_PARAMS: Partial<Record<HardConstraintCode | SoftConstraintCode, JsonObject>> = {
  H06: { lunchPeriodByLevel: LUNCH_PERIOD_BY_LEVEL },
  H12: { minGapPeriods: 1 },
  H13: { maxDailyPeriods: 6 },
  H14: { maxConsecutive: 3 },
  H16: { eveningStartPeriod: 10 },
  S01: { maxGapPerDay: 1 },
  S06: { targetDeviation: 4 },
  S09: { maxTheoryStreak: 3 },
  S12: { maxSpanPeriods: 7 },
  S13: { maxDailyDifference: 2 },
};

function buildConstraintConfigs(scope: string): ConstraintConfig[] {
  const rows: ConstraintConfig[] = [];
  const push = (profileName: string, code: string, mode: ConstraintMode, weight: number, params: JsonObject | null) =>
    rows.push({ id: stableId(scope, 'constraint_config', profileName, code), profileName, code, mode, weight, params });

  // competition: full catalog, all hard rules enforced (Q09-style 3-period teacher cap = hard).
  for (const code of Object.keys(HARD_CONSTRAINT_NAMES) as HardConstraintCode[]) {
    push('competition', code, 'hard', 0, CONSTRAINT_PARAMS[code] ?? null);
  }
  for (const code of Object.keys(SOFT_CONSTRAINT_NAMES) as SoftConstraintCode[]) {
    push('competition', code, 'soft', SOFT_WEIGHTS[code], CONSTRAINT_PARAMS[code] ?? null);
  }
  // default: core rules only (H01–H17, S01–S07); Core 1.3 allows 4 consecutive periods as soft.
  for (const code of Object.keys(HARD_CONSTRAINT_NAMES) as HardConstraintCode[]) {
    const n = Number(code.slice(1));
    if (code === 'H14') push('default', code, 'soft', 6, { maxConsecutive: 4 });
    else push('default', code, n <= 17 ? 'hard' : 'off', 0, CONSTRAINT_PARAMS[code] ?? null);
  }
  for (const code of Object.keys(SOFT_CONSTRAINT_NAMES) as SoftConstraintCode[]) {
    const n = Number(code.slice(1));
    push('default', code, n <= 7 ? 'soft' : 'off', n <= 7 ? SOFT_WEIGHTS[code] : 0, CONSTRAINT_PARAMS[code] ?? null);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Generic scenario builder
// ---------------------------------------------------------------------------

interface TeacherSpec {
  dept: string;
  disciplines: Discipline[];
  core: boolean;
  position: string;
  unavailable?: SlotRef[];
}

interface GroupSpec {
  dept: string;
  ly: LevelYear;
  roomNo: number;
  studentCount: number;
  subgroups: boolean;
  programType?: StudentGroup['programType'];
  unavailable?: SlotRef[];
}

interface RoomSpec {
  building: string;
  type: RoomTypeCode;
  capacity: number;
  features: string[];
  allowMultiGroup?: boolean;
  unavailable?: SlotRef[];
}

interface ScenarioSpec {
  code: string;
  name: string;
  description: string;
  seed: number;
  departments: Array<{ code: string; name: string }>;
  buildings: Array<{ code: string; name: string }>;
  rooms: RoomSpec[];
  teachers: TeacherSpec[];
  groups: GroupSpec[];
  coreEligibleCount: number;
  combineSize: number;
}

const DEMO_ACCOUNTS: ReadonlyArray<ScenarioDemoAccount> = [
  { username: 'admin', role: 'admin', password: 'admin1234' },
  { username: 'scheduler', role: 'scheduler', password: 'scheduler1234' },
  { username: 'teacher', role: 'teacher', password: 'teacher1234' },
  { username: 'student', role: 'student', password: 'student1234' },
  { username: 'viewer', role: 'viewer', password: 'viewer1234' },
];

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const hhmm = (h: number) => `${pad(h, 2)}:00:00`;

function buildScenario(spec: ScenarioSpec): ScenarioDataset {
  const scope = spec.code;
  const id = (...parts: Array<string | number>) => stableId(scope, ...parts);
  const rng = createRng(spec.seed);

  // Calendar ------------------------------------------------------------------
  const term: Term = {
    id: id('term', ACADEMIC_YEAR, 2),
    academicYear: ACADEMIC_YEAR,
    semester: 2,
    startDate: '2026-11-02',
    endDate: '2027-03-12',
  };
  const timeSlots: TimeSlot[] = PERIODS.map((period) => ({
    id: id('time_slot', period),
    termId: term.id,
    period,
    startTime: hhmm(7 + period),
    endTime: hhmm(8 + period),
    shift: 'day',
    openDays: [...DAYS],
  }));

  // Places --------------------------------------------------------------------
  const departments: Department[] = spec.departments.map((d) => ({ id: id('department', d.code), code: d.code, name: d.name }));
  const deptId = new Map(departments.map((d) => [d.code!, d.id]));
  const buildings: Building[] = spec.buildings.map((b) => ({ id: id('building', b.code), code: b.code, name: b.name }));
  const buildingId = new Map(buildings.map((b) => [b.code!, b.id]));
  const roomTypes: RoomType[] = ROOM_TYPE_DEFS.map((t) => ({ id: id('room_type', t.code), code: t.code, name: t.name, isLab: t.isLab }));
  const roomTypeId = new Map(roomTypes.map((t) => [t.code, t.id]));

  const perBuildingCount = new Map<string, number>();
  const rooms: Room[] = spec.rooms.map((r) => {
    const n = (perBuildingCount.get(r.building) ?? 0) + 1;
    perBuildingCount.set(r.building, n);
    const floor = 1 + Math.floor((n - 1) / 6);
    const roomCode = `${r.building}-${floor}${pad(((n - 1) % 6) + 1, 2)}`;
    return {
      id: id('room', roomCode),
      roomCode,
      buildingId: buildingId.get(r.building)!,
      roomTypeId: roomTypeId.get(r.type)!,
      capacity: r.capacity,
      allowMultiGroup: r.allowMultiGroup ?? false,
      features: r.features,
      unavailableSlots: r.unavailable ?? null,
    };
  });
  const availableTypes = new Set(spec.rooms.map((r) => r.type));
  const resolveRoomType = (t: RoomTypeCode | null): RoomTypeCode | null => {
    if (!t || availableTypes.has(t)) return t;
    if (t.startsWith('lab_') && availableTypes.has('lab_com')) return 'lab_com';
    return null;
  };

  // Staff ---------------------------------------------------------------------
  const staff: Staff[] = spec.teachers.map((t, i) => {
    const employeeCode = `T${pad(i + 1, 3)}`;
    return {
      id: id('staff', employeeCode),
      employeeCode,
      fullName: personName(rng, true),
      departmentId: deptId.get(t.dept)!,
      position: t.position,
      staffType: 'teacher',
      phoneEncrypted: null,
      maxDailyPeriods: 6,
      maxConsecutive: 3,
      maxWeeklyPeriods: 24,
      dayOff: null,
      availableSlots: null,
      unavailableSlots: t.unavailable ?? null,
    };
  });

  // Groups, subgroups, students ------------------------------------------------
  const studentGroups: StudentGroup[] = [];
  const subgroups: Subgroup[] = [];
  const students: Student[] = [];
  const groupIndexInDept = new Map<string, number>();
  const groupSpecs = new Map<string, GroupSpec>();
  for (const g of spec.groups) {
    const level: EducationLevel = g.ly.startsWith('ปวช.') ? 'ปวช.' : 'ปวส.';
    const yearNo = Number(g.ly.slice(-1));
    const groupCode = `${g.dept}-${g.ly}/${g.roomNo}`;
    const groupId = id('group', groupCode);
    groupSpecs.set(groupId, g);
    studentGroups.push({
      id: groupId,
      groupCode,
      departmentId: deptId.get(g.dept)!,
      level,
      yearNo,
      programType: g.programType ?? 'ปกติ',
      studentCount: g.studentCount,
      lunchPeriod: LUNCH_PERIOD_BY_LEVEL[level],
      allowedDays: [...DAYS],
      allowedShift: 'day',
      unavailableSlots: g.unavailable ?? null,
    });
    const subIds: Record<'A' | 'B', string> | null = g.subgroups
      ? { A: id('subgroup', groupCode, 'A'), B: id('subgroup', groupCode, 'B') }
      : null;
    const sizeA = Math.ceil(g.studentCount / 2);
    if (subIds) {
      subgroups.push({ id: subIds.A, groupId, code: 'A', studentCount: sizeA });
      subgroups.push({ id: subIds.B, groupId, code: 'B', studentCount: g.studentCount - sizeA });
    }
    const gi = (groupIndexInDept.get(g.dept) ?? 0) + 1;
    groupIndexInDept.set(g.dept, gi);
    const entryYY = (ACADEMIC_YEAR - (yearNo - 1)) % 100;
    const deptNo = spec.departments.findIndex((d) => d.code === g.dept) + 1;
    for (let s = 1; s <= g.studentCount; s++) {
      const studentCode = `${entryYY}${level === 'ปวช.' ? 2 : 3}${pad(deptNo, 2)}${pad(gi, 2)}${pad(s, 2)}`;
      students.push({
        id: id('student', studentCode),
        studentCode,
        fullName: personName(rng, false),
        groupId,
        subgroupId: subIds ? (s <= sizeA ? subIds.A : subIds.B) : null,
      });
    }
  }

  // Subjects --------------------------------------------------------------------
  const subjectDefs = new Map<string, SubjectDef>();
  const curriculumOf = (g: GroupSpec): SubjectDef[] => {
    const dept = DEPARTMENTS[g.dept];
    if (!dept) throw new Error(`Unknown department ${g.dept}`);
    return [...GENERAL_SUBJECTS[g.ly], ...deptCores(dept, g.ly)];
  };
  for (const g of spec.groups) for (const s of curriculumOf(g)) if (!subjectDefs.has(s.code)) subjectDefs.set(s.code, s);

  const subjects: Subject[] = [...subjectDefs.values()].map((s) => {
    const rt = resolveRoomType(s.roomType);
    return {
      id: id('subject', s.code, CURRICULUM_YEAR[s.level]),
      subjectCode: s.code,
      curriculumYear: CURRICULUM_YEAR[s.level],
      subjectName: s.name,
      theoryHours: s.t,
      practiceHours: s.p,
      credits: s.c,
      category: s.category,
      requiredRoomTypeId: rt ? roomTypeId.get(rt)! : null,
      defaultSplit: splitPatternFor(s.t + s.p, s.consecutive, s.p),
      mustBeConsecutive: s.consecutive,
      timePreference: s.pref,
    };
  });
  const subjectByCode = new Map(subjects.map((s) => [s.subjectCode, s]));

  // Eligibility -------------------------------------------------------------------
  const eligibility: TeacherSubjectEligibility[] = [];
  const eligibleBySubject = new Map<string, string[]>();
  const coreTeachersByDept = new Map<string, string[]>();
  spec.teachers.forEach((t, i) => {
    if (!t.core) return;
    const list = coreTeachersByDept.get(t.dept) ?? [];
    list.push(staff[i]!.id);
    coreTeachersByDept.set(t.dept, list);
  });
  const deptCoreIndex = new Map<string, number>();
  for (const def of subjectDefs.values()) {
    let eligible: string[];
    if (def.dept) {
      const pool = coreTeachersByDept.get(def.dept) ?? [];
      const j = deptCoreIndex.get(def.dept) ?? 0;
      deptCoreIndex.set(def.dept, j + 1);
      const count = Math.min(spec.coreEligibleCount, pool.length);
      eligible = Array.from({ length: count }, (_, k) => pool[(j + k) % pool.length]!);
    } else {
      eligible = staff.filter((_, i) => spec.teachers[i]!.disciplines.includes(def.discipline!)).map((s) => s.id);
    }
    if (eligible.length === 0) throw new Error(`[${scope}] subject ${def.code} has no eligible teacher`);
    const subjectId = subjectByCode.get(def.code)!.id;
    eligibleBySubject.set(subjectId, eligible);
    for (const staffId of eligible) eligibility.push({ staffId, subjectId, groupId: null });
  }

  // Offerings ---------------------------------------------------------------------
  const courseOfferings: CourseOffering[] = [];
  const offeringGroups: OfferingGroup[] = [];
  const offeringTeachers: OfferingTeacher[] = [];
  const load = new Map<string, number>(staff.map((s) => [s.id, 0]));
  const leastLoaded = (candidates: string[], exclude: string[] = []): string =>
    candidates
      .filter((c) => !exclude.includes(c))
      .reduce((best, c) => (load.get(c)! < load.get(best)! ? c : best), candidates.find((c) => !exclude.includes(c))!);

  const addOffering = (
    subject: Subject,
    def: SubjectDef,
    groups: StudentGroup[],
    type: NonNullable<CourseOffering['offeringType']>,
  ) => {
    const offeringId = id('offering', subject.subjectCode, ...groups.map((g) => g.groupCode));
    const periods = def.t + def.p;
    const eligible = eligibleBySubject.get(subject.id)!;
    const roomType = type === 'combined' ? 'lecture_hall' : resolveRoomType(def.roomType);
    const subgroupRows = type === 'split' ? subgroups.filter((sg) => sg.groupId === groups[0]!.id) : [];
    courseOfferings.push({
      id: offeringId,
      termId: term.id,
      subjectId: subject.id,
      offeringType: type,
      periodsPerWeek: periods,
      splitPattern: subject.defaultSplit ?? [periods],
      roomTypeId: roomType ? roomTypeId.get(roomType)! : null,
      sectionNo: null,
      maxStudents:
        type === 'split'
          ? Math.max(...subgroupRows.map((sg) => sg.studentCount))
          : groups.reduce((sum, g) => sum + g.studentCount, 0),
    });
    for (const g of groups) offeringGroups.push({ offeringId, groupId: g.id });
    if (type === 'split') {
      const used: string[] = [];
      for (const sg of subgroupRows) {
        const staffId = leastLoaded(eligible, used);
        used.push(staffId);
        load.set(staffId, load.get(staffId)! + periods);
        offeringTeachers.push({ offeringId, staffId, subgroupCode: sg.code, role: 'main' });
      }
    } else {
      const staffId = leastLoaded(eligible);
      load.set(staffId, load.get(staffId)! + periods);
      offeringTeachers.push({ offeringId, staffId, subgroupCode: null, role: 'main' });
    }
  };

  const pendingCombined = new Map<string, StudentGroup[]>();
  for (const group of studentGroups) {
    const g = groupSpecs.get(group.id)!;
    let splitUsed = false;
    for (const def of curriculumOf(g)) {
      const subject = subjectByCode.get(def.code)!;
      if (spec.combineSize > 1 && COMBINED_SUBJECT_CODES.has(def.code)) {
        const list = pendingCombined.get(def.code) ?? [];
        list.push(group);
        pendingCombined.set(def.code, list);
        continue;
      }
      if (g.subgroups && !splitUsed && def.dept && def.consecutive) {
        splitUsed = true;
        addOffering(subject, def, [group], 'split');
        continue;
      }
      addOffering(subject, def, [group], 'regular');
    }
  }
  for (const [code, groups] of pendingCombined) {
    const def = subjectDefs.get(code)!;
    const subject = subjectByCode.get(code)!;
    for (let i = 0; i < groups.length; i += spec.combineSize) {
      const chunk = groups.slice(i, i + spec.combineSize);
      addOffering(subject, def, chunk, chunk.length > 1 ? 'combined' : 'regular');
    }
  }

  // Fixed blocks ------------------------------------------------------------------
  const yard = rooms.find((r) => r.roomTypeId === roomTypeId.get('activity_yard'));
  const fixedBlocks: FixedBlock[] = [
    {
      id: id('fixed_block', 'club-activity'),
      termId: term.id,
      name: 'กิจกรรมองค์การนักวิชาชีพในอนาคตแห่งประเทศไทย (อวท.)',
      blockType: 'activity',
      dayOfWeek: 3,
      startPeriod: 7,
      duration: 2,
      roomId: yard?.id ?? null,
      appliesTo: { all: true },
    },
  ];

  // Accounts & consent -------------------------------------------------------------
  const linkedTeacher = staff.find((_, i) => spec.teachers[i]!.core) ?? staff[0]!;
  const accounts: Account[] = DEMO_ACCOUNTS.map((a) => ({
    id: id('account', a.username),
    username: a.username,
    passwordHash: hashDemoPassword(a.password, a.username),
    role: a.role,
    staffId: a.role === 'teacher' || a.role === 'scheduler' ? linkedTeacher.id : null,
    studentId: a.role === 'student' ? students[0]!.id : null,
    lastLoginAt: null,
  }));
  const consentRecords: ConsentRecord[] = accounts.map((a) => ({
    id: id('consent', a.username, 'PDPA-2569-v1'),
    accountId: a.id,
    policyVersion: 'PDPA-2569-v1',
    consentedAt: '2026-11-01 08:00:00',
    withdrawnAt: null,
  }));

  const tables: ScenarioTables = {
    terms: [term],
    time_slots: timeSlots,
    departments,
    buildings,
    room_types: roomTypes,
    rooms,
    staff,
    accounts,
    consent_records: consentRecords,
    audit_logs: [],
    student_groups: studentGroups,
    subgroups,
    students,
    subjects,
    course_offerings: courseOfferings,
    offering_groups: offeringGroups,
    offering_teachers: offeringTeachers,
    elective_enrollments: [],
    fixed_blocks: fixedBlocks,
    teacher_subject_eligibility: eligibility,
    constraint_configs: buildConstraintConfigs(scope),
    schedule_versions: [],
    scheduling_runs: [],
    schedule_items: [],
    schedule_item_teachers: [],
    slot_occupancy: [],
    issue_reports: [],
    schedule_exceptions: [],
    import_jobs: [],
    challenge_rules: [],
  };

  const counts = Object.fromEntries(TABLE_NAMES.map((t) => [t, tables[t].length])) as Record<TableName, number>;
  return {
    code: spec.code,
    name: spec.name,
    description: spec.description,
    schemaVersion: 1,
    meta: {
      days: [...DAYS],
      periodsPerDay: PERIODS.length,
      totalSlots: timeSlots.reduce((sum, t) => sum + t.openDays.length, 0),
      lunchPeriodByLevel: { ...LUNCH_PERIOD_BY_LEVEL },
      rngSeed: spec.seed,
      counts,
    },
    demoAccounts: DEMO_ACCOUNTS.map((a) => ({ ...a })),
    tables,
  };
}

// ---------------------------------------------------------------------------
// Q01 — small single-department scenario
// ---------------------------------------------------------------------------

export function buildQ01(): ScenarioDataset {
  const theory = ['projector', 'whiteboard'];
  const lab = ['projector', 'air_conditioner', 'computers'];
  return buildScenario({
    code: 'Q01',
    name: 'Q01 — แผนกเดียว 4 กลุ่มเรียน (พื้นฐาน)',
    description:
      'ชุดข้อมูลพื้นฐาน: แผนกวิชาเทคโนโลยีสารสนเทศ 1 แผนก, 4 กลุ่มเรียน (ปวช. 2 กลุ่ม พักคาบ 4, ปวส. 2 กลุ่ม พักคาบ 5), ครู 8 คน, ห้อง 6 ห้องใน 2 อาคาร, 5 วัน × 8 คาบ',
    seed: 20260101,
    departments: [{ code: 'IT', name: DEPARTMENTS.IT!.name }],
    buildings: [
      { code: '1', name: 'อาคาร 1 อาคารเทคโนโลยีสารสนเทศ' },
      { code: '2', name: 'อาคาร 2 อาคารเรียนรวม' },
    ],
    rooms: [
      { building: '1', type: 'theory', capacity: 40, features: theory },
      { building: '1', type: 'theory', capacity: 40, features: theory },
      { building: '1', type: 'lab_com', capacity: 40, features: lab },
      { building: '2', type: 'theory', capacity: 45, features: theory },
      { building: '2', type: 'theory', capacity: 45, features: theory },
      { building: '2', type: 'lab_network', capacity: 40, features: [...lab, 'network_rack'] },
    ],
    teachers: [
      { dept: 'IT', disciplines: ['thai', 'social', 'english'], core: false, position: 'ครูชำนาญการ' },
      { dept: 'IT', disciplines: ['english', 'thai'], core: false, position: 'ครู' },
      { dept: 'IT', disciplines: ['math', 'business', 'science'], core: false, position: 'ครูชำนาญการพิเศษ' },
      { dept: 'IT', disciplines: ['science', 'pe', 'math'], core: false, position: 'ครู' },
      { dept: 'IT', disciplines: ['computer'], core: true, position: 'หัวหน้าแผนกวิชาเทคโนโลยีสารสนเทศ' },
      { dept: 'IT', disciplines: ['computer'], core: true, position: 'ครูชำนาญการ', unavailable: [{ day: 1, period: 1 }, { day: 1, period: 2 }] },
      { dept: 'IT', disciplines: ['computer', 'business'], core: true, position: 'ครู' },
      { dept: 'IT', disciplines: ['computer'], core: true, position: 'ครูผู้ช่วย' },
    ],
    groups: [
      { dept: 'IT', ly: 'ปวช.1', roomNo: 1, studentCount: 40, subgroups: true },
      { dept: 'IT', ly: 'ปวช.2', roomNo: 1, studentCount: 36, subgroups: false },
      { dept: 'IT', ly: 'ปวส.1', roomNo: 1, studentCount: 32, subgroups: false },
      {
        dept: 'IT',
        ly: 'ปวส.2',
        roomNo: 1,
        studentCount: 28,
        subgroups: false,
        unavailable: [{ day: 5, period: 7 }, { day: 5, period: 8 }],
      },
    ],
    coreEligibleCount: 2,
    combineSize: 1,
  });
}

// ---------------------------------------------------------------------------
// Q21 — college-scale scenario (10 departments, 60 groups, 120 teachers, 70 rooms)
// ---------------------------------------------------------------------------

export function buildQ21(): ScenarioDataset {
  const seed = 20260121;
  const rng = createRng(seed ^ 0x5bd1e995);
  const vocational = ['IT', 'BCT', 'ACC', 'MKT', 'AUTO', 'ELEC', 'GD', 'ELN', 'HOTEL'];
  const sevenGroups = new Set(['IT', 'BCT', 'ACC', 'MKT', 'AUTO', 'ELEC']);

  const groups: GroupSpec[] = [];
  for (const dept of vocational) {
    const layout: Array<[LevelYear, number]> = [
      ['ปวช.1', 1],
      ['ปวช.1', 2],
      ['ปวช.2', 1],
      ...(sevenGroups.has(dept) ? ([['ปวช.2', 2]] as Array<[LevelYear, number]>) : []),
      ['ปวช.3', 1],
      ['ปวส.1', 1],
      ['ปวส.2', 1],
    ];
    for (const [ly, roomNo] of layout) {
      const pvs = ly.startsWith('ปวส.');
      groups.push({
        dept,
        ly,
        roomNo,
        studentCount: pvs ? intBetween(rng, 22, 35) : intBetween(rng, 28, 40),
        subgroups: dept === 'IT' && ly === 'ปวช.1',
        programType: ly === 'ปวส.2' && (dept === 'AUTO' || dept === 'ELEC') ? 'ทวิภาคี' : 'ปกติ',
        unavailable: ly === 'ปวส.2' ? [6, 7, 8].map((period) => ({ day: 5, period })) : undefined,
      });
    }
  }

  const teachers: TeacherSpec[] = [];
  const positions = ['ครู', 'ครูชำนาญการ', 'ครูชำนาญการพิเศษ', 'ครูผู้ช่วย'];
  const generalPlan: Array<[Discipline, number]> = [
    ['thai', 4],
    ['english', 6],
    ['math', 5],
    ['science', 6],
    ['social', 3],
    ['pe', 3],
    ['business', 3],
  ];
  for (const [discipline, count] of generalPlan) {
    for (let i = 0; i < count; i++) {
      teachers.push({
        dept: 'GEN',
        disciplines: [discipline],
        core: false,
        position: positions[(teachers.length + i) % positions.length]!,
        unavailable: i === 0 ? [{ day: 1, period: 1 }, { day: 1, period: 2 }] : undefined,
      });
    }
  }
  for (const dept of vocational) {
    for (let i = 0; i < 10; i++) {
      teachers.push({
        dept,
        disciplines: dept === 'IT' || dept === 'BCT' ? ['computer'] : [],
        core: true,
        position: i === 0 ? `หัวหน้า${DEPARTMENTS[dept]!.name}` : positions[i % positions.length]!,
        unavailable: i === 9 ? [{ day: 4, period: 7 }, { day: 4, period: 8 }] : undefined,
      });
    }
  }

  const rooms: RoomSpec[] = [];
  const theoryFeatures = ['projector', 'whiteboard'];
  const labFeatures = ['projector', 'air_conditioner', 'computers'];
  const addRooms = (
    building: string,
    type: RoomTypeCode,
    n: number,
    capacity: (i: number) => number,
    features: string[],
    allowMultiGroup = false,
  ) => {
    for (let i = 0; i < n; i++) rooms.push({ building, type, capacity: capacity(i), features, allowMultiGroup });
  };
  addRooms('1', 'theory', 12, (i) => (i % 3 === 0 ? 45 : 40), theoryFeatures);
  addRooms('2', 'theory', 12, (i) => (i % 4 === 0 ? 45 : 40), theoryFeatures);
  addRooms('4', 'theory', 9, () => 40, theoryFeatures);
  addRooms('5', 'theory', 9, () => 40, [...theoryFeatures, 'workshop_access']);
  addRooms('6', 'lecture_hall', 3, (i) => [120, 150, 200][i]!, ['projector', 'sound_system', 'air_conditioner']);
  addRooms('3', 'lab_com', 8, () => 40, labFeatures);
  addRooms('4', 'lab_com', 5, () => 40, labFeatures);
  addRooms('3', 'lab_network', 4, () => 40, [...labFeatures, 'network_rack']);
  addRooms('3', 'lab_ai', 3, () => 40, [...labFeatures, 'gpu_workstations']);
  addRooms('3', 'lab_graphic', 3, () => 40, [...labFeatures, 'pen_tablets']);
  addRooms('6', 'activity_yard', 2, (i) => [300, 500][i]!, ['outdoor'], true);
  // The largest hall hosts staff meetings on Friday mornings.
  rooms[rooms.findIndex((r) => r.type === 'lecture_hall' && r.capacity === 200)]!.unavailable = [1, 2, 3, 4].map((period) => ({
    day: 5,
    period,
  }));

  return buildScenario({
    code: 'Q21',
    name: 'Q21 — วิทยาลัยขนาดใหญ่ 10 แผนก 60 กลุ่มเรียน',
    description:
      'ชุดข้อมูลขนาดใหญ่: 10 แผนกวิชา (9 แผนกวิชาชีพ + สามัญสัมพันธ์), 60 กลุ่มเรียน, ครู 120 คน, ห้อง 70 ห้อง (ทฤษฎี/บรรยายรวม/ปฏิบัติการ/ลานกิจกรรม) ใน 6 อาคาร, 5 วัน × 8 คาบ, มีการเรียนรวมและแบ่งกลุ่มย่อย',
    seed,
    departments: [...vocational.map((code) => ({ code, name: DEPARTMENTS[code]!.name })), GEN_DEPT],
    buildings: [
      { code: '1', name: 'อาคาร 1 อาคารเรียนรวม 1' },
      { code: '2', name: 'อาคาร 2 อาคารเรียนรวม 2' },
      { code: '3', name: 'อาคาร 3 อาคารเทคโนโลยีสารสนเทศและคอมพิวเตอร์' },
      { code: '4', name: 'อาคาร 4 อาคารบริหารธุรกิจ' },
      { code: '5', name: 'อาคาร 5 อาคารช่างอุตสาหกรรม' },
      { code: '6', name: 'อาคาร 6 หอประชุมและลานกิจกรรม' },
    ],
    rooms,
    teachers,
    groups,
    coreEligibleCount: 3,
    combineSize: 3,
  });
}

export const SCENARIO_BUILDERS = { Q01: buildQ01, Q21: buildQ21 } as const;
export type ScenarioCode = keyof typeof SCENARIO_BUILDERS;

// ---------------------------------------------------------------------------
// Scenario → competition 7-CSV
// ---------------------------------------------------------------------------

function csvCell(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

const slotsCell = (slots: SlotRef[] | null) => (slots ?? []).map((s) => `${s.day}:${s.period}`).join(';');

/** Render a scenario as the 7 competition CSV files (English headers). */
export function scenarioToDataset7Files(scenario: ScenarioDataset): Record<Dataset7FileKey, string> {
  const t = scenario.tables;
  const deptCode = new Map(t.departments.map((d) => [d.id, d.code ?? '']));
  const deptName = new Map(t.departments.map((d) => [d.id, d.name]));
  const typeCode = new Map(t.room_types.map((r) => [r.id, r.code]));
  const typeName = new Map(t.room_types.map((r) => [r.id, r.name]));
  const buildingCode = new Map(t.buildings.map((b) => [b.id, b.code ?? '']));
  const groupCode = new Map(t.student_groups.map((g) => [g.id, g.groupCode]));
  const subjectCode = new Map(t.subjects.map((s) => [s.id, s.subjectCode]));
  const staffCode = new Map(t.staff.map((s) => [s.id, s.employeeCode]));

  const blocked = new Set<string>();
  for (const fb of t.fixed_blocks) {
    if (!fb.appliesTo.all) continue;
    for (let p = fb.startPeriod; p < fb.startPeriod + fb.duration; p++) blocked.add(`${fb.dayOfWeek}:${p}`);
  }
  const timeslotRows = t.time_slots
    .flatMap((ts) => ts.openDays.map((day) => ({ ts, day })))
    .sort((a, b) => a.day - b.day || a.ts.period - b.ts.period)
    .map(({ ts, day }) => [
      day,
      ts.period,
      ts.startTime.slice(0, 5),
      ts.endTime.slice(0, 5),
      ts.shift,
      blocked.has(`${day}:${ts.period}`) ? 'break' : 'class',
    ]);

  const groupsByOffering = new Map<string, string[]>();
  for (const og of t.offering_groups) {
    const list = groupsByOffering.get(og.offeringId) ?? [];
    list.push(groupCode.get(og.groupId)!);
    groupsByOffering.set(og.offeringId, list);
  }

  return {
    timeslot: toCsv(['day', 'period', 'start_time', 'end_time', 'shift', 'type'], timeslotRows),
    student_group: toCsv(
      ['group_code', 'group_name', 'department', 'level', 'year', 'student_count', 'lunch_period', 'allowed_days', 'unavailable_slots'],
      t.student_groups.map((g) => [
        g.groupCode,
        `${deptName.get(g.departmentId)?.replace('แผนกวิชา', '') ?? ''} ${g.level}${g.yearNo}`,
        deptCode.get(g.departmentId),
        g.level,
        g.yearNo,
        g.studentCount,
        g.lunchPeriod,
        g.allowedDays.join(';'),
        slotsCell(g.unavailableSlots),
      ]),
    ),
    register: toCsv(
      ['offering_code', 'subject_code', 'group_code', 'periods_per_week'],
      t.course_offerings.map((o, i) => [
        `R${pad(i + 1, 4)}`,
        subjectCode.get(o.subjectId),
        (groupsByOffering.get(o.id) ?? []).join(';'),
        o.periodsPerWeek,
      ]),
    ),
    subject: toCsv(
      ['subject_code', 'subject_name', 'theory_hours', 'practice_hours', 'credits', 'room_type', 'consecutive', 'category'],
      t.subjects.map((s) => [
        s.subjectCode,
        s.subjectName,
        s.theoryHours,
        s.practiceHours,
        s.credits,
        s.requiredRoomTypeId ? typeCode.get(s.requiredRoomTypeId) : '',
        s.mustBeConsecutive ? 'true' : 'false',
        s.category,
      ]),
    ),
    teacher: toCsv(
      ['teacher_code', 'full_name', 'department', 'max_weekly_periods', 'unavailable_slots'],
      t.staff.map((s) => [
        s.employeeCode,
        s.fullName,
        s.departmentId ? deptCode.get(s.departmentId) : '',
        s.maxWeeklyPeriods,
        slotsCell(s.unavailableSlots),
      ]),
    ),
    teach: toCsv(
      ['teacher_code', 'subject_code', 'group_code'],
      t.teacher_subject_eligibility.map((e) => [
        staffCode.get(e.staffId),
        subjectCode.get(e.subjectId),
        e.groupId ? groupCode.get(e.groupId) : '',
      ]),
    ),
    room: toCsv(
      ['room_code', 'room_name', 'building', 'capacity', 'room_type'],
      t.rooms.map((r) => [
        r.roomCode,
        `${typeName.get(r.roomTypeId)} ${r.roomCode}`,
        buildingCode.get(r.buildingId),
        r.capacity,
        typeCode.get(r.roomTypeId),
      ]),
    ),
  };
}
