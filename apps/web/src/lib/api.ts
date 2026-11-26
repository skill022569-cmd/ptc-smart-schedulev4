import type {
  AccountRole,
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

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getDemoRole(): AccountRole {
  return (localStorage.getItem(DEMO_ROLE_KEY) as AccountRole | null) ?? 'admin';
}

export function setDemoRole(role: AccountRole): void {
  localStorage.setItem(DEMO_ROLE_KEY, role);
}

async function req<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-demo-role': getDemoRole(),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  health: () =>
    req<{ ok: boolean; app: string; database: string; dbVersion: string; tableCount: number; publicDemoMode: boolean }>(
      '/api/health',
    ),
  me: () => req<AuthSession>('/api/auth/me'),
  login: (username: string, password: string) =>
    req<{ token: string; user: AuthSession['user'] }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  dashboard: (profile = 'competition') => req<DashboardData>(`/api/dashboard?profile=${encodeURIComponent(profile)}`),
  scenarios: () => req<{ scenarios: ScenarioCatalogItem[]; currentCounts: Record<string, number> }>('/api/scenarios'),
  loadScenario: (code: string, autoRun = true, profileName = 'competition') =>
    req<{ ok: boolean; requestedCode: string; loadedDataset: string; totalRows: number; durationMs: number }>(
      `/api/scenarios/${encodeURIComponent(code)}/load`,
      { method: 'POST', body: JSON.stringify({ autoRun, profileName }) },
    ),
  importTemplates: () =>
    req<{ files: Record<string, string>; defaultMapping: Record<string, Record<string, string[]>> }>(
      '/api/import/templates',
    ),
  importPreview: (files: Record<string, string>, mapping?: Record<string, Record<string, string[]>>) =>
    req<{ validation: Dataset7ValidationResult }>('/api/import/preview', {
      method: 'POST',
      body: JSON.stringify({ files, mapping }),
    }),
  importCommit: (files: Record<string, string>, mapping?: Record<string, Record<string, string[]>>, force = false) =>
    req<{ ok: boolean; jobId: string; counts: Record<string, number> }>('/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ files, mapping, force }),
    }),
  runs: () => req<{ runs: SchedulingRun[]; profiles: string[] }>('/api/runs'),
  runSolver: (body: {
    algorithm: SchedulingAlgorithm;
    profileName: string;
    seed: number;
    maxIterations: number;
    timeLimitSec: number;
  }) => req<RunResponse>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  scheduleLatest: (profile = 'competition') =>
    req<ScheduleWorkspacePayload>(`/api/schedule/latest?profile=${encodeURIComponent(profile)}`),
  scheduleByVersion: (versionId: string, profile = 'competition') =>
    req<ScheduleWorkspacePayload>(`/api/schedule/${encodeURIComponent(versionId)}?profile=${encodeURIComponent(profile)}`),
  moveItem: (
    versionId: string,
    itemId: string,
    patch: { dayOfWeek?: number | null; startPeriod?: number | null; roomId?: string | null; isLocked?: boolean; status?: 'scheduled' | 'unplaced_tray' },
  ) =>
    req<{ item: unknown; report: ScheduleWorkspacePayload['report']; qualitySummary: ScheduleWorkspacePayload['qualitySummary'] }>(
      `/api/schedule/${encodeURIComponent(versionId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  fixOptions: (versionId: string, itemId: string, profileName = 'competition') =>
    req<{ options: FixOption[] }>(
      `/api/schedule/${encodeURIComponent(versionId)}/items/${encodeURIComponent(itemId)}/fix-options`,
      { method: 'POST', body: JSON.stringify({ profileName }) },
    ),
  challengeRules: () => req<{ rules: ChallengeRule[] }>('/api/challenge/rules'),
  addChallengeRule: (body: {
    category: ChallengeCategory;
    ruleType: string;
    target: Record<string, unknown>;
    params: Record<string, unknown>;
    mode: ChallengeMode;
    description: string;
  }) => req<{ rule: ChallengeRule }>('/api/challenge/rules', { method: 'POST', body: JSON.stringify(body) }),
  deleteChallengeRule: (id: string) => req<{ ok: boolean }>(`/api/challenge/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  evaluateChallenge: (profileName = 'competition') =>
    req<ChallengeImpactResponse>('/api/challenge/evaluate', { method: 'POST', body: JSON.stringify({ profileName }) }),
  applyChallenge: (strategy: 'repair' | 'full_resolve', profileName = 'competition') =>
    req<ChallengeApplyResponse>('/api/challenge/apply', { method: 'POST', body: JSON.stringify({ strategy, profileName }) }),
  issues: () => req<{ issues: IssueReport[] }>('/api/issues'),
  createIssue: (body: {
    category: IssueCategory;
    affectedDate: string;
    affectedStaffId?: string | null;
    affectedRoomId?: string | null;
    description: string;
  }) => req<{ issue: IssueReport; proposal: unknown }>('/api/issues', { method: 'POST', body: JSON.stringify(body) }),
  applyIssue: (id: string, optionIndex = 0) =>
    req<{ ok: boolean; appliedCount: number; action: string }>(`/api/issues/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ optionIndex }),
    }),
  runBenchmark: (body: { algorithms: string[]; profiles: string[]; seeds: number[]; maxIterations: number }) =>
    req<{ results: BenchmarkResultRow[] }>('/api/benchmark', { method: 'POST', body: JSON.stringify(body) }),
  exportUrl: (versionId: string, format: 'csv' | 'excel' | 'pdf', view = 'master', targetId?: string) => {
    const q = new URLSearchParams({ view });
    if (targetId) q.set('targetId', targetId);
    return `/api/export/${encodeURIComponent(versionId)}/${format}?${q.toString()}`;
  },
};
