import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'

test('workers pool boots the VaultRoom worker with bindings', () => {
  expect(env.DEVICE_TOKEN_SECRET).toBe('e2e-device-token-secret')
})
