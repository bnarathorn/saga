import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // jsdom has no EventSource; the live provider must fall back to polling rather than throw.
  vi.stubGlobal('EventSource', undefined);
  document.cookie = 'saga_csrf=test-csrf-token; path=/';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
