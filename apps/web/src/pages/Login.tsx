import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import { useLogin } from '../lib/queries.js';

/** The shape `App`'s unauthenticated catch-all stashes on `Navigate`'s `state`. */
interface LocationState {
  from?: { pathname: string; search: string; hash: string };
}

/**
 * Where to land after a successful sign-in.
 *
 * `App.tsx` redirects an unauthenticated visit to `/login` with `state={{ from: location }}` so a
 * link like the CLI's device-approval URL survives the round trip through sign-in. Without it,
 * `verification_uri_complete`'s `?code=` query string would be dropped and the administrator would
 * land on the dashboard instead of the approval they were sent to make.
 *
 * The pathname is validated before use: it must be an in-app path, starting with a single `/` and
 * not `//`, because a `//`-prefixed pathname makes `navigate()` resolve against another origin and
 * attempt a cross-origin `history.pushState`, which throws instead of redirecting.
 *
 * Exported so this can be asserted directly — a `MemoryRouter` never touches the real history API,
 * so an integration test cannot reproduce the throw this guards against.
 */
export function resolveRedirectTarget(from: LocationState['from']): string {
  if (from === undefined) return '/';
  if (!from.pathname.startsWith('/') || from.pathname.startsWith('//')) return '/';
  return `${from.pathname}${from.search}${from.hash}`;
}

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const redirectTo = resolveRedirectTarget((location.state as LocationState | null)?.from);

  const error = login.error;
  const message =
    error instanceof ApiError
      ? error.code === 'ACCOUNT_LOCKED'
        ? 'Too many failed attempts. Wait for the lockout to expire and try again.'
        : error.message
      : error instanceof Error
        ? 'Could not reach the Saga API. Check that the server is running.'
        : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate(redirectTo, { replace: true }) });
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <div className="mb-6 text-center">
        <h1 className="font-display text-3xl font-semibold text-ink-800 dark:text-parchment-100">
          Guild Hall
        </h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          No agent starts at level one.
        </p>
      </div>

      <form onSubmit={submit} className="panel p-6" noValidate>
        <h2 className="panel-title mb-4">Sign in</h2>

        <div className="mb-4">
          <label className="field-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="field-input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="mb-4">
          <label className="field-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="field-input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {message !== null && (
          <p role="alert" className="mb-4 text-sm font-medium text-rust-600 dark:text-rust-400">
            {message}
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
