import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // jsdom has no EventSource; the live provider must fall back to polling rather than throw.
  vi.stubGlobal('EventSource', undefined);
  document.cookie = 'saga_csrf=test-csrf-token; path=/';
  // The remembered project and the chosen theme both live here. jsdom keeps one store for the
  // whole file, so without this a test that opens a project decides where the *next* test's
  // `/lore` or `/shrine` lands.
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
