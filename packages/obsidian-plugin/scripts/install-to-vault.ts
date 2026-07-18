import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '..')

function requireVaultPath(): string {
  const raw = process.argv[2] ?? process.env.KUROFLARE_VAULT_PATH
  if (raw === undefined || raw.length === 0) {
    throw new Error('vault path is required: pass it as an argument or set KUROFLARE_VAULT_PATH')
  }
  const vaultPath = resolve(raw)
  if (!existsSync(join(vaultPath, '.obsidian'))) {
    throw new Error(`not an Obsidian vault (missing .obsidian/): ${vaultPath}`)
  }
  return vaultPath
}

function main(): void {
  const vaultPath = requireVaultPath()
  const targetDir = join(vaultPath, '.obsidian', 'plugins', 'kuroflare')
  mkdirSync(targetDir, { recursive: true })

  for (const file of ['manifest.json', 'main.js', 'styles.css']) {
    const sourcePath = join(packageDir, file)
    if (!existsSync(sourcePath)) {
      if (file === 'styles.css') continue
      throw new Error(`missing build output: ${sourcePath}`)
    }
    copyFileSync(sourcePath, join(targetDir, file))
  }

  console.log(`Installed Kuroflare plugin into ${targetDir}`)
}

main()
