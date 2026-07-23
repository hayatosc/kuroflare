import builtins from 'builtin-modules'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'cjs',
  outDir: '.',
  clean: false,
  dts: false,
  treeshake: true,
  minify: process.env.NODE_ENV === 'production',
  target: 'node18',
  sourcemap: process.env.NODE_ENV !== 'production' ? 'inline' : false,
  deps: {
    alwaysBundle: [
      /^@kuroflare\//,
      /^hono(\/|$)/,
      'uqr',
      'valibot',
      'y-codemirror.next',
      'y-indexeddb',
      'yjs',
    ],
    neverBundle: [/^@codemirror\//, /^@lezer\//],
  },
  rolldownOptions: {
    external: [
      'obsidian',
      'electron',
      '@codemirror/autocomplete',
      '@codemirror/collab',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/common',
      ...builtins,
    ],
  },
})
