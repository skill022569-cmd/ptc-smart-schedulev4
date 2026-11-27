import type { AccountRole, XaiExplanationEntry } from '@ptc/shared';
import type {
  AuthSession,
  BenchmarkResultRow,
  ChallengeApplyResponse,
  ChallengeCategory,
  ChallengeImpactResponse,
  ChallengeMode,
  ChallengeRule,
  DashboardData,
  Dataset7ValidationResult,
  FixOption,
  IssueCategory,
  IssueReport,
  RunResponse,
  ScenarioCatalogItem,
  ScheduleWorkspacePayload,
  SchedulingAlgorithm,
  SchedulingRun,
} from '../types/ui';

const TOKEN_KEY = 'ptc_v4_token';
const DEMO_ROLE_KEY = 'ptc_v4_demo_role';
const CACHE_TTL_MS = 30_000;
const GET_TIMEOUT_MS = 25_000;
const MUTATE_TIMEOUT_MS = 55_000;

interface CacheEntry {
  data: unknown;
  ts: number;
}

const responseCache = new Map<string, CacheEntry>();
const inFlightGets = new Map<string, Promise<unknown>>();
let cacheEpoch = 0;

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  invalidateApiCache();
}

export function getDemoRole(): AccountRole {
  return (localStorage.getItem(DEMO_ROLE_KEY) as AccountRole | null) ?? 'admin';
}

export function setDemoRole(role: AccountRole): void {
  localStorage.setItem(DEMO_ROLE_KEY, role);
  invalidateApiCache();
}

function authScopeKey(): string {
  return `${getDemoRole()}|${getStoredToken() ? 'jwt' : 'anon'}`;
}

function makeCacheKey(url: string): string {
  return `${cacheEpoch}|${authScopeKey()}|${url}`;
}

export function invalidateApiCache(): void {
  cacheEpoch++;
  responseCache.clear();
  inFlightGets.clear();
}

export function getCachedValue<T>(url: string): T | null {
  const entry = responseCache.get(makeCacheKey(url));
  return entry ? (entry.data as T) : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function rawRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const isGet = method === 'GET';
  const timeoutMs = isGet ? GET_TIMEOUT_MS : MUTATE_TIMEOUT_MS;
  const maxAttempts = isGet ? 2 : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-demo-role': getDemoRole(),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const token = getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = (data as { error?: string }).error || `HTTP ${res.status}`;
        if (isGet && isRetryableStatus(res.status) && attempt < maxAttempts) {
          await sleep(350);
          continue;
        }
        throw new Error(errMsg);
      }
      return data as T;
    } catch (err) {
      lastError = err;
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (isAbort) {
        lastError = new Error('คำขอใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง');
      }
      if (isGet && attempt < maxAttempts) {
        await sleep(350);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Request failed');
}

async function cachedGet<T>(url: string, options: { force?: boolean } = {}): Promise<T> {
  const key = makeCacheKey(url);
  if (!options.force) {
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return hit.data as T;
    }
  }

  const inflight = inFlightGets.get(key);
  if (inflight) return inflight as Promise<T>;

  const startEpoch = cacheEpoch;
  const p = rawRequest<T>(url)
    .then((data) => {
      if (cacheEpoch === startEpoch) {
        responseCache.set(`${startEpoch}|${authScopeKey()}|${url}`, { data, ts: Date.now() });
      }
      return data;
    })
    .finally(() => {
      inFlightGets.delete(key);
    });

  inFlightGets.set(key, p);
  return p;
}

async function mutateRequest<T>(url: string, init: RequestInit, skipInvalidate = false): Promise<T> {
  const result = await rawRequest<T>(url, init);
  if (!skipInvalidate) invalidateApiCache();
  return result;
}

const PREFETCHED_CHUNKS = new Set<string>();

export const api = {
  getCachedDashboard: (profile = 'competition') =>
    getCachedValue<DashboardData>(`/api/dashboard?profile=${encodeURIComponent(profile)}`),
  getCachedScheduleLatest: (profile = 'competition') =>
    getCachedValue<ScheduleWorkspacePayload>(`/api/schedule/latest?profile=${encodeURIComponent(profile)}`),
  getCachedRuns: () => getCachedValue<{ runs: SchedulingRun[]; profiles: string[] }>('/api/runs'),
  getCachedScenarios: () =>
    getCachedValue<{ scenarios: ScenarioCatalogItem[]; currentCounts: Record<string, number> }>('/api/scenarios'),
  getCachedChallengeRules: () => getCachedValue<{ rules: ChallengeRule[] }>('/api/challenge/rules'),
  getCachedIssues: () => getCachedValue<{ issues: IssueReport[] }>('/api/issues'),

  prefetchTab: (tab: string, profile = 'competition') => {
    if (!PREFETCHED_CHUNKS.has(tab)) {
      PREFETCHED_CHUNKS.add(tab);
      switch (tab) {
        case 'import':
          void import('../pages/ImportPage');
          break;
        case 'scenarios':
          void import('../pages/ScenariosPage');
          break;
        case 'runs':
          void import('../pages/RunCenterPage');
          break;
        case 'quality':
          void import('../pages/QualitySummaryPage');
          break;
        case 'workspace':
          void import('../pages/WorkspacePage');
          break;
        case 'views':
          void import('../pages/TimetableViewsPage');
          break;
        case 'challenge':
          void import('../pages/ChallengeLabPage');
          break;
        case 'benchmark':
          void import('../pages/BenchmarkPage');
          break;
        case 'issues':
          void import('../pages/IssueReportPage');
          break;
      }
    }
    switch (tab) {
      case 'dashboard':
        void api.dashboard(profile).catch(() => undefined);
        break;
      case 'scenarios':
        void api.scenarios().catch(() => undefined);
        break;
      case 'runs':
        void api.runs().catch(() => undefined);
        break;
      case 'quality':
      case 'workspace':
      case 'views':
        void api.scheduleLatest(profile).catch(() => undefined);
        break;
      case 'challenge':
        void api.challengeRules().catch(() => undefined);
        break;
      case 'issues':
        void api.issues().catch(() => undefined);
        void api.scheduleLatest(profile).catch(() => undefined);
        break;
    }
  },

  health: (force = false) =>
    cachedGet<{ ok: boolean; app: string; database: string; dbVersion: string; tableCount: number; publicDemoMode: boolean }>(
      '/api/health',
      { force },
    ),
  me: (force = false) => cachedGet<AuthSession>('/api/auth/me', { force }),
  login: (username: string, password: string) =>
    mutateRequest<{ token: string; user: AuthSession['user'] }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  dashboard: (profile = 'competition', force = false) =>
    cachedGet<DashboardData>(`/api/dashboard?profile=${encodeURIComponent(profile)}`, { force }),
  scenarios: (force = false) =>
    cachedGet<{ scenarios: ScenarioCatalogItem[]; currentCounts: Record<string, number> }>('/api/scenarios', { force }),
  loadScenario: (code: string, autoRun = true, profileName = 'competition') =>
    mutateRequest<{ ok: boolean; requestedCode: string; loadedDataset: string; totalRows: number; durationMs: number }>(
      `/api/scenarios/${encodeURIComponent(code)}/load`,
      { method: 'POST', body: JSON.stringify({ autoRun, profileName }) },
    ),
  importTemplates: () =>
    cachedGet<{ files: Record<string, string>; defaultMapping: Record<string, Record<string, string[]>> }>(
      '/api/import/templates',
    ),
  importPreview: (files: Record<string, string>, mapping?: Record<string, Record<string, string[]>>) =>
    mutateRequest<{ validation: Dataset7ValidationResult }>(
      '/api/import/preview',
      { method: 'POST', body: JSON.stringify({ files, mapping }) },
      true,
    ),
  importCommit: (files: Record<string, string>, mapping?: Record<string, Record<string, string[]>>, force = false) =>
    mutateRequest<{ ok: boolean; jobId: string; counts: Record<string, number> }>('/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ files, mapping, force }),
    }),
  runs: (force = false) => cachedGet<{ runs: SchedulingRun[]; profiles: string[] }>('/api/runs', { force }),
  runSolver: (body: {
    algorithm: SchedulingAlgorithm;
    profileName: string;
    seed: number;
    maxIterations: number;
    timeLimitSec: number;
  }) => mutateRequest<RunResponse>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  scheduleLatest: (profile = 'competition', force = false) =>
    cachedGet<ScheduleWorkspacePayload>(`/api/schedule/latest?profile=${encodeURIComponent(profile)}`, { force }),
  scheduleByVersion: (versionId: string, profile = 'competition') =>
    cachedGet<ScheduleWorkspacePayload>(
      `/api/schedule/${encodeURIComponent(versionId)}?profile=${encodeURIComponent(profile)}`,
    ),
  explainItem: (versionId: string, itemId: string, profile = 'competition') =>
    cachedGet<{ itemId: string; explanations: XaiExplanationEntry[] }>(
      `/api/schedule/${encodeURIComponent(versionId)}/items/${encodeURIComponent(itemId)}/explain?profile=${encodeURIComponent(profile)}`,
    ),
  moveItem: (
    versionId: string,
    itemId: string,
    patch: { dayOfWeek?: number | null; startPeriod?: number | null; roomId?: string | null; isLocked?: boolean; status?: 'scheduled' | 'unplaced_tray' },
  ) =>
    mutateRequest<{ item: unknown; report: ScheduleWorkspacePayload['report']; qualitySummary: ScheduleWorkspacePayload['qualitySummary'] }>(
      `/api/schedule/${encodeURIComponent(versionId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  fixOptions: (versionId: string, itemId: string, profileName = 'competition') =>
    mutateRequest<{ options: FixOption[] }>(
      `/api/schedule/${encodeURIComponent(versionId)}/items/${encodeURIComponent(itemId)}/fix-options`,
      { method: 'POST', body: JSON.stringify({ profileName }) },
      true,
    ),
  challengeRules: (force = false) => cachedGet<{ rules: ChallengeRule[] }>('/api/challenge/rules', { force }),
  addChallengeRule: (body: {
    category: ChallengeCategory;
    ruleType: string;
    target: Record<string, unknown>;
    params: Record<string, unknown>;
    mode: ChallengeMode;
    description: string;
  }) => mutateRequest<{ rule: ChallengeRule }>('/api/challenge/rules', { method: 'POST', body: JSON.stringify(body) }),
  deleteChallengeRule: (id: string) =>
    mutateRequest<{ ok: boolean }>(`/api/challenge/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  evaluateChallenge: (profileName = 'competition') =>
    mutateRequest<ChallengeImpactResponse>(
      '/api/challenge/evaluate',
      { method: 'POST', body: JSON.stringify({ profileName }) },
      true,
    ),
  applyChallenge: (strategy: 'repair' | 'full_resolve', profileName = 'competition') =>
    mutateRequest<ChallengeApplyResponse>('/api/challenge/apply', {
      method: 'POST',
      body: JSON.stringify({ strategy, profileName }),
    }),
  issues: (force = false) => cachedGet<{ issues: IssueReport[] }>('/api/issues', { force }),
  createIssue: (body: {
    category: IssueCategory;
    affectedDate: string;
    affectedStaffId?: string | null;
    affectedRoomId?: string | null;
    description: string;
  }) => mutateRequest<{ issue: IssueReport; proposal: unknown }>('/api/issues', { method: 'POST', body: JSON.stringify(body) }),
  applyIssue: (id: string, optionIndex = 0) =>
    mutateRequest<{ ok: boolean; appliedCount: number; action: string }>(
      `/api/issues/${encodeURIComponent(id)}/apply`,
      { method: 'POST', body: JSON.stringify({ optionIndex }) },
    ),
  runBenchmark: (body: { algorithms: string[]; profiles: string[]; seeds: number[]; maxIterations: number; timeLimitSec?: number }) =>
    mutateRequest<{ results: BenchmarkResultRow[] }>(
      '/api/benchmark',
      { method: 'POST', body: JSON.stringify(body) },
      true,
    ),
  exportUrl: (versionId: string, format: 'output' | 'csv' | 'excel' | 'pdf', view = 'master', targetId?: string) => {
    const q = new URLSearchParams({ view });
    if (targetId) q.set('targetId', targetId);
    return `/api/export/${encodeURIComponent(versionId)}/${format}?${q.toString()}`;
  },
};
