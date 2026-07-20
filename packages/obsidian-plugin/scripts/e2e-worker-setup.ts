import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

// Shared helpers for real-Obsidian e2e harnesses that need a real worker
// (`pnpm --filter @kuroflare/worker dev:local`) to complete a real setup
// exchange before the plugin's local editing/metadata pipeline activates.
// Mirrors the patterns already proven in obsidian-miniflare-smoke/, kept
// separate so that suite's own copies stay untouched.

const DEFAULT_E2E_OBSIDIAN_VAULT_PATH = '/tmp/kuroflare-obsidian-cli-smoke'

/**
 * Validates the active vault path returned by the Obsidian CLI.
 *
 * @param value - Raw stdout from `obsidian vault info=path`.
 * @returns The validated absolute path to an existing directory.
 * @throws When the CLI did not return a usable vault directory.
 */
export function requireObsidianVaultPath(value: string): string {
  const vaultPath = value.trim()
  if (vaultPath === '' || vaultPath === 'Vault not found.') {
    throw new Error('Obsidian CLI did not return an active vault path.')
  }
  if (!isAbsolute(vaultPath)) {
    throw new Error(`Obsidian CLI returned a relative vault path: ${JSON.stringify(vaultPath)}`)
  }
  if (!statSync(vaultPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Obsidian CLI returned a vault path that is not an existing directory: ${JSON.stringify(vaultPath)}`,
    )
  }
  return vaultPath
}

/**
 * Refuses destructive harness operations unless Obsidian is using the disposable e2e vault.
 *
 * @param vaultPath - Absolute active vault path returned by the Obsidian CLI.
 * @returns The validated vault path.
 * @throws When the active vault does not exactly match the configured e2e vault path.
 */
export function requireSafeObsidianVaultPath(vaultPath: string): string {
  const expectedPath = resolve(
    process.env.KUROFLARE_E2E_OBSIDIAN_VAULT_PATH ?? DEFAULT_E2E_OBSIDIAN_VAULT_PATH,
  )
  const resolvedVaultPath = resolve(vaultPath)
  const canonicalExpectedPath = realpathSync(expectedPath)
  const canonicalVaultPath = realpathSync(resolvedVaultPath)
  if (
    !isAbsolute(vaultPath) ||
    resolvedVaultPath !== expectedPath ||
    canonicalExpectedPath !== expectedPath ||
    canonicalVaultPath !== expectedPath
  ) {
    throw new Error(
      `Refusing to mutate active Obsidian vault ${JSON.stringify(vaultPath)}. ` +
        `Expected the disposable e2e vault at ${JSON.stringify(expectedPath)}; ` +
        'set KUROFLARE_E2E_OBSIDIAN_VAULT_PATH to override it.',
    )
  }
  return vaultPath
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

/** Acquires exclusive ownership of the shared disposable Obsidian vault. */
export function acquireObsidianE2ELock(vaultPath: string, runId: string): () => void {
  requireSafeObsidianVaultPath(vaultPath)
  const lockPath = join(vaultPath, '.kuroflare-e2e.lock')
  const owner = JSON.stringify({ pid: process.pid, runId })
  try {
    writeFileSync(lockPath, owner, { flag: 'wx' })
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') {
      throw new Error(`Failed to acquire Obsidian e2e lock: ${lockPath}`, { cause: error })
    }
    throw new Error(
      `Obsidian e2e vault is already in use: ${lockPath}. Remove a stale lock only after confirming no harness is running.`,
      { cause: error },
    )
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      if (readFileSync(lockPath, 'utf8') === owner) {
        unlinkSync(lockPath)
      }
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        console.warn('Failed to release Obsidian e2e lock', { error })
      }
    }
  }
  process.once('exit', release)
  return release
}

/**
 * POSTs a setup token to the worker's admin route so a plugin can later
 * exchange it for real device credentials. Fails fast with an actionable
 * message when the worker is unreachable (e.g. `dev:local` was never
 * started), instead of surfacing as an unrelated downstream failure.
 */
export async function seedWorkerSetupToken(input: {
  readonly endpoint: string
  readonly adminSecret: string
  readonly vaultId: string
  readonly setupToken: string
  readonly expiresInMs?: number
}): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${input.endpoint}/admin/setup-tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kuroflare-admin-secret': input.adminSecret,
      },
      body: JSON.stringify({
        vaultId: input.vaultId,
        setupToken: input.setupToken,
        expiresInMs: input.expiresInMs ?? 10 * 60 * 1000,
      }),
    })
  } catch (error: unknown) {
    throw new Error(
      `Kuroflare worker is not reachable at ${input.endpoint}. Start it first: ` +
        'pnpm --filter @kuroflare/worker dev:local (use --port 8788 and ' +
        'KUROFLARE_E2E_ENDPOINT=http://127.0.0.1:8788 if 8787 is busy).',
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(`setup token seed failed: ${response.status} ${await response.text()}`)
  }
}

/**
 * Copies the built plugin into the e2e vault and seeds `data.json` so the
 * plugin performs a real setup exchange against the worker on next load,
 * instead of starting from an unconfigured, offline-forever vault.
 */
export function copyPluginWithSetup(input: {
  readonly vaultPath: string
  readonly packageDir: string
  readonly pluginId: string
  readonly endpoint: string
  readonly setupVaultId: string
  readonly setupToken: string
  readonly requestedDeviceName: string
  readonly setupBootstrapMode: 'new-vault' | 'join-existing'
}): void {
  const targetDir = join(input.vaultPath, '.obsidian', 'plugins', input.pluginId)
  mkdirSync(targetDir, { recursive: true })
  for (const file of ['manifest.json', 'versions.json', 'main.js']) {
    copyFileSync(join(input.packageDir, file), join(targetDir, file))
  }
  writeFileSync(
    join(targetDir, 'data.json'),
    JSON.stringify(
      {
        endpoint: input.endpoint,
        setupVaultId: input.setupVaultId,
        setupToken: input.setupToken,
        requestedDeviceName: input.requestedDeviceName,
        setupBootstrapMode: input.setupBootstrapMode,
      },
      null,
      2,
    ),
  )
  // Obsidian scans community plugins only at startup, so a plugin copied into
  // a cold vault is invisible to plugin:enable until manifests are rescanned.
  execFileSync(
    'obsidian',
    [
      'eval',
      "code=(async () => { await app.plugins.loadManifests(); return 'manifests-reloaded' })()",
    ],
    { cwd: input.packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Waits until the named community plugin has loaded. */
export function waitForPluginLoaded(
  pluginId: string,
  evalInObsidian: (code: string) => unknown,
  timeoutMs = 10_000,
): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const loaded = evalInObsidian(
      `(() => JSON.stringify(Boolean(app.plugins.plugins[${JSON.stringify(pluginId)}])))()`,
    )
    if (loaded === true) {
      return
    }
  }
  throw new Error(`${pluginId} plugin did not load within ${timeoutMs}ms`)
}

/**
 * Waits until setup exchange has fully completed: the startup side-effect
 * gate is `'allowed'` (local editing and network side effects unblocked) and
 * the worker has granted metadata write access over the hello handshake.
 * These flip at different times (the gate resolves from the startup plan
 * before the WebSocket hello round-trip lands), so both must be checked.
 */
export function waitForSetupReady(
  evalInObsidian: (code: string) => unknown,
  timeoutMs = 15_000,
): void {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    last = evalInObsidian(
      '(() => JSON.stringify({ permission: app.plugins.plugins.kuroflare?.startupSideEffectGate?.permission ?? null, metadataAccess: app.plugins.plugins.kuroflare?.metadataAccess ?? null }))()',
    )
    if (
      typeof last === 'object' &&
      last !== null &&
      Reflect.get(last, 'permission') === 'allowed' &&
      Reflect.get(last, 'metadataAccess') === 'read-write'
    ) {
      return
    }
  }
  throw new Error(
    `Kuroflare setup did not complete within ${timeoutMs}ms (last state: ${JSON.stringify(last)})`,
  )
}
