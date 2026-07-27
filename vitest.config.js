import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // helper/*.test.ts are bun:test files run via `bun test helper` — vitest must not collect them
    include: ['test/**/*.test.js'],
    // dashboard-criteria.test.js drives a real Chromium (that file opts into
    // the node environment via its own @vitest-environment pragma). Left to
    // itself vitest tries to process `playwright` through its module pipeline
    // and the run hangs at collection — no browser is ever launched and no
    // hook runs. Loading it as a plain external node module fixes that.
    server: { deps: { external: ['playwright'] } },
  },
});
