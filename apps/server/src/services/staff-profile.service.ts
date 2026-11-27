/**
 * Personal profile & background of college staff. Kept outside the 30 scheduling tables and keyed by
 * employee_code, so profiles survive dataset re-imports / scenario reloads (which recreate staff ids).
 * The table is created on first use — no manual migration step on TiDB.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../db/client';

export interface StaffProfile {
  employeeCode: string;
  nickname: string | null;
  email: string | null;
  education: string | null;
  workHistory: string | null;
  expertise: string | null;
  bio: string | null;
  updatedAt: string | null;
}

export const PROFILE_FIELDS = ['nickname', 'email', 'education', 'workHistory', 'expertise', 'bio'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];
const COLUMN: Record<ProfileField, string> = {
  nickname: 'nickname',
  email: 'email',
  education: 'education',
  workHistory: 'work_history',
  expertise: 'expertise',
  bio: 'bio',
};

let ensured: Promise<unknown> | null = null;
const ensureTable = () =>
  (ensured ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS staff_profiles (
         employee_code VARCHAR(20) NOT NULL PRIMARY KEY,
         nickname VARCHAR(50) NULL,
         email VARCHAR(120) NULL,
         education TEXT NULL,
         work_history TEXT NULL,
         expertise TEXT NULL,
         bio TEXT NULL,
         updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       ) DEFAULT CHARSET=utf8mb4`,
    )
    .catch((e) => {
      ensured = null; // retry next time
      throw e;
    }));

const toProfile = (r: RowDataPacket): StaffProfile => ({
  employeeCode: String(r.employee_code),
  nickname: r.nickname ?? null,
  email: r.email ?? null,
  education: r.education ?? null,
  workHistory: r.work_history ?? null,
  expertise: r.expertise ?? null,
  bio: r.bio ?? null,
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
});

export async function getStaffProfile(employeeCode: string): Promise<StaffProfile | null> {
  await ensureTable();
  const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM staff_profiles WHERE employee_code = ?', [employeeCode]);
  return rows[0] ? toProfile(rows[0]) : null;
}

export async function saveStaffProfile(
  employeeCode: string,
  fields: Partial<Record<ProfileField, string | null>>,
): Promise<StaffProfile> {
  await ensureTable();
  const cols = PROFILE_FIELDS.map((f) => COLUMN[f]);
  const values = PROFILE_FIELDS.map((f) => {
    const v = fields[f]?.trim();
    return v ? v : null;
  });
  await pool.query(
    `INSERT INTO staff_profiles (employee_code, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    [employeeCode, ...values],
  );
  return (await getStaffProfile(employeeCode))!;
}

/** Latest timetable changes (audit log) touching any of the given schedule items. */
export async function getItemHistory(itemIds: string[], limit = 30) {
  if (itemIds.length === 0) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT entity_id, action, before_data, after_data, created_at FROM audit_logs
     WHERE entity = 'schedule_items' AND entity_id IN (?) ORDER BY created_at DESC LIMIT ?`,
    [itemIds, limit],
  );
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  return rows.map((r) => ({
    itemId: String(r.entity_id),
    action: String(r.action),
    before: json(r.before_data),
    after: json(r.after_data),
    at: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}
