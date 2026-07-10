import { execFileSync, spawn } from 'node:child_process'
import { accessSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const vaultPath = resolve(
  process.env.KUROFLARE_E2E_OBSIDIAN_VAULT_PATH ?? '/tmp/kuroflare-obsidian-cli-smoke',
)
const appCommand = process.env.KUROFLARE_E2E_OBSIDIAN_APP ?? 'obsidian-app'
const readyTimeoutMs = parsePositiveInteger(
  process.env.KUROFLARE_E2E_OBSIDIAN_READY_TIMEOUT_MS,
  60_000,
)

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`)
  }
  return parsed
}

function assertCommand(command: string): void {
  if (command.includes('/')) {
    accessSync(command)
    return
  }
  execFileSync('which', [command], { stdio: 'ignore' })
}

function obsidian(args: readonly string[]): string {
  return execFileSync('obsidian', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function currentVaultPath(): string | null {
  try {
    return resolve(obsidian(['vault', 'info=path']))
  } catch {
    return null
  }
}

function openVault(): void {
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true })
  writeFileSync(
    join(vaultPath, 'e2e-vault-ready.md'),
    'This vault is used by Kuroflare Obsidian e2e tests.\n',
  )

  const alreadyOpen = currentVaultPath()
  if (alreadyOpen === vaultPath) {
    return
  }

  assertCommand(appCommand)
  const child = spawn(appCommand, [vaultPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function waitForVault(): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs
  let lastPath: string | null = null

  while (Date.now() < deadline) {
    lastPath = currentVaultPath()
    if (lastPath === vaultPath) {
      return
    }
    await setTimeout(500)
  }

  throw new Error(
    `Obsidian did not open the e2e vault within ${readyTimeoutMs}ms. ` +
      `Expected ${vaultPath}, last observed ${lastPath ?? 'none'}.`,
  )
}

openVault()
await waitForVault()
console.log(`Obsidian e2e vault ready: ${vaultPath}`)
