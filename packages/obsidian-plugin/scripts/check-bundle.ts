import { readFile } from 'node:fs/promises'

import builtins from 'builtin-modules'

const ALLOWED_RUNTIME_PACKAGES = new Set(['electron', 'obsidian'])
const ALLOWED_RUNTIME_PREFIXES = ['@codemirror/', '@lezer/'] as const
const RUNTIME_IMPORT_PATTERN = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu

/**
 * Finds package imports that cannot be resolved by an installed Obsidian plugin artifact.
 *
 * @param source Built CommonJS artifact source.
 * @returns Sorted unique package specifiers that should have been bundled.
 */
export function findUnexpectedRuntimeImports(source: string): readonly string[] {
  const unexpected = new Set<string>()
  for (const match of source.matchAll(RUNTIME_IMPORT_PATTERN)) {
    const specifier = match[1]
    if (
      specifier === undefined ||
      !isBareSpecifier(specifier) ||
      isAllowedRuntimeImport(specifier)
    ) {
      continue
    }
    unexpected.add(specifier)
  }
  return [...unexpected].sort()
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/')
}

function isAllowedRuntimeImport(specifier: string): boolean {
  if (specifier.startsWith('node:')) return builtins.includes(specifier.slice('node:'.length))
  return (
    builtins.includes(specifier) ||
    ALLOWED_RUNTIME_PACKAGES.has(specifier) ||
    ALLOWED_RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix))
  )
}

async function checkBundle(path: string): Promise<void> {
  const source = await readFile(path, 'utf8')
  const unexpected = findUnexpectedRuntimeImports(source)
  if (unexpected.length > 0) {
    throw new Error(`Unexpected runtime package imports in ${path}: ${unexpected.join(', ')}`)
  }
}

if (process.argv[1]?.endsWith('check-bundle.ts')) {
  const path = process.argv[2]
  if (path === undefined || path.length === 0) throw new Error('Bundle path is required')
  await checkBundle(path)
}
