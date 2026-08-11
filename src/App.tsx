import {
  Bell, Boxes, Building2, CalendarCheck, CalendarDays, ChevronDown, FileText, LayoutDashboard,
  Menu, Bot, Upload, Users, X, ClipboardList,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, type NotificationRow } from './lib/api';
import { initials } from './lib/format';
import { useSession } from './session';
import { AgentConsole } from './pages/AgentConsole';
import { Calendar } from './pages/Calendar';
import { Catalog } from './pages/Catalog';
import { Companies } from './pages/Companies';
import { CompanyDetail } from './pages/CompanyDetail';
import { Dashboard } from './pages/Dashboard';
import { ImportPage } from './pages/ImportPage';
import { Meetings } from './pages/Meetings';
import { MyWeek } from './pages/MyWeek';
import { Team } from './pages/Team';
import { Loading, Modal, useApi } from './ui';

const NAV = [
  { to: '/my-week', label: 'My week', icon: ClipboardList, managerOnly: false },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, managerOnly: false },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, managerOnly: false },
  { to: '/meetings', label: 'Meetings', icon: CalendarCheck, managerOnly: false },
  { to: '/companies', label: 'Companies', icon: Building2, managerOnly: false },
  { to: '/catalog', label: 'Products & orders', icon: Boxes, managerOnly: true },
  { to: '/team', label: 'Team', icon: Users, managerOnly: true },
  { to: '/agent', label: 'Agent', icon: Bot, managerOnly: true },
  { to: '/import', label: 'Import data', icon: Upload, managerOnly: true },
];

export default function App() {
  const { current, loading } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  if (loading) return <Loading label="Starting up" />;

  return (
    <div className="flex min-h-screen">
      {/* Mobile scrim */}
      {navOpen && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setNavOpen(false)} />}

      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setNavOpen(true)} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 lg:px-8">
          <Routes>
            <Route path="/" element={<Navigate to={current?.role === 'manager' ? '/dashboard' : '/my-week'} replace />} />
            <Route path="/my-week" element={<MyWeek />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/meetings" element={<Meetings />} />
            <Route path="/companies" element={<Companies />} />
            <Route path="/companies/:id" element={<CompanyDetail />} />
            <Route path="/catalog" element={<Catalog />} />
            <Route path="/team" element={<Team />} />
            <Route path="/agent" element={<AgentConsole />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="*" element={<Navigate to="/my-week" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isManager } = useSession();
  const items = NAV.filter((n) => !n.managerOnly || isManager);

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          {/* SynChem's mark is navy with a red and a cyan accent; echoed here
              rather than shipping their logo file into the repo. */}
          <span className="relative grid h-9 w-9 place-items-center rounded-lg bg-brand-700 text-white">
            <Bot size={18} />
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-accent-500" />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight text-slate-900">
              Sales Agent
            </p>
            {/* marine-700, not 600: at 12px the lighter step only reaches 4.25:1. */}
            <p className="text-xs font-medium text-marine-700">SynChem Global</p>
          </div>
        </div>
        <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 lg:hidden" onClick={onClose} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive
                  ? 'border-l-[3px] border-accent-500 bg-brand-50 pl-[9px] text-brand-700'
                  : 'border-l-[3px] border-transparent pl-[9px] text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`
            }
          >
            <Icon size={17} />
            {label}
          </NavLink>
        ))}
      </nav>

      <p className="px-5 py-4 text-[11px] leading-relaxed text-slate-400">
        Assignments run Mondays at 09:00. Reminders follow each meeting's own time.
      </p>
    </aside>
  );
}

/** Monday–Sunday of the current week, e.g. "3 – 9 Aug". */
function thisWeekLabel(): string {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const sameMonth = monday.getMonth() === sunday.getMonth();
  const d = (x: Date, opts: Intl.DateTimeFormatOptions) => x.toLocaleDateString('en-PK', opts);
  return sameMonth
    ? `${d(monday, { day: 'numeric' })} – ${d(sunday, { day: 'numeric', month: 'short' })}`
    : `${d(monday, { day: 'numeric', month: 'short' })} – ${d(sunday, { day: 'numeric', month: 'short' })}`;
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { current, people, setCurrentId } = useSession();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const { pathname } = useLocation();

  const pageTitle =
    NAV.find((n) => pathname.startsWith(n.to))?.label ??
    (pathname.startsWith('/companies/') ? 'Company' : 'Sales Agent');
  const weekLine = `Week of ${thisWeekLabel()} · ${current?.name ?? 'no one selected'}`;

  const { data: notes, refresh } = useApi<NotificationRow[]>(
    current ? `/notifications?recipientType=salesman,manager&recipientId=${current.id}&channel=inapp&limit=25` : null,
  );
  const unread = (notes ?? []).filter((n) => !n.read_at).length;

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={onMenu} aria-label="Open menu">
          <Menu size={18} />
        </button>

        {/* The bar was 62px of empty space; it now says where you are and when. */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-slate-800">{pageTitle}</h1>
          <p className="truncate text-xs text-slate-500">{weekLine}</p>
        </div>

        <button
          className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          onClick={() => setBellOpen(true)}
          aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        >
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
              {unread}
            </span>
          )}
        </button>

        <button
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50"
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-600 text-[10px] font-semibold text-white">
            {current ? initials(current.name) : '?'}
          </span>
          <span className="hidden max-w-[10rem] truncate font-medium text-slate-700 sm:block">{current?.name ?? 'Choose'}</span>
          <ChevronDown size={14} className="text-slate-400" />
        </button>
      </div>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Who are you?"
        subtitle="This build has no login yet — pick the person you are working as."
      >
        <div className="space-y-2">
          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => { setCurrentId(p.id); setPickerOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                current?.id === p.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
                {initials(p.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{p.name}</span>
                <span className="block text-xs capitalize text-slate-500">
                  {p.role}
                  {p.role === 'salesman' && ` · ${p.assigned_this_week ?? 0}/${p.weekly_quota} this week`}
                </span>
              </span>
              {(p.unread ?? 0) > 0 && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">{p.unread}</span>
              )}
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={bellOpen}
        onClose={() => { setBellOpen(false); refresh(); }}
        title="Notifications"
        subtitle={current ? `Messages the agent sent to ${current.name}` : undefined}
        footer={
          unread > 0 ? (
            <button
              className="btn-ghost w-full"
              onClick={async () => {
                if (current) await api.post('/notifications/read-all', { recipientId: current.id });
                refresh();
              }}
            >
              Mark all as read
            </button>
          ) : null
        }
      >
        {!notes?.length ? (
          <p className="py-8 text-center text-sm text-slate-500">Nothing yet.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className={`rounded-xl border p-3 ${n.read_at ? 'border-slate-200 bg-white' : 'border-brand-200 bg-brand-50/60'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">{n.subject ?? n.template}</p>
                  {!n.read_at && (
                    <button
                      className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
                      onClick={async () => { await api.post(`/notifications/${n.id}/read`); refresh(); }}
                    >
                      Mark read
                    </button>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </header>
  );
}

export { FileText };
