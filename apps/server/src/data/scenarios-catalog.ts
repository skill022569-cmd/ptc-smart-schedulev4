export interface ScenarioCatalogItem {
  code: string;
  title: string;
  focus: string;
  demonstration: string;
  loadableDataset: 'Q01' | 'Q21';
}

export const SCENARIOS_CATALOG_25: readonly ScenarioCatalogItem[] = [
  { code: 'Q01', title: 'ตารางพื้นฐาน 1 แผนก', focus: 'time_slots (8 คาบ), H01–H05', demonstration: 'ตาราง 4 กลุ่ม ข้อขัดแย้ง = 0', loadableDataset: 'Q01' },
  { code: 'Q02', title: 'พักกลางวันเหลื่อมเวลา', focus: 'lunch_period, H06, S05', demonstration: 'คาบ 4 ของ ปวช. และคาบ 5 ของ ปวส. ว่าง', loadableDataset: 'Q01' },
  { code: 'Q03', title: 'ล็อกคาบกิจกรรม', focus: 'fixed_blocks, allow_multi_group, H08', demonstration: 'ทุกกลุ่มอยู่ลานกิจกรรมวันพุธคาบ 7–8', loadableDataset: 'Q01' },
  { code: 'Q04', title: 'ปฏิบัติ 3 คาบติด', focus: 'must_be_consecutive, H09', demonstration: 'บล็อก 3 คาบไม่คร่อมคาบพัก', loadableDataset: 'Q01' },
  { code: 'Q05', title: 'ครูพิเศษ', focus: 'available_slots, H07', demonstration: 'ครูสอนได้เฉพาะวัน/เวลาที่กำหนด (Whitelist)', loadableDataset: 'Q01' },
  { code: 'Q06', title: 'ความจุห้อง', focus: 'H04, S04', demonstration: 'กลุ่ม 20–42 คนลงห้อง 25/35/45 ที่นั่งพอดี', loadableDataset: 'Q01' },
  { code: 'Q07', title: 'ประเภทแล็บ', focus: 'room_types, H05', demonstration: 'วิชาปฏิบัติ/AI ลง Lab เฉพาะทาง', loadableDataset: 'Q01' },
  { code: 'Q08', title: 'เดินทางระหว่างอาคาร', focus: 'buildings, H12', demonstration: 'ไม่มีคาบติดกันข้ามอาคาร', loadableDataset: 'Q01' },
  { code: 'Q09', title: 'ชั่วโมงสอนสูงสุด', focus: 'H13, H14', demonstration: 'ภาระงานครูรายวัน/สอนติดไม่เกินเกณฑ์', loadableDataset: 'Q01' },
  { code: 'Q10', title: 'วันหยุดเตรียมการสอน', focus: 'day_off, H15', demonstration: 'ตารางครูว่างทั้งวันในวันหยุดที่ขอ', loadableDataset: 'Q01' },
  { code: 'Q11', title: 'เรียนรวม', focus: 'offering_groups, H04', demonstration: '2 กลุ่มในห้องใหญ่', loadableDataset: 'Q21' },
  { code: 'Q12', title: 'แบ่งกลุ่มย่อย', focus: 'subgroups, H03', demonstration: 'Group A/B เรียนพร้อมกันคนละห้อง', loadableDataset: 'Q01' },
  { code: 'Q13', title: 'สอนร่วม', focus: 'offering_teachers, H11', demonstration: 'ครู 2 คนสอนร่วมคาบเดียวกัน', loadableDataset: 'Q01' },
  { code: 'Q14', title: 'ทวิภาคี', focus: 'allowed_days, H10', demonstration: 'ตารางกลุ่มทวิภาคีว่างพฤหัสฯ–ศุกร์', loadableDataset: 'Q21' },
  { code: 'Q15', title: 'วิชาเลือกเสรี', focus: 'students, elective_enrollments, H17', demonstration: 'วิชาเลือกไม่ชนวิชาบังคับ', loadableDataset: 'Q01' },
  { code: 'Q16', title: 'ลดคาบว่าง', focus: 'S01', demonstration: 'จำนวนคาบว่างก่อน/หลัง Optimize', loadableDataset: 'Q01' },
  { code: 'Q17', title: 'กระจายวิชา', focus: 'S02', demonstration: 'วิชา 2+2 กระจายวันไม่ติดกัน', loadableDataset: 'Q01' },
  { code: 'Q18', title: 'ช่วงเวลาเหมาะสม', focus: 'time_preference, S03', demonstration: 'วิชาที่ได้ช่วงเช้า/บ่ายตามต้องการ', loadableDataset: 'Q01' },
  { code: 'Q19', title: 'Dirty Data', focus: 'import_jobs, PlannerAgent', demonstration: 'รายการปัญหา + ปุ่มทางแก้ภาษาไทย', loadableDataset: 'Q01' },
  { code: 'Q20', title: 'Auto-Reschedule ฉุกเฉิน', focus: 'issue_reports, schedule_exceptions, S07', demonstration: 'ครูลา/แล็บไฟดับ พร้อมจำนวนคาบที่ย้าย', loadableDataset: 'Q01' },
  { code: 'Q21', title: 'ข้อมูลขนาดใหญ่', focus: '60 กลุ่ม / 120 ครู / 70 ห้อง', demonstration: 'จัดตารางใหญ่เสร็จในเวลา < 3 นาที', loadableDataset: 'Q21' },
  { code: 'Q22', title: 'ภาคค่ำ/เสาร์-อาทิตย์', focus: 'time_slots คาบ 10–12, H16', demonstration: 'ครูสอนต่อภาคค่ำไม่เกิน 2 วัน', loadableDataset: 'Q01' },
  { code: 'Q23', title: 'Multi-Objective', focus: 'Profile teacher_first vs room_first', demonstration: 'กราฟเทียบเน้นครู vs เน้นห้อง', loadableDataset: 'Q01' },
  { code: 'Q24', title: 'XAI อธิบายเหตุผล', focus: 'schedule_items.explanation, XAI', demonstration: 'เหตุผลทั้งตอนจัดได้และจัดไม่ได้ + PDF', loadableDataset: 'Q01' },
  { code: 'Q25', title: 'Benchmark', focus: 'scheduling_runs (หลาย Seed)', demonstration: 'ตารางเทียบ Greedy vs CSP+GA (Mean ± SD)', loadableDataset: 'Q01' },
];
