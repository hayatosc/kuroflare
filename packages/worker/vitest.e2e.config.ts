import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Real-workerd integration tests. These boot the Worker + VaultRoom Durable Object + R2
// inside miniflare, unlike the node-pool unit tests in src/ that drive VaultRoom with fakes.
//
// @cloudflare/vitest-pool-workers 0.16.x (Vitest 4) registers the Workers pool through a Vite
// plugin instead of the old `defineWorkersConfig` / `poolOptions.workers` helpers.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // The DO requires a configured device-token secret to admit authenticated sockets.
        bindings: { DEVICE_TOKEN_SECRET: 'e2e-device-token-secret' },
      },
    }),
  ],
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 30_000,
    globals: false,
  },
})
