import * as v from 'valibot'
import { assert, test } from 'vitest'

import { ProductVersionSchema, WorkerVersionResponseSchema } from './version'

test('product versions reject numeric prerelease identifiers with leading zeroes', () => {
  assert.equal(v.is(ProductVersionSchema, '1.0.0-01'), false)
  assert.equal(v.is(ProductVersionSchema, '1.0.0-0'), true)
  assert.equal(v.is(ProductVersionSchema, '1.0.0-01a'), true)
})

test('version diagnostics remain readable when the protocol is newer than this build', () => {
  const result = v.safeParse(WorkerVersionResponseSchema, {
    productVersion: '1.0.0',
    protocolVersion: 2,
    minimumProtocolVersion: 2,
    minimumPluginVersion: '1.0.0',
    channel: 'stable',
    buildCommit: '0123456789abcdef',
    deploymentVersionId: 'deployment-version-1',
  })

  assert.equal(result.success, true)
})
