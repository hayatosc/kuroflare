import { assert, test } from 'vitest'

import {
  assessWorkerCompatibility,
  planWorkerVersionPresentation,
} from './worker-version-presentation'

const worker = {
  productVersion: '0.1.0',
  protocolVersion: 1 as const,
  minimumProtocolVersion: 1 as const,
  minimumPluginVersion: '0.1.0',
  channel: 'stable' as const,
  buildCommit: '0123456789abcdef0123456789abcdef01234567',
  deploymentVersionId: 'version-1',
}

test('reports compatible worker and displays release evidence', () => {
  assert.deepEqual(assessWorkerCompatibility('0.1.0', worker), {
    compatible: true,
    reason: 'Compatible',
  })
  assert.deepEqual(
    planWorkerVersionPresentation({ pluginVersion: '0.1.0', result: { ok: true, value: worker } }),
    {
      state: 'available',
      statusText: 'Worker version information available.',
      rows: [
        { label: 'Plugin version', value: '0.1.0' },
        { label: 'Worker product version', value: '0.1.0' },
        { label: 'Release channel', value: 'stable' },
        { label: 'Build commit', value: '0123456789abcdef0123456789abcdef01234567' },
        { label: 'Deployment version ID', value: 'version-1' },
        { label: 'Compatibility', value: 'Compatible' },
      ],
    },
  )
})

test('explains an incompatible minimum plugin version', () => {
  const result = assessWorkerCompatibility('0.1.0', {
    ...worker,
    minimumPluginVersion: '0.2.0',
  })
  assert.deepEqual(result, {
    compatible: false,
    reason: 'Incompatible: requires plugin 0.2.0 or newer',
  })
})

test('uses SemVer precedence for prerelease plugin versions', () => {
  const prereleaseWorker = { ...worker, minimumPluginVersion: '0.1.0' }
  assert.equal(assessWorkerCompatibility('0.1.0-beta.2', prereleaseWorker).compatible, false)
  assert.equal(assessWorkerCompatibility('0.1.0', prereleaseWorker).compatible, true)
})

test('compares numeric SemVer identifiers without safe-integer truncation', () => {
  const largeVersionWorker = {
    ...worker,
    minimumPluginVersion: '9007199254740992.0.0',
  }
  assert.equal(
    assessWorkerCompatibility('9007199254740991.0.0', largeVersionWorker).compatible,
    false,
  )
  assert.equal(
    assessWorkerCompatibility('9007199254740992.0.0', largeVersionWorker).compatible,
    true,
  )

  const largePrereleaseWorker = {
    ...worker,
    minimumPluginVersion: '1.0.0-9007199254740992',
  }
  assert.equal(
    assessWorkerCompatibility('1.0.0-9007199254740991', largePrereleaseWorker).compatible,
    false,
  )
  assert.equal(assessWorkerCompatibility('1.0.0', largePrereleaseWorker).compatible, true)
})

test('keeps unavailable responses explicit and secret-free', () => {
  assert.deepEqual(
    planWorkerVersionPresentation({
      pluginVersion: '0.1.0',
      result: { ok: false, reason: 'http', status: 503 },
    }),
    {
      state: 'unavailable',
      statusText: 'Worker version unavailable (HTTP 503).',
      rows: [{ label: 'Plugin version', value: '0.1.0' }],
    },
  )
})

test('shows a loading state before the asynchronous probe completes', () => {
  assert.deepEqual(
    planWorkerVersionPresentation({ pluginVersion: '0.1.0', result: { state: 'loading' } }),
    {
      state: 'loading',
      statusText: 'Checking Worker version…',
      rows: [{ label: 'Plugin version', value: '0.1.0' }],
    },
  )
})
