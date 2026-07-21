import { assert, test } from 'vitest'

import {
  parseChannelPointer,
  parseReleaseManifest,
  type ChannelPointer,
  type ReleaseManifest,
} from './metadata'

const sha512Integrity = `sha512-${'A'.repeat(86)}==`
const sha256 = 'a'.repeat(64)

const validPointer: ChannelPointer = {
  schemaVersion: 1,
  channel: 'stable',
  productVersion: '1.4.2',
  rolloutPercentage: 10,
  blockedSourceVersions: [],
  paused: false,
  updatedAt: '2026-07-21T12:00:00Z',
}

const validManifest: ReleaseManifest = {
  schemaVersion: 1,
  bootstrapProtocolVersion: 1,
  requiredTemplateProtocolVersion: 1,
  productVersion: '1.4.2',
  runtimeVersion: '1.4.2',
  runtimeIntegrity: sha512Integrity,
  runtimeBundleSha256: sha256,
  wranglerVersion: '4.102.0',
  wranglerIntegrity: sha512Integrity,
  buildLockSha256: sha256,
  buildCommit: '0123456789abcdef0123456789abcdef01234567',
  protocolVersion: 3,
  minimumProtocolVersion: 2,
  minimumPluginVersion: '1.3.0',
  automaticUpdate: true,
  rolloutSalt: '1.4.2-1',
  publishedAt: '2026-07-21T12:00:00Z',
}

test('parses valid channel pointers and future optional fields', () => {
  const parsed = parseChannelPointer({ ...validPointer, futureField: { enabled: true } })

  assert.deepEqual(parsed, validPointer)
})

test('parses valid release manifests with future optional fields', () => {
  const parsed = parseReleaseManifest({ ...validManifest, futureField: 'ignored-by-v1' })

  assert.deepEqual(parsed, validManifest)
})

test('rejects malformed channel pointer values', () => {
  assert.throws(() => parseChannelPointer({ ...validPointer, rolloutPercentage: 101 }))
  assert.throws(() => parseChannelPointer({ ...validPointer, productVersion: '1.0' }))
  assert.throws(() => parseChannelPointer({ ...validPointer, productVersion: '1.4.3-beta.1' }))
  assert.throws(() =>
    parseChannelPointer({ ...validPointer, blockedSourceVersions: ['1.4.1+build.1'] }),
  )
  assert.throws(() =>
    parseChannelPointer({ ...validPointer, updatedAt: '2026-07-21T12:00:00+00:00' }),
  )
  assert.throws(() =>
    parseChannelPointer({
      ...validPointer,
      blockedSourceVersions: ['1.2.3', '1.2.3'],
    }),
  )
})

test('rejects malformed release manifest hashes, integrity, and timestamp', () => {
  assert.throws(() =>
    parseReleaseManifest({ ...validManifest, runtimeBundleSha256: 'A'.repeat(64) }),
  )
  assert.throws(() =>
    parseReleaseManifest({ ...validManifest, runtimeIntegrity: 'sha512-invalid' }),
  )
  assert.throws(() => parseReleaseManifest({ ...validManifest, publishedAt: 'not-a-timestamp' }))
  assert.throws(() => parseReleaseManifest({ ...validManifest, buildCommit: 'A'.repeat(40) }))
})

test('accepts future protocol values but rejects an inverted protocol range', () => {
  const parsed = parseReleaseManifest({
    ...validManifest,
    protocolVersion: 100,
    minimumProtocolVersion: 99,
    requiredTemplateProtocolVersion: 42,
  })
  assert.equal(parsed.protocolVersion, 100)

  assert.throws(() =>
    parseReleaseManifest({ ...validManifest, protocolVersion: 2, minimumProtocolVersion: 3 }),
  )
})

test('rejects releases outside the fixed automatic-update contract', () => {
  assert.throws(() => parseReleaseManifest({ ...validManifest, runtimeVersion: '1.4.3' }))
  assert.throws(() => parseReleaseManifest({ ...validManifest, automaticUpdate: false }))
  assert.throws(() =>
    parseReleaseManifest({
      ...validManifest,
      productVersion: '1.4.2-beta.1',
      runtimeVersion: '1.4.2-beta.1',
    }),
  )
  assert.throws(() => parseReleaseManifest({ ...validManifest, wranglerVersion: '4.105.0-rc.1' }))
})
