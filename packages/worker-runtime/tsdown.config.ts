import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'browser',
  fixedExtension: true,
  outDir: 'dist',
  clean: true,
  dts: true,
  treeshake: true,
  target: 'es2022',
  sourcemap: false,
  deps: {
    alwaysBundle: [
      /^@kuroflare\//,
      /^@hono\/standard-validator$/,
      /^@standard-schema\//,
      /^hono(\/|$)/,
      /^kysely(\/|$)/,
      /^lib0(\/|$)/,
      /^valibot(\/|$)/,
      /^yjs(\/|$)/,
    ],
  },
})
