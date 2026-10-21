import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'explorer/src/**/*.test.ts'], passWithNoTests: true },
});
