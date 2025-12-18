import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        'tests/**',
        // Barrels / type-only entrypoints (noise for coverage).
        'src/**/index.ts',
        'src/**/types.ts',
        'src/**/deps.ts',
      ],
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
})
