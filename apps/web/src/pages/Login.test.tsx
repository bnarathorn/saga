import { describe, expect, it } from 'vitest';
import { resolveRedirectTarget } from './Login.jsx';

/**
 * `App.tsx` stashes the location an unauthenticated visitor was sent to, so sign-in can return
 * them to it. The round trip itself is covered in `App.test.tsx`; what is asserted here is the
 * pathname guard, which that test cannot defend: `MemoryRouter` never calls the real
 * `history.pushState`, so the SecurityError a `//`-prefixed path would throw in a browser is not
 * reproducible in jsdom, and the integration test passes with or without the guard.
 */
describe('resolveRedirectTarget', () => {
  it('returns the dashboard when nothing was stashed', () => {
    expect(resolveRedirectTarget(undefined)).toBe('/');
  });

  it('preserves the query string, which is what the device-approval link depends on', () => {
    expect(
      resolveRedirectTarget({ pathname: '/device', search: '?code=WORD-WORD', hash: '' }),
    ).toBe('/device?code=WORD-WORD');
  });

  it('preserves a hash fragment alongside the query string', () => {
    expect(
      resolveRedirectTarget({ pathname: '/projects', search: '?status=active', hash: '#lore' }),
    ).toBe('/projects?status=active#lore');
  });

  it.each(['//evil.com', '///evil.com', '//evil.com/path'])(
    'refuses the protocol-relative pathname %s and falls back to the dashboard',
    (pathname) => {
      // These resolve against another origin, so `navigate()` would attempt a cross-origin
      // `history.pushState` and throw instead of redirecting.
      expect(resolveRedirectTarget({ pathname, search: '', hash: '' })).toBe('/');
    },
  );

  it('refuses a pathname that is not rooted at all', () => {
    expect(resolveRedirectTarget({ pathname: 'evil.com', search: '', hash: '' })).toBe('/');
  });
});
