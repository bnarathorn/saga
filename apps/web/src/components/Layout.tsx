import type { MeResponse } from '@saga/contracts';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useHealth, useLogout } from '../lib/queries.js';
import { classNames, StatusPill } from './primitives.jsx';
import { ProjectPicker } from './ProjectPicker.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { LiveIndicator } from './LiveIndicator.jsx';

/**
 * Two destinations, because there are only two kinds of page: the Dashboard is the server, and
 * everything else belongs to a project. Lore, the Quest Board, the Party and the Shrine are
 * reached as tabs of the project the picker beside these entries selects.
 */
const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/projects', label: 'Projects', end: true },
];

export function Layout({ me }: { me: MeResponse }) {
  const health = useHealth();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-ink-800 dark:focus:bg-night-800 dark:focus:text-parchment-100"
      >
        Skip to main content
      </a>

      <header className="border-b border-parchment-300 bg-parchment-100/80 backdrop-blur dark:border-night-800 dark:bg-night-900/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-xl font-semibold tracking-tight text-ink-800 dark:text-parchment-100">
              Guild Hall
            </span>
            <span className="hidden text-xs uppercase tracking-[0.2em] text-ink-500 dark:text-parchment-300/70 sm:inline">
              Saga
            </span>
          </div>

          <nav
            aria-label="Primary"
            className="order-3 flex w-full flex-wrap items-center gap-3 sm:order-none sm:w-auto"
          >
            <ul className="flex flex-wrap gap-1">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      classNames(
                        'block rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-white text-ink-800 shadow-sm dark:bg-night-800 dark:text-parchment-100'
                          : 'text-ink-600 hover:bg-white/60 dark:text-parchment-300 dark:hover:bg-night-800/60',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
            <ProjectPicker />
          </nav>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            <LiveIndicator />
            {health.data !== undefined && <StatusPill status={health.data.status} />}
            <ThemeToggle />
            {/* The divider only reads as one when the cluster is on a single line, which it is
                from `sm` up; below that this block has wrapped onto a line of its own. */}
            <div className="flex min-w-0 items-center gap-2 sm:border-l sm:border-parchment-300 sm:pl-3 dark:sm:border-night-700">
              {/* Who is signed in is context, not a control: on the narrowest screens the
                  header keeps the button and drops the label rather than growing a row. */}
              <span className="hidden truncate text-sm text-ink-600 sm:inline dark:text-parchment-300">
                {me.user?.display_name ?? me.agent?.name ?? 'Signed in'}
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  logout.mutate(undefined, { onSuccess: () => navigate('/login') });
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-ink-500 dark:text-parchment-300/60">
        Saga — no agent starts at level one.
      </footer>
    </div>
  );
}
