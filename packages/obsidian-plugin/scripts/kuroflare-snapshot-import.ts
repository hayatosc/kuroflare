import { readFile } from 'node:fs/promises'

interface JsonRecord {
  readonly [key: string]: unknown
}

interface SetupExchangeResponse {
  readonly endpoint: string
  readonly vaultId: string
  readonly deviceId: string
  readonly yClientId: number
  readonly accessToken: string
}

interface SnapshotImportFileInput {
  readonly ydocId: string
  readonly updateBytesBase64: string
}

interface SnapshotImportManifest {
  readonly meta: {
    readonly updateBytesBase64: string
    readonly metadataSchemaVersion: 2
  }
  readonly files: readonly SnapshotImportFileInput[]
}

interface SnapshotImportResult {
  readonly docId: { readonly kind: 'meta' } | { readonly kind: 'file'; readonly ydocId: string }
  readonly snapshotKey: string
  readonly snapshotSeq: number
}

interface CliOptions {
  readonly endpoint: string
  readonly vaultId: string
  readonly setupToken: string
  readonly deviceName: string
  readonly input: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function parseOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      key === undefined ||
      !key.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`invalid argument list near ${key ?? '<end>'}`)
    }
    values.set(key.slice(2), value)
    index += 1
  }
  return {
    endpoint: requireString(values.get('endpoint'), '--endpoint'),
    vaultId: requireString(values.get('vault-id'), '--vault-id'),
    setupToken: requireString(values.get('setup-token'), '--setup-token'),
    deviceName: requireString(values.get('device-name'), '--device-name'),
    input: requireString(values.get('input'), '--input'),
  }
}

function parseManifest(value: unknown): SnapshotImportManifest {
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.files)) {
    throw new Error('snapshot import manifest must contain meta and files')
  }
  if (value.meta.metadataSchemaVersion !== 2) {
    throw new Error('meta.metadataSchemaVersion must be 2')
  }
  const meta = {
    updateBytesBase64: requireString(value.meta.updateBytesBase64, 'meta.updateBytesBase64'),
    metadataSchemaVersion: 2 as const,
  }
  const files = value.files.map((file, index): SnapshotImportFileInput => {
    if (!isRecord(file)) {
      throw new Error(`files[${index}] must be an object`)
    }
    return {
      ydocId: requireString(file.ydocId, `files[${index}].ydocId`),
      updateBytesBase64: requireString(file.updateBytesBase64, `files[${index}].updateBytesBase64`),
    }
  })
  return { meta, files }
}

function isSetupExchangeResponse(value: unknown): value is SetupExchangeResponse {
  return (
    isRecord(value) &&
    typeof value.endpoint === 'string' &&
    typeof value.vaultId === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.yClientId === 'number' &&
    typeof value.accessToken === 'string'
  )
}

function isSnapshotImportDocId(value: unknown): value is SnapshotImportResult['docId'] {
  return (
    isRecord(value) &&
    (value.kind === 'meta' || (value.kind === 'file' && typeof value.ydocId === 'string'))
  )
}

function isSnapshotImportResult(value: unknown): value is SnapshotImportResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    isSnapshotImportDocId(value.docId) &&
    typeof value.snapshotKey === 'string' &&
    typeof value.snapshotSeq === 'number'
  )
}

async function exchangeSetupToken(options: CliOptions): Promise<SetupExchangeResponse> {
  const response = await fetch(`${options.endpoint}/setup/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vaultId: options.vaultId,
      setupToken: options.setupToken,
      requestedDeviceName: options.deviceName,
    }),
  })
  if (!response.ok) {
    throw new Error(`setup exchange failed: ${response.status}`)
  }
  const body: unknown = await response.json()
  if (!isSetupExchangeResponse(body)) {
    throw new Error('setup exchange response was invalid')
  }
  return body
}

async function importSnapshot(
  setup: SetupExchangeResponse,
  docId: SnapshotImportResult['docId'],
  updateBytesBase64: string,
  metadataSchemaVersion?: 2,
): Promise<SnapshotImportResult> {
  const response = await fetch(snapshotImportUrl(setup, docId), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${setup.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      updateBytesBase64,
      ...(metadataSchemaVersion === 2 ? { metadataSchemaVersion: 2 } : {}),
    }),
  })
  if (!response.ok) {
    throw new Error(`snapshot import failed: ${response.status}`)
  }
  const body: unknown = await response.json()
  if (!isSnapshotImportResult(body)) {
    throw new Error('snapshot import response was invalid')
  }
  return {
    docId: body.docId,
    snapshotKey: body.snapshotKey,
    snapshotSeq: body.snapshotSeq,
  }
}

function snapshotImportUrl(
  setup: SetupExchangeResponse,
  docId: SnapshotImportResult['docId'],
): string {
  const url = new URL(setup.endpoint)
  if (docId.kind === 'meta') {
    url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/meta/snapshot`
  } else {
    url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(
      docId.ydocId,
    )}/snapshot`
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const manifest = parseManifest(JSON.parse(await readFile(options.input, 'utf8')))
  const setup = await exchangeSetupToken(options)
  const imports: SnapshotImportResult[] = [
    await importSnapshot(
      setup,
      { kind: 'meta' },
      manifest.meta.updateBytesBase64,
      manifest.meta.metadataSchemaVersion,
    ),
  ]
  for (const file of manifest.files) {
    imports.push(
      await importSnapshot(setup, { kind: 'file', ydocId: file.ydocId }, file.updateBytesBase64),
    )
  }
  console.log(
    JSON.stringify({
      ok: true,
      endpoint: setup.endpoint,
      vaultId: setup.vaultId,
      deviceId: setup.deviceId,
      yClientId: setup.yClientId,
      imports,
    }),
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
