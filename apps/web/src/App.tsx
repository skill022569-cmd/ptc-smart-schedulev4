import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  Calendar,
  Database,
  FileSpreadsheet,
  FolderKanban,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  MessageSquareWarning,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { api, getDemoRole, getStoredToken, setDemoRole, setStoredToken } from './lib/api';
import type { AccountRole } from '@ptc/shared';
import type { AuthSession } from './types/ui';
import { BenchmarkPage } from './pages/BenchmarkPage';
import { ChallengeLabPage } from './pages/ChallengeLabPage';
import { DashboardPage } from './pages/DashboardPage';
import { ImportPage } from './pages/ImportPage';
import { IssueReportPage } from './pages/IssueReportPage';
import { QualitySummaryPage } from './pages/QualitySummaryPage';
import { RunCenterPage } from './pages/RunCenterPage';
import { ScenariosPage } from './pages/ScenariosPage';
import { TimetableViewsPage } from './pages/TimetableViewsPage';
import { WorkspacePage } from './pages/WorkspacePage';

interface NavItem {
  id: string;
  label: string;
  shortLabel: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'ภาพรวมระบบ', shortLabel: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'import', label: 'นำเข้า 7 CSV & Data Check', shortLabel: 'นำเข้า CSV', icon: <FileSpreadsheet className="h-4 w-4" /> },
  { id: 'scenarios', label: 'โจทย์จำลอง Q01–Q25', shortLabel: 'Q01–Q25', icon: <FolderKanban className="h-4 w-4" /> },
  { id: 'runs', label: 'ศูนย์จัดตาราง & อัลกอริทึม', shortLabel: 'รันจัดตาราง', icon: <PlayCircle className="h-4 w-4" /> },
  { id: 'quality', label: 'สรุปผลตรวจ 4 ด้าน', shortLabel: 'สรุป 4 ด้าน', icon: <ShieldCheck className="h-4 w-4" /> },
  { id: 'workspace', label: 'ปรับแก้ตาราง (ลากวาง)', shortLabel: 'Workspace', icon: <Wrench className="h-4 w-4" /> },
  { id: 'views', label: 'ดูตาราง & Export PDF/Excel', shortLabel: 'ดู & Export', icon: <Calendar className="h-4 w-4" /> },
  { id: 'challenge', label: 'Lucky Challenge Lab', shortLabel: 'Challenge', icon: <Sparkles className="h-4 w-4" /> },
  { id: 'benchmark', label: 'Benchmark 35–40 รอบ', shortLabel: 'Benchmark', icon: <BarChart3 className="h-4 w-4" /> },
  { id: 'issues', label: 'แจ้งปัญหา & แก้ตรงจุด', shortLabel: 'แจ้งปัญหา', icon: <MessageSquareWarning className="h-4 w-4" /> },
];

const PROFILES: Array<{ value: string; label: string }> = [
  { value: 'competition', label: 'Competition (กติกาแข่ง)' },
  { value: 'default', label: 'Default (มาตรฐาน)' },
  { value: 'teacher_first', label: 'Teacher First (เน้นครู)' },
  { value: 'room_first', label: 'Room First (เน้นห้อง)' },
];

const ROLES: AccountRole[] = ['admin', 'scheduler', 'teacher', 'student', 'viewer'];

export function App() {
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [profile, setProfile] = useState<string>('competition');
  const [role, setRole] = useState<AccountRole>(() => getDemoRole());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [health, setHealth] = useState<{
    ok: boolean;
    database: string;
    tableCount: number;
    publicDemoMode: boolean;
  } | null>(null);
  const [healthError, setHealthError] = useState('');
  const [session, setSession] = useState<AuthSession | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');

  const loadSystemStatus = async () => {
    try {
      const [h, me] = await Promise.all([api.health(), api.me().catch(() => null)]);
      setHealth(h);
      setHealthError('');
      if (me) setSession(me);
    } catch (e) {
      setHealth(null);
      setHealthError(e instanceof Error ? e.message : 'DB offline');
    }
  };

  useEffect(() => {
    void loadSystemStatus();
  }, [role, refreshKey]);

  const bumpRefresh = () => setRefreshKey((k) => k + 1);

  const handleRoleChange = (nextRole: AccountRole) => {
    setDemoRole(nextRole);
    setRole(nextRole);
    bumpRefresh();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      const res = await api.login(username.trim(), password);
      setStoredToken(res.token);
      setLoginOpen(false);
      setUsername('');
      setPassword('');
      await loadSystemStatus();
      bumpRefresh();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    setStoredToken(null);
    await loadSystemStatus();
    bumpRefresh();
  };

  const navigate = (tab: string) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const hasJwt = Boolean(getStoredToken());

  const renderPage = () => {
    const key = `${activeTab}-${refreshKey}`;
    switch (activeTab) {
      case 'import':
        return <ImportPage key={key} onCommitted={bumpRefresh} />;
      case 'scenarios':
        return <ScenariosPage key={key} profile={profile} onLoaded={bumpRefresh} />;
      case 'runs':
        return <RunCenterPage key={key} profile={profile} onProfileChange={setProfile} onCompleted={bumpRefresh} />;
      case 'quality':
        return <QualitySummaryPage key={key} profile={profile} />;
      case 'workspace':
        return <WorkspacePage key={key} profile={profile} />;
      case 'views':
        return <TimetableViewsPage key={key} profile={profile} />;
      case 'challenge':
        return <ChallengeLabPage key={key} profile={profile} onApplied={bumpRefresh} />;
      case 'benchmark':
        return <BenchmarkPage key={key} />;
      case 'issues':
        return <IssueReportPage key={key} profile={profile} />;
      case 'dashboard':
      default:
        return <DashboardPage key={key} profile={profile} onNavigate={navigate} />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative z-10 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5">
              <div className="flex items-center gap-2 font-bold text-indigo-700">
                <Award className="h-5 w-5" />
                <span>PTC Smart Schedule V4</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
                aria-label="ปิดเมนู"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-3">
              {NAV_ITEMS.map((item) => {
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${
                      active ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      <div className="flex min-h-screen">
        {/* Desktop Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
          <div className="border-b border-slate-200 px-4 py-4">
            <div className="flex items-center gap-2 text-base font-bold text-indigo-700">
              <Award className="h-5 w-5 shrink-0" />
              <span>PTC Smart Schedule</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-semibold text-indigo-700">V4</span>
              <span>ระดับอาชีวศึกษา · TiDB + CSP</span>
            </div>
          </div>

          <nav className="flex-1 space-y-1 p-3">
            {NAV_ITEMS.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                    active ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
            <div className="flex items-center gap-1.5 font-medium text-slate-700">
              <Database className="h-3.5 w-3.5 text-emerald-600" />
              <span>{health?.ok ? `${health.database} (${health.tableCount} ตาราง)` : healthError || 'กำลังเชื่อมต่อ DB...'}</span>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {health?.publicDemoMode ? 'Public Demo Mode (เปิดอิสระ)' : 'Protected Mode'}
            </div>
          </div>
        </aside>

        {/* Main Workspace Column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top Bar */}
          <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(true)}
                  className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-50 md:hidden"
                  aria-label="เปิดเมนู"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <div className="md:hidden">
                  <div className="text-sm font-bold text-indigo-700">PTC Smart Schedule V4</div>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                    health?.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  <Activity className="h-3.5 w-3.5" />
                  {health?.ok ? `TiDB Live (${health.tableCount} tables)` : 'Checking TiDB...'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span className="hidden sm:inline font-medium">โปรไฟล์:</span>
                  <select
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800"
                  >
                    {PROFILES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span className="hidden sm:inline font-medium">สิทธิ์จำลอง:</span>
                  <select
                    value={role}
                    onChange={(e) => handleRoleChange(e.target.value as AccountRole)}
                    disabled={hasJwt}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-60"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>

                {hasJwt && session?.user && !session.user.isPublicGuest ? (
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>{session.user.username}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setLoginOpen(true)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    <span>Login บัญชี</span>
                  </button>
                )}
              </div>
            </div>

            {/* Mobile horizontal quick-nav pill strip */}
            <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1 md:hidden">
              {NAV_ITEMS.map((item) => {
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                      active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {item.shortLabel}
                  </button>
                );
              })}
            </div>
          </header>

          {/* Main Content */}
          <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">{renderPage()}</main>
        </div>
      </div>

      {/* Optional Login Modal */}
      {loginOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">เข้าสู่ระบบ (JWT)</h2>
              <button
                type="button"
                onClick={() => setLoginOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              ระบบเปิด Public Demo Mode ไว้ใช้งานได้ทันที หรือกรอกบัญชีในฐานข้อมูลเพื่อจำลองสิทธิ์จริง
            </p>
            <form onSubmit={(e) => void handleLogin(e)} className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="เช่น admin"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  required
                />
              </div>
              {loginError && <div className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{loginError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setLoginOpen(false)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={loginBusy}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loginBusy ? 'กำลังตรวจ...' : 'เข้าสู่ระบบ'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
