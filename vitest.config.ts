import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      // Logic only. The React components and the two grid adapters are verified in a browser (see README).
      include: ['shared/**/*.ts', 'server/**/*.ts', 'web/state.ts', 'web/backend/**/*.ts', 'web/gantt/model.ts', 'web/ledger/intent.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
