import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Calendar,
  CalendarDays,
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
  Users,
  Wrench,
  X,
} from 'lucide-react';
import type { AccountRole } from '@ptc/shared';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageSkeleton } from './components/PageSkeleton';
import { api, getDemoRole, getDemoStaff, getStoredToken, invalidateApiCache, setDemoRole, setStoredToken } from './lib/api';
import { DashboardPage } from './pages/DashboardPage';
import type { AuthSession } from './types/ui';

const ImportPage = lazy(() => import('./pages/ImportPage').then((m) => ({ default: m.ImportPage })));
const ScenariosPage = lazy(() => import('./pages/ScenariosPage').then((m) => ({ default: m.ScenariosPage })));
const RunCenterPage = lazy(() => import('./pages/RunCenterPage').then((m) => ({ default: m.RunCenterPage })));
const QualitySummaryPage = lazy(() => import('./pages/QualitySummaryPage').then((m) => ({ default: m.QualitySummaryPage })));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then((m) => ({ default: m.WorkspacePage })));
const TimetableViewsPage = lazy(() => import('./pages/TimetableViewsPage').then((m) => ({ default: m.TimetableViewsPage })));
const ChallengeLabPage = lazy(() => import('./pages/ChallengeLabPage').then((m) => ({ default: m.ChallengeLabPage })));
const BenchmarkPage = lazy(() => import('./pages/BenchmarkPage').then((m) => ({ default: m.BenchmarkPage })));
const IssueReportPage = lazy(() => import('./pages/IssueReportPage').then((m) => ({ default: m.IssueReportPage })));

const StaffPage = lazy(() => import('./pages/StaffPage').then((m) => ({ default: m.StaffPage })));
const WeeklyPage = lazy(() => import('./pages/WeeklyPage').then((m) => ({ default: m.WeeklyPage })));

interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

/** Menus each role sees; admin and scheduler see everything. */
const ROLE_MENUS: Partial<Record<AccountRole, string[]>> = {
  teacher: ['dashboard', 'weekly', 'workspace', 'views', 'staff', 'issues'],
  student: ['dashboard', 'weekly', 'workspace', 'views'],
  viewer: ['dashboard', 'weekly', 'views', 'staff'],
};

const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'หน้าหลัก',
    items: [{ id: 'dashboard', label: 'ภาพรวมระบบ', icon: <LayoutDashboard className="h-4 w-4" /> }],
  },
  {
    title: '1. นำเข้าข้อมูล (Input)',
    items: [
      { id: 'import', label: 'นำเข้าข้อมูล 7 ไฟล์ CSV', icon: <FileSpreadsheet className="h-4 w-4" /> },
      { id: 'scenarios', label: 'ชุดข้อมูลทดสอบ Q01–Q25', icon: <FolderKanban className="h-4 w-4" /> },
    ],
  },
  {
    title: '2. ประมวลผล AI (Process)',
    items: [
      { id: 'runs', label: 'จัดตารางอัตโนมัติ', icon: <PlayCircle className="h-4 w-4" /> },
      { id: 'challenge', label: 'เงื่อนไขพิเศษ (Lucky Challenge)', icon: <Sparkles className="h-4 w-4" /> },
      { id: 'benchmark', label: 'ทดสอบประสิทธิภาพ', icon: <BarChart3 className="h-4 w-4" /> },
    ],
  },
  {
    title: '3. ผลลัพธ์ (Output)',
    items: [
      { id: 'weekly', label: 'ตารางรายสัปดาห์ & ชดเชย', icon: <CalendarDays className="h-4 w-4" /> },
      { id: 'workspace', label: 'ตารางหลัก (ย้าย/สลับถาวร)', icon: <Wrench className="h-4 w-4" /> },
      { id: 'views', label: 'ตารางเรียน & ส่งออกรายงาน', icon: <Calendar className="h-4 w-4" /> },
      { id: 'quality', label: 'สรุปผลตรวจสอบ 4 ด้าน', icon: <ShieldCheck className="h-4 w-4" /> },
      { id: 'issues', label: 'แจ้งปัญหา & แก้ไข', icon: <MessageSquareWarning className="h-4 w-4" /> },
    ],
  },
  {
    title: 'ข้อมูลวิทยาลัย',
    items: [{ id: 'staff', label: 'รายชื่อบุคลากร', icon: <Users className="h-4 w-4" /> }],
  },
];

const ROLE_LABELS: Record<AccountRole, string> = {
  admin: 'ผู้ดูแลระบบ',
  scheduler: 'ผู้จัดตาราง',
  teacher: 'ครูผู้สอน',
  student: 'นักเรียน',
  viewer: 'ผู้เยี่ยมชม',
};

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
  const [statusVersion, setStatusVersion] = useState(0);

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

  const loadSystemStatus = async (force = false) => {
    try {
      const [h, me] = await Promise.all([api.health(force), api.me(force).catch(() => null)]);
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
  }, [role, statusVersion]);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.prefetchTab('quality', profile);
      api.prefetchTab('runs', profile);
    }, 400);
    return () => clearTimeout(timer);
  }, [profile]);

  const onMutated = () => {
    invalidateApiCache();
    setStatusVersion((v) => v + 1);
  };

  const handleRoleChange = (nextRole: AccountRole) => {
    setDemoRole(nextRole);
    setRole(nextRole);
    setStatusVersion((v) => v + 1);
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
      await loadSystemStatus(true);
      setStatusVersion((v) => v + 1);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    setStoredToken(null);
    await loadSystemStatus(true);
    setStatusVersion((v) => v + 1);
  };

  const navigate = (tab: string) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const hasJwt = Boolean(getStoredToken());
  const effectiveRole: AccountRole = hasJwt && session?.user && !session.user.isPublicGuest ? session.user.role : role;
  const allowedMenus = ROLE_MENUS[effectiveRole];
  const canSee = (id: string) => !allowedMenus || allowedMenus.includes(id);
  const page = canSee(activeTab) ? activeTab : 'dashboard';
  const jwtStaffId = hasJwt && session?.user && !session.user.isPublicGuest ? session.user.staffId : null;

  // Requests waiting for this user (badge on the weekly menu).
  const [pending, setPending] = useState(0);
  const refreshPending = () => {
    const admin = effectiveRole === 'admin' || effectiveRole === 'scheduler';
    api
      .weeklyData()
      .then(async (w) => {
        let myCode = getDemoStaff();
        if (jwtStaffId) myCode = (await api.scheduleLatest(profile)).context.staff.find((st) => st.id === jwtStaffId)?.employeeCode ?? '';
        setPending(
          w.requests.filter(
            (r) => (r.status === 'pending_peer' && (admin || (myCode && r.peerCode === myCode))) || (r.status === 'pending_admin' && admin),
          ).length,
        );
      })
      .catch(() => setPending(0));
  };
  useEffect(refreshPending, [effectiveRole, jwtStaffId, statusVersion]);

  const renderPage = () => {
    const scopeKey = `${page}-${effectiveRole}`;
    switch (page) {
      case 'import':
        return <ImportPage key={scopeKey} onCommitted={onMutated} />;
      case 'scenarios':
        return <ScenariosPage key={scopeKey} profile={profile} onLoaded={onMutated} />;
      case 'runs':
        return <RunCenterPage key={scopeKey} profile={profile} onProfileChange={setProfile} onCompleted={onMutated} />;
      case 'quality':
        return <QualitySummaryPage key={scopeKey} profile={profile} />;
      case 'workspace':
        return <WorkspacePage key={scopeKey} profile={profile} role={effectiveRole} />;
      case 'views':
        return <TimetableViewsPage key={scopeKey} profile={profile} />;
      case 'challenge':
        return <ChallengeLabPage key={scopeKey} profile={profile} onApplied={onMutated} />;
      case 'benchmark':
        return <BenchmarkPage key={scopeKey} />;
      case 'issues':
        return <IssueReportPage key={scopeKey} profile={profile} />;
      case 'weekly':
        return <WeeklyPage key={scopeKey} profile={profile} role={effectiveRole} jwtStaffId={jwtStaffId} onRequestsChanged={refreshPending} />;
      case 'staff':
        return <StaffPage key={scopeKey} profile={profile} role={effectiveRole} />;
      case 'dashboard':
      default:
        return <DashboardPage key={scopeKey} profile={profile} onNavigate={navigate} />;
    }
  };

  const navButton = (item: NavItem) => {
    const active = page === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onMouseEnter={() => api.prefetchTab(item.id, profile)}
        onFocus={() => api.prefetchTab(item.id, profile)}
        onClick={() => navigate(item.id)}
        aria-current={active ? 'page' : undefined}
        className={`flex w-full items-center gap-2.5 rounded-md border-l-4 px-3 py-2.5 text-left text-sm font-medium transition ${
          active
            ? 'border-gold-500 bg-indigo-50 text-indigo-800'
            : 'border-transparent text-slate-700 hover:bg-slate-100 hover:text-indigo-800'
        }`}
      >
        {item.icon}
        <span className="truncate">{item.label}</span>
        {item.id === 'weekly' && pending > 0 && (
          <span className="ml-auto rounded-full bg-gold-500 px-1.5 text-[11px] font-bold text-indigo-950" aria-label={`${pending} คำขอรอดำเนินการ`}>
            {pending}
          </span>
        )}
      </button>
    );
  };

  const navSections = NAV_SECTIONS.map((section) => ({ ...section, items: section.items.filter((i) => canSee(i.id)) }))
    .filter((section) => section.items.length > 0)
    .map((section) => (
      <div key={section.title} className="mb-4">
        <div className="mb-1.5 px-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">{section.title}</div>
        <div className="space-y-0.5">{section.items.map(navButton)}</div>
      </div>
    ));

  const dbStatus = health?.ok
    ? `เชื่อมต่อฐานข้อมูลแล้ว (${health.tableCount} ตาราง)`
    : healthError
      ? `ฐานข้อมูลขัดข้อง: ${healthError}`
      : 'กำลังเชื่อมต่อฐานข้อมูล...';

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 bg-linear-to-r from-indigo-900 via-indigo-800 to-indigo-900 text-white shadow-md">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md border border-white/20 p-2 hover:bg-white/10 md:hidden"
              aria-label="เปิดเมนู"
            >
              <Menu className="h-5 w-5" />
            </button>
            <img
              src="/college-logo.png"
              alt="ตราวิทยาลัยการอาชีพโพนทอง"
              width={52}
              height={52}
              className="h-13 w-13 shrink-0 rounded-full bg-white shadow-md ring-2 ring-gold-400"
            />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-base font-bold sm:text-lg">ระบบจัดตารางเรียนอัตโนมัติด้วยปัญญาประดิษฐ์</div>
              <div className="truncate text-xs text-gold-300">วิทยาลัยการอาชีพโพนทอง · Phonthong Industrial and Community Education College</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                health?.ok ? 'bg-emerald-500/20 text-emerald-100' : 'bg-gold-500/20 text-gold-100'
              }`}
              title={dbStatus}
            >
              <Activity className="h-3.5 w-3.5" />
              {health?.ok ? 'ระบบพร้อมใช้งาน' : healthError ? 'ระบบขัดข้อง' : 'กำลังตรวจสอบ...'}
            </span>
            <label className="flex items-center gap-1.5">
              <span className="hidden text-indigo-200 lg:inline">โปรไฟล์เงื่อนไข</span>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="rounded-md border border-white/20 bg-indigo-800 px-2 py-1.5 font-medium text-white"
              >
                {PROFILES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="hidden text-indigo-200 lg:inline">สิทธิ์ผู้ใช้</span>
              <select
                value={role}
                onChange={(e) => handleRoleChange(e.target.value as AccountRole)}
                disabled={hasJwt}
                className="rounded-md border border-white/20 bg-indigo-800 px-2 py-1.5 font-medium text-white disabled:opacity-60"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {hasJwt && session?.user && !session.user.isPublicGuest ? (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 font-medium hover:bg-white/20"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>ออกจากระบบ ({session.user.username})</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-gold-500 px-3 py-1.5 font-semibold text-indigo-950 hover:bg-gold-400"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>เข้าสู่ระบบ</span>
              </button>
            )}
          </div>
        </div>
        <div className="h-1 bg-gold-500" />
      </header>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative z-10 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b-4 border-gold-500 bg-indigo-900 px-4 py-3 text-white">
              <span className="flex items-center gap-2 font-bold">
                <img src="/college-logo.png" alt="" width={28} height={28} className="h-7 w-7 rounded-full bg-white" />
                เมนูระบบ
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md p-1 hover:bg-white/10"
                aria-label="ปิดเมนู"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3">{navSections}</nav>
          </aside>
        </div>
      )}

      <div className="flex flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
          <nav className="flex-1 overflow-y-auto p-3 pt-5">{navSections}</nav>
          <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
            <div className="flex items-center gap-1.5 font-medium text-slate-700">
              <Database className={`h-3.5 w-3.5 ${health?.ok ? 'text-emerald-600' : 'text-gold-600'}`} />
              <span>{dbStatus}</span>
            </div>
            {health && (
              <div className="mt-1 text-[11px] text-slate-400">
                {health.publicDemoMode ? 'โหมดสาธารณะ: ทดลองใช้ได้ทุกเมนูโดยไม่ต้องเข้าสู่ระบบ' : 'โหมดจำกัดสิทธิ์'}
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
            <ErrorBoundary resetKey={`${activeTab}-${profile}-${role}`}>
              <Suspense fallback={<PageSkeleton />}>{renderPage()}</Suspense>
            </ErrorBoundary>
          </main>
          <footer className="border-t border-slate-200 bg-white px-6 py-3 text-center text-xs text-slate-500">
            วิทยาลัยการอาชีพโพนทอง · ระบบจัดตารางเรียนอัตโนมัติด้วยเทคโนโลยีปัญญาประดิษฐ์ (ฉบับฝึกซ้อมการแข่งขันทักษะวิชาชีพ)
          </footer>
        </div>
      </div>

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
