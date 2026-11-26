/** Tolerant readers for `constraint_configs.params` (accepts several alias keys). */
import type { JsonObject } from '../types';

export function optNumParam(params: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export function numParam(params: JsonObject, keys: readonly string[], fallback: number): number {
  return optNumParam(params, keys) ?? fallback;
}

export function numListParam(params: JsonObject, keys: readonly string[], fallback: readonly number[]): number[] {
  for (const key of keys) {
    const v = params[key];
    if (Array.isArray(v)) {
      const nums = v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
      if (nums.length > 0) return nums;
    }
  }
  return [...fallback];
}

export function boolParam(params: JsonObject, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'boolean') return v;
  }
  return fallback;
}

export function recordParam(params: JsonObject, key: string): Record<string, unknown> {
  const v = params[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arrayParam(params: JsonObject, key: string): unknown[] {
  const v = params[key];
  return Array.isArray(v) ? v : [];
}

/** Sorted unique numbers. */
export function distinctSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Split sorted unique periods into runs of consecutive numbers. */
export function consecutiveRuns(sortedPeriods: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const p of sortedPeriods) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === p - 1) last.push(p);
    else runs.push([p]);
  }
  return runs;
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
