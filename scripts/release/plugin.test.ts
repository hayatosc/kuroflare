import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertStableVersion,
  stagePlugin,
  validateReleaseContract,
  validateStagingDirectory,
  writeChecksums,
} from './plugin.ts'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createFixture(manifestOverrides: Record<string, unknown> = {}): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'kuroflare-release-fixture-'))
  const pluginDir = join(rootDir, 'packages/obsidian-plugin')
  const coreDir = join(rootDir, 'packages/core/src/utils')
  await mkdir(pluginDir, { recursive: true })
  await mkdir(coreDir, { recursive: true })
  await writeJson(join(rootDir, 'package.json'), { name: 'fixture', version: '0.1.0' })
  await writeFile(join(rootDir, 'README.md'), '# Kuroflare\n', 'utf8')
  await writeJson(join(pluginDir, 'package.json'), {
    name: '@kuroflare/obsidian-plugin',
    version: '0.1.0',
  })
  await writeJson(join(pluginDir, 'manifest.json'), {
    id: 'kuroflare',
    name: 'Kuroflare',
    version: '0.1.0',
    minAppVersion: '1.8.0',
    description: 'Fixture plugin.',
    author: 'Fixture Author',
    isDesktopOnly: false,
    ...manifestOverrides,
  })
  await writeJson(join(pluginDir, 'versions.json'), { '0.1.0': '1.8.0' })
  await writeFile(join(coreDir, 'version.ts'), "export const PRODUCT_VERSION = '0.1.0'\n", 'utf8')
  await writeFile(join(pluginDir, 'main.js'), 'plugin bundle\n', 'utf8')
  return rootDir
}

test('stable release tags accept only x.y.z', () => {
  assert.equal(assertStableVersion('0.1.0', 'tag'), '0.1.0')
  assert.throws(() => assertStableVersion('v0.1.0', 'tag'), /stable x\.y\.z/)
  assert.throws(() => assertStableVersion('0.1.0-beta.1', 'tag'), /stable x\.y\.z/)
  assert.throws(() => assertStableVersion('1.2', 'tag'), /stable x\.y\.z/)
})

test('staging and SHA256SUMS are deterministic and sorted', async () => {
  const rootDir = await createFixture()
  const stagingDir = await mkdtemp(join(tmpdir(), 'kuroflare-release-staging-'))
  try {
    const contract = await stagePlugin({ rootDir, stagingDir, tag: '0.1.0' })
    assert.equal(contract.version, '0.1.0')
    const content = await writeChecksums(stagingDir)
    const lines = content.trimEnd().split('\n')
    assert.deepEqual(
      lines.map((line) => line.slice(line.indexOf('  ') + 2)),
      ['main.js', 'manifest.json', 'versions.json'],
    )
    assert.equal(await readFile(join(stagingDir, 'SHA256SUMS'), 'utf8'), content)
    assert.deepEqual(await validateStagingDirectory({ stagingDir, contract }), [
      'SHA256SUMS',
      'main.js',
      'manifest.json',
      'versions.json',
    ])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(stagingDir, { recursive: true, force: true })
  }
})

test('staging fails closed when a required asset is missing', async () => {
  const rootDir = await createFixture()
  const stagingDir = await mkdtemp(join(tmpdir(), 'kuroflare-release-missing-'))
  try {
    await assert.rejects(
      () => validateStagingDirectory({ stagingDir }),
      /staging\/main\.js is missing/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(stagingDir, { recursive: true, force: true })
  }
})

test('release contract rejects a v-prefixed tag', async () => {
  const rootDir = await createFixture()
  try {
    await assert.rejects(
      () => validateReleaseContract({ rootDir, tag: 'v0.1.0' }),
      /stable x\.y\.z/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('release contract enforces Obsidian manifest fields and plugin IDs', async () => {
  for (const id of ['Kuroflare', 'kuroflare2', 'obsidian-kuroflare', 'kuroflare-plugin']) {
    const rootDir = await createFixture({ id })
    try {
      await assert.rejects(() => validateReleaseContract({ rootDir, tag: '0.1.0' }))
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }

  const rootDir = await createFixture({ isDesktopOnly: 'false' })
  try {
    await assert.rejects(
      () => validateReleaseContract({ rootDir, tag: '0.1.0' }),
      /isDesktopOnly must be a boolean/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
