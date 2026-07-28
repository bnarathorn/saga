import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const apiTarget = process.env.SAGA_API_URL ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Array form, because order matters: the subpath entries must be tried before the bare
    // package names, which would otherwise swallow them as a prefix match.
    alias: [
      {
        find: /^@saga\/(contracts|shared)\/(.*)$/,
        replacement: resolve('../../packages/$1/src/$2.ts'),
      },
      {
        find: /^@saga\/(contracts|shared)$/,
        replacement: resolve('../../packages/$1/src/index.ts'),
      },
      { find: '@', replacement: resolve('./src') },
    ],
  },
  server: {
    // Bind the loopback address explicitly: the default `localhost` resolves to ::1 on some
    // machines, which a health check against 127.0.0.1 never reaches.
    host: '127.0.0.1',
    port: Number(process.env.SAGA_WEB_PORT ?? 4320),
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
    setupFiles: [resolve('./src/test-setup.ts')],
    css: false,
  },
});
