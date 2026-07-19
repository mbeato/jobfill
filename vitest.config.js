import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // helper/*.test.ts are bun:test files run via `bun test helper` — vitest must not collect them
    include: ['test/**/*.test.js'],
  },
});
