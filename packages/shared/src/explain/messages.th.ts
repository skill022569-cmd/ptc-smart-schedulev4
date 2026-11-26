/**
 * Deterministic Thai XAI messages. Every explanation shown to users is rendered from
 * these templates + JSON params produced by the Constraint Engine — never by an LLM.
 */
import type { TimeSlot } from '../types';

export type MessageParamValue = string | number | boolean | null;
export type MessageParams = Record<string, MessageParamValue>;

export const DAY_NAMES_TH: Readonly<Record<number, string>> = {
  1: 'จันทร์',
  2: 'อังคาร',
  3: 'พุธ',
  4: 'พฤหัสบดี',
  5: 'ศุกร์',
  6: 'เสาร์',
  7: 'อาทิตย์',
};

/** 1 → `จันทร์` … 7 → `อาทิตย์` (unknown days fall back to the number). */
export function dayNameTh(day: number): string {
  return DAY_NAMES_TH[day] ?? String(day);
}

const hhmm = (t: string) => (t.length >= 5 ? t.slice(0, 5) : t);

/**
 * `formatSlotTimeTh(1, 1, 2, slots)` → `วันจันทร์ คาบ 1–2 (08:00–10:00 น.)`;
 * a single period → `วันจันทร์ คาบ 3 (10:00–11:00 น.)`. Times are omitted when the
 * periods are not in `timeSlots`.
 */
export function formatSlotTimeTh(day: number, startPeriod: number, duration = 1, timeSlots: readonly TimeSlot[] = []): string {
  const end = startPeriod + Math.max(1, duration) - 1;
  const periodText = end > startPeriod ? `คาบ ${startPeriod}–${end}` : `คาบ ${startPeriod}`;
  const first = timeSlots.find((s) => s.period === startPeriod);
  const last = timeSlots.find((s) => s.period === end);
  const time = first && last ? ` (${hhmm(first.startTime)}–${hhmm(last.endTime)} น.)` : '';
  return `วัน${dayNameTh(day)} ${periodText}${time}`;
}

export const MESSAGE_TEMPLATES_TH: Readonly<Record<string, string>> = {
  // ---- Hard ---------------------------------------------------------------
  'H01.violation': 'ครู {teacher}ถูกจัดสอนซ้อนกัน {count} รายการใน{slot}',
  'H01.pass': 'ครูผู้สอนไม่มีคาบสอนซ้อนในช่วงเวลานี้',
  'H02.violation': 'ห้อง {room} ถูกใช้ซ้อนกัน {count} รายการใน{slot}',
  'H02.pass': 'ห้องเรียนไม่ถูกใช้ซ้อนในช่วงเวลานี้',
  'H03.violation': 'กลุ่มเรียน {group} มีวิชาเรียนซ้อนกัน {count} รายการใน{slot}',
  'H03.pass': 'กลุ่มเรียนไม่มีวิชาเรียนซ้อนในช่วงเวลานี้',
  'H04.violation': 'ห้อง {room} จุได้ {capacity} คน แต่วิชา {subject} มีผู้เรียน {students} คน ({slot})',
  'H04.shared': 'ห้อง {room} (ใช้ร่วมหลายกลุ่ม) จุได้ {capacity} คน แต่มีผู้เรียนรวม {students} คนจาก {count} รายการใน{slot}',
  'H04.pass': 'ความจุห้องเพียงพอต่อจำนวนผู้เรียน',
  'H05.violation': 'วิชา {subject} ต้องใช้ห้องประเภท {roomType} แต่จัดในห้อง {room} ({actualType}) {slot}',
  'H05.no_room': 'วิชา {subject} ต้องใช้ห้องประเภท {roomType} แต่ยังไม่ได้กำหนดห้อง ({slot})',
  'H05.pass': 'ประเภทห้องตรงกับที่รายวิชากำหนด',
  'H06.violation': 'วิชา {subject} ของกลุ่ม {group} ทับคาบพักกลางวัน (คาบ {lunchPeriod}) {slot}',
  'H06.pass': 'ไม่ทับคาบพักกลางวันของกลุ่มเรียน',
  'H07.slot_invalid': 'วิชา {subject} จัดใน{slot} ซึ่งคาบ {periods} ไม่เปิดสอนในวันนั้น',
  'H07.teacher': 'ครู {teacher}ไม่ว่างใน{slot} (คาบ {periods}) แต่ถูกจัดสอนวิชา {subject}',
  'H07.room': 'ห้อง {room} ไม่พร้อมใช้งานใน{slot} (คาบ {periods}) แต่ถูกจัดวิชา {subject}',
  'H07.pass': 'ครูและห้องว่างในช่วงเวลาที่เปิดสอน',
  'H08.violation': 'วิชา {subject} ({slot}) ทับคาบ "{block}" ({blockSlot}) ของ{target}',
  'H08.pass': 'ไม่ทับคาบกิจกรรมหรือคาบที่ล็อกไว้',
  'H09.out_of_day': 'วิชา {subject} ต้องเรียนต่อเนื่องแต่เกินคาบที่เปิดสอน ({slot}, คาบ {periods}; คาบสุดท้ายคือ {maxPeriod})',
  'H09.cross_lunch': 'วิชา {subject} เรียนต่อเนื่องคร่อมพักกลางวันของกลุ่ม {group} (คาบ {lunchPeriod}) {slot}',
  'H09.cross_shift': 'วิชา {subject} เรียนต่อเนื่องคร่อมภาคปกติและภาคค่ำ {slot}',
  'H09.not_contiguous': 'วิชา {subject} ต้องเรียนต่อเนื่อง แต่ถูกแบ่งเป็น {count} ช่วงที่ไม่ติดกัน: {slots}',
  'H09.pass': 'คาบเรียนต่อเนื่องอยู่ในวันเดียวกันและไม่คร่อมพักกลางวัน',
  'H10.day': 'กลุ่ม {group} ไม่มีเรียนในวัน{day} แต่ถูกจัด{slot}',
  'H10.shift': 'กลุ่ม {group} เรียนได้เฉพาะ{shift} แต่ถูกจัด{slot} (คาบ {periods})',
  'H10.pass': 'อยู่ในวันและภาคเรียนที่กลุ่มเรียนได้',
  'H11.violation': 'วิชา {subject} ({slot}) เป็นการสอนร่วม แต่ยังขาดครู {missing} (ต้องมี {required} คน, จัดแล้ว {assigned} คน)',
  'H11.pass': 'ครูผู้สอนร่วมอยู่ครบในคาบเดียวกัน',
  'H12.violation': '{who} ต้องย้ายจาก{fromBuilding}ไป{toBuilding}โดยไม่มีคาบเว้น ({slot}; ต้องเว้น {gap} คาบ, เว้นจริง {free} คาบ)',
  'H12.pass': 'มีเวลาเดินทางเพียงพอเมื่อย้ายอาคาร',
  'H13.violation': 'ครู {teacher}สอนวัน{day} {count} คาบ เกินสูงสุด {max} คาบต่อวัน',
  'H13.pass': 'ภาระสอนต่อวันของครูไม่เกินที่กำหนด',
  'H14.violation': 'ครู {teacher}สอนต่อเนื่อง {count} คาบ ({slot}) เกินสูงสุด {max} คาบ',
  'H14.pass': 'ครูสอนต่อเนื่องไม่เกินที่กำหนด',
  'H15.violation': 'ครู {teacher}หยุดประจำวัน{day} แต่ถูกจัดสอนวิชา {subject} {slot}',
  'H15.pass': 'ไม่ตรงกับวันหยุดของครู',
  'H16.violation': 'ครู {teacher}สอนทั้งภาคปกติและภาคค่ำ {count} วัน ({days}) เกินสูงสุด {max} วัน',
  'H16.pass': 'จำนวนวันที่สอนต่อภาคค่ำไม่เกินที่กำหนด',
  'H17.violation': 'วิชาเลือก {elective} ชนกับวิชา {compulsory} ของนักเรียน {students} คน ({slot})',
  'H17.pass': 'วิชาเลือกไม่ชนกับวิชาบังคับของนักเรียน',
  'H18.unknown_offering': 'รายการในตารางอ้างถึงรายวิชาที่ไม่ได้ลงทะเบียน ({offeringId})',
  'H18.wrong_term': 'วิชา {subject} ไม่ได้เปิดในภาคเรียนนี้',
  'H18.no_group': 'วิชา {subject} ยังไม่มีกลุ่มเรียนที่ลงทะเบียน',
  'H18.subgroup_mismatch': 'วิชา {subject} ถูกจัดให้ {subgroup} ซึ่งไม่ได้ลงทะเบียนวิชานี้',
  'H18.pass': 'เป็นรายวิชาที่ลงทะเบียนในภาคเรียนนี้',
  'H19.violation': 'ครู {teacher}ไม่มีสิทธิ์สอนวิชา {subject} ({slot})',
  'H19.no_teacher': 'วิชา {subject} ({slot}) ยังไม่มีครูผู้สอน',
  'H19.pass': 'ครูผู้สอนมีสิทธิ์สอนรายวิชานี้',
  'H20.unplaced': 'วิชา {subject} ({duration} คาบ) ยังอยู่ในถาดรอจัด',
  'H20.invalid_slot': 'วิชา {subject} จัดในช่วงเวลาที่ไม่เปิดสอน ({slot})',
  'H20.incomplete': 'วิชา {subject} ({track}) จัดได้ {scheduled} จาก {required} คาบต่อสัปดาห์',
  'H20.excess': 'วิชา {subject} ({track}) จัด {scheduled} คาบ เกินกว่าที่ลงทะเบียน {required} คาบต่อสัปดาห์',
  'H20.pass': 'จัดชั่วโมงครบตามที่ลงทะเบียน',
  'H21.slot_invalid': 'วิชา {subject} จัดใน{slot} ซึ่งคาบ {periods} ไม่เปิดสอนในวันนั้น',
  'H21.violation': 'กลุ่ม {group} ไม่ว่างใน{slot} (คาบ {periods}) แต่ถูกจัดวิชา {subject}',
  'H21.pass': 'อยู่ในช่วงเวลาที่กลุ่มเรียนว่าง',
  // ---- Soft ---------------------------------------------------------------
  'S01.violation': 'กลุ่ม {group} มีคาบว่างระหว่างวัน{day} {gaps} คาบ (คาบ {periods})',
  'S01.pass': 'ไม่มีคาบว่างแทรกระหว่างวันของกลุ่มเรียน',
  'S02.same_day': 'วิชา {subject} มีหลายส่วนอยู่วัน{dayA}เดียวกัน',
  'S02.adjacent_day': 'วิชา {subject} อยู่วัน{dayA}และวัน{dayB}ซึ่งติดกัน',
  'S02.pass': 'รายวิชากระจายตลอดสัปดาห์',
  'S03.violation': 'วิชา {subject} ควรเรียน{preference} แต่จัด{slot} (คาบ {periods})',
  'S03.pass': 'ตรงกับช่วงเวลาที่รายวิชาต้องการ',
  'S04.violation': 'ห้อง {room} จุ {capacity} คน แต่วิชา {subject} มีผู้เรียน {students} คน (ที่นั่งว่าง {wasted} ที่)',
  'S04.pass': 'ขนาดห้องเหมาะสมกับจำนวนผู้เรียน',
  'S05.violation': 'ครู {teacher}ไม่มีเวลาพักกลางวันในวัน{day} (สอนครบคาบ {window})',
  'S05.pass': 'ครูมีเวลาพักกลางวัน',
  'S06.violation': 'ครู {teacher}สอนวัน{day} {count} คาบ ต่อเนื่องสูงสุด {longest} คาบ (ควรไม่เกิน {maxConsecutive} คาบติด และ {maxDaily} คาบต่อวัน)',
  'S06.pass': 'ภาระสอนของครูเหมาะสม',
  'S07.changed': 'วิชา {subject} ย้ายจาก{before} ไปเป็น{after}',
  'S07.added': 'วิชา {subject} เป็นรายการใหม่ ({after})',
  'S07.removed': 'วิชา {subject} ถูกนำออกจากตารางเดิม ({before})',
  'S07.pass': 'ตรงกับตารางเดิม',
  'S08.violation': 'ครู {teacher}มีคาบว่างระหว่างวัน{day} {gaps} คาบ (คาบ {periods})',
  'S08.pass': 'ครูไม่มีคาบว่างแทรกระหว่างวัน',
  'S09.violation': 'กลุ่ม {group} เรียนทฤษฎีติดกัน {count} คาบ ({slot}) เกิน {max} คาบ',
  'S09.pass': 'ไม่เรียนทฤษฎีติดกันนานเกินไป',
  'S10.violation': 'กลุ่ม {group} ต้องย้ายห้อง {count} ครั้งในวัน{day} ({rooms})',
  'S10.pass': 'กลุ่มเรียนย้ายห้องน้อย',
  'S11.segment_order': 'วิชา {subject} ส่วนที่ {first} ({slotA}) ควรเรียนก่อนส่วนที่ {second} ({slotB})',
  'S11.sequence': 'กลุ่ม {group} ควรเรียน {before} ({slotBefore}) ก่อน {after} ({slotAfter})',
  'S11.pass': 'ลำดับเนื้อหาถูกต้อง',
  'S12.violation': 'กลุ่ม {group} อยู่วิทยาลัยวัน{day} {span} คาบ (เรียนจริง {scheduled} คาบ) เกิน {max} คาบ',
  'S12.pass': 'ช่วงเวลาเรียนต่อวันเหมาะสม',
  'S13.violation': 'กลุ่ม {group} มีจำนวนคาบต่อวันไม่สมดุล ({counts}; เฉลี่ย {avg} คาบ)',
  'S13.pass': 'จำนวนคาบต่อวันสมดุล',
  // ---- Summaries ----------------------------------------------------------
  'soft.summary': '{name}: พบ {count} รายการ คะแนนปรับ {raw} × น้ำหนัก {weight} = {weighted}',
  'hard.summary': '{name}: ละเมิด {count} รายการ',
};

function formatValue(v: MessageParamValue | undefined): string {
  if (v === undefined || v === null || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'ใช่' : 'ไม่ใช่';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return v;
}

/** Render a template key with params. Unknown keys fall back to `<code>.violation`. */
export function renderMessageTh(messageKey: string, params: MessageParams = {}): string {
  const code = messageKey.split('.')[0];
  const template = MESSAGE_TEMPLATES_TH[messageKey] ?? MESSAGE_TEMPLATES_TH[`${code}.violation`] ?? `${messageKey}`;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => formatValue(params[name]));
}

export function hasTemplateTh(messageKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATES_TH, messageKey);
}
