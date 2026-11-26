import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.spec.ts', 'server/test/**/*.spec.ts', 'client/test/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['shared/src/**/*.ts'],
      exclude: ['shared/src/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});
