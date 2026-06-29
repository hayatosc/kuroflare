import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'kuroflare',
      include: ['packages/**/*.test.ts'],
      testTimeout: 30000,
      globals: false,
    },
  },
])
