import { assert, test } from 'vitest'

import { findUnexpectedRuntimeImports } from './check-bundle'

test('accepts only Obsidian runtime externals, CodeMirror externals, and Node builtins', () => {
  const source = [
    'require("obsidian")',
    'require("electron")',
    'require("@codemirror/state")',
    'require("@lezer/common")',
    'require("node:crypto")',
    'require("path")',
    'require("./local-chunk.js")',
  ].join(';')

  assert.deepEqual(findUnexpectedRuntimeImports(source), [])
})

test('reports deterministic unique package imports that should have been bundled', () => {
  const source = [
    'require("uqr")',
    'import("valibot")',
    'require("uqr")',
    'require("@kuroflare/core")',
  ].join(';')

  assert.deepEqual(findUnexpectedRuntimeImports(source), ['@kuroflare/core', 'uqr', 'valibot'])
})
