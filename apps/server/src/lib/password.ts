import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;

/**
 * Hash a password with scrypt → `scrypt$N$r$p$<saltB64>$<hashB64>`.
 * Pass `salt` only for deterministic demo fixtures; real accounts should use a random salt.
 */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Deterministic hash for public demo accounts (same output on every generation run). */
export function hashDemoPassword(password: string, username: string): string {
  const salt = createHash('sha256').update(`ptc-smart-schedulev4|demo-salt|${username}`).digest().subarray(0, 16);
  return hashPassword(password, salt);
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
