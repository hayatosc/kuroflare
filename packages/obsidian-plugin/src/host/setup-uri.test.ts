// @vitest-environment jsdom

import { assert, test, vi } from 'vitest'

import type KuroflareSpikePlugin from './plugin'

const lifecycleMocks = vi.hoisted(() => ({
  handleLifecycleResume: vi.fn(async (): Promise<void> => undefined),
}))

vi.mock('./editor', () => lifecycleMocks)

type FakeContainer = HTMLElement

function createContainer(): FakeContainer {
  const container = document.createElement('div')
  Object.defineProperties(container, {
    createEl: {
      value: (tag: string, options?: { readonly text?: string; readonly cls?: string }) => {
        const child = document.createElement(tag)
        if (options?.text !== undefined) child.textContent = options.text
        if (options?.cls !== undefined) child.className = options.cls
        container.append(child)
        return child
      },
    },
    createDiv: {
      value: () => {
        const child = createContainer()
        container.append(child)
        return child
      },
    },
    empty: { value: () => container.replaceChildren() },
  })
  return container
}

const obsidianMocks = vi.hoisted(() => {
  class FakeModal {
    static last: FakeModal | undefined
    readonly contentEl = createContainer()

    constructor(..._args: unknown[]) {
      FakeModal.last = this
    }

    open(): void {
      this.onOpen()
    }

    close(): void {
      this.onClose()
    }

    onOpen(): void {}

    onClose(): void {}
  }

  class FakeNotice {
    static messages: string[] = []

    constructor(message: string) {
      FakeNotice.messages.push(message)
    }
  }

  return { FakeModal, FakeNotice }
})

vi.mock('obsidian', () => ({
  Modal: obsidianMocks.FakeModal,
  Notice: obsidianMocks.FakeNotice,
}))

import { confirmAndApplySetupUri, resolveSetupUriBootstrapMode } from './setup-uri'

test('prefers an explicit URI bootstrap mode over current settings', () => {
  assert.equal(
    resolveSetupUriBootstrapMode({ bootstrapMode: 'join-existing' }, 'new-vault'),
    'join-existing',
  )
})

test('uses the current bootstrap mode when the URI omits it', () => {
  assert.equal(
    resolveSetupUriBootstrapMode({ bootstrapMode: undefined }, 'join-existing'),
    'join-existing',
  )
  assert.equal(resolveSetupUriBootstrapMode({ bootstrapMode: undefined }, undefined), 'new-vault')
})

test('falls back to new-vault for an invalid current bootstrap mode', () => {
  assert.equal(resolveSetupUriBootstrapMode({ bootstrapMode: undefined }, ''), 'new-vault')
  assert.equal(
    resolveSetupUriBootstrapMode({ bootstrapMode: undefined }, 'unexpected'),
    'new-vault',
  )
  assert.equal(
    resolveSetupUriBootstrapMode({ bootstrapMode: 'join-existing' }, 'unexpected'),
    'join-existing',
  )
})

test('rejects setup URI application for an already trusted device', () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const previousModal = obsidianMocks.FakeModal.last
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const requestReplan = vi.fn()
  const lifecycle = {
    requestReplan,
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({
      tickInFlight: false,
      driverState: { shell: { status: undefined, lastFailedEffect: undefined } },
    }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies the complete setup-URI host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: { vaultId: 'vault-1' },
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-2',
    setupToken: 'setup-token',
    bootstrapMode: 'join-existing',
  })

  assert.equal(obsidianMocks.FakeModal.last, previousModal)
  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(lifecycleMocks.handleLifecycleResume.mock.calls.length, 0)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: this device already has registration metadata; URI was not applied',
  )
})

test('rejects setup URI application while a pending setup response exists', () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const previousModal = obsidianMocks.FakeModal.last
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const lifecycle = {
    requestReplan: vi.fn(),
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({ tickInFlight: false }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the busy-state host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: {
      endpoint: 'https://sync.example.test',
      vaultId: 'vault-1',
      deviceId: 'device-1',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenVersion: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    },
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token',
  })

  assert.equal(obsidianMocks.FakeModal.last, previousModal)
  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: setup is already in progress; URI was not applied',
  )
})

test('rejects setup URI application while a settings write is in progress', () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const previousModal = obsidianMocks.FakeModal.last
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const lifecycle = {
    requestReplan: vi.fn(),
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({ tickInFlight: false }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the busy-state host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    settingsWritePromise: Promise.resolve(),
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token',
  })

  assert.equal(obsidianMocks.FakeModal.last, previousModal)
  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: setup is already in progress; URI was not applied',
  )
})

test('rejects setup URI application while a lifecycle startup tick is in flight', () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const previousModal = obsidianMocks.FakeModal.last
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const lifecycle = {
    requestReplan: vi.fn(),
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({ tickInFlight: true }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the busy-state host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token',
  })

  assert.equal(obsidianMocks.FakeModal.last, previousModal)
  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: setup is already in progress; URI was not applied',
  )
})

test('rechecks trusted metadata when the confirmation modal is applied', () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const lifecycle = {
    requestReplan: vi.fn(),
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({ tickInFlight: false }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the setup-URI host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token',
  })
  const modal = obsidianMocks.FakeModal.last
  assert(modal)
  plugin.trustedSetupMetadata = {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    deviceId: 'device-1',
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  }
  const applyButton = [...modal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(applyButton)
  applyButton.click()

  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(lifecycleMocks.handleLifecycleResume.mock.calls.length, 0)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: this device already has registration metadata; URI was not applied',
  )
})

test('does not write until confirmation and resumes after applying without rendering the token', async () => {
  obsidianMocks.FakeNotice.messages = []
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const requestReplan = vi.fn()
  const lifecycle = {
    requestReplan,
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({
      tickInFlight: false,
      driverState: { shell: { status: undefined, lastFailedEffect: undefined } },
    }),
  }
  const onApplied = vi.fn(() => {
    assert.equal(obsidianMocks.FakeNotice.messages.at(-1), 'Kuroflare setup: URI applied')
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies the complete setup-URI host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin
  const setupToken = 'setup-token-for-boundary-test'

  confirmAndApplySetupUri(
    plugin,
    {
      endpoint: 'https://sync.example.test',
      vaultId: 'vault-1',
      setupToken,
      bootstrapMode: 'join-existing',
    },
    onApplied,
  )

  const modal = obsidianMocks.FakeModal.last
  assert(modal)
  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(modal.contentEl.textContent?.includes(setupToken), false)
  assert.equal(modal.contentEl.textContent?.includes('Bootstrap mode: join-existing'), true)

  const applyButton = [...modal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(applyButton)
  applyButton.click()
  await vi.waitFor(() => assert.equal(updateSettings.mock.calls.length, 1))

  assert.deepEqual(updateSettings.mock.calls[0]?.[0], {
    endpoint: 'https://sync.example.test',
    setupVaultId: 'vault-1',
    setupToken,
    setupBootstrapMode: 'join-existing',
  })
  assert.equal(requestReplan.mock.calls.length, 1)
  assert.deepEqual(lifecycleMocks.handleLifecycleResume.mock.calls[0]?.slice(1), ['setup-uri'])
  await vi.waitFor(() => assert.equal(onApplied.mock.calls.length, 1))
})

test('uses the current bootstrap mode when a legacy URI omits it', async () => {
  vi.clearAllMocks()
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  const requestReplan = vi.fn()
  const lifecycle = {
    requestReplan,
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({
      tickInFlight: false,
      driverState: { shell: { status: undefined, lastFailedEffect: undefined } },
    }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies the complete setup-URI host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    kuroflareSettings: { setupBootstrapMode: 'join-existing' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'legacy-setup-token',
  })

  const modal = obsidianMocks.FakeModal.last
  assert(modal)
  assert.equal(modal.contentEl.textContent?.includes('join-existing'), true)
  const applyButton = [...modal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(applyButton)
  applyButton.click()
  await vi.waitFor(() => assert.equal(updateSettings.mock.calls.length, 1))

  assert.deepEqual(updateSettings.mock.calls[0]?.[0], {
    endpoint: 'https://sync.example.test',
    setupVaultId: 'vault-1',
    setupToken: 'legacy-setup-token',
    setupBootstrapMode: 'join-existing',
  })
  assert.equal(requestReplan.mock.calls.length, 1)
  assert.deepEqual(lifecycleMocks.handleLifecycleResume.mock.calls[0]?.slice(1), ['setup-uri'])
})

test('rejects a second URI while the first application is still in flight', async () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  let releaseTick: () => void = () => undefined
  const tick = new Promise<void>((resolve) => {
    releaseTick = resolve
  })
  let tickInFlight = false
  const requestReplan = vi.fn(() => {
    tickInFlight = true
  })
  const runStartupTick = vi.fn(async () => {
    await tick
    tickInFlight = false
  })
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies the complete setup-URI host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: {
      lifecycle: {
        requestReplan,
        runStartupTick,
        snapshot: () => ({
          tickInFlight,
          driverState: { shell: { status: undefined, lastFailedEffect: undefined } },
        }),
      },
    },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-a',
    setupToken: 'setup-token-a',
    bootstrapMode: 'new-vault',
  })
  const firstModal = obsidianMocks.FakeModal.last
  assert(firstModal)
  const firstApplyButton = [...firstModal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(firstApplyButton)
  firstApplyButton.click()
  await vi.waitFor(() => assert.equal(updateSettings.mock.calls.length, 1))

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-b',
    setupToken: 'setup-token-b',
    bootstrapMode: 'join-existing',
  })

  assert.equal(obsidianMocks.FakeModal.last, firstModal)
  assert.equal(updateSettings.mock.calls.length, 1)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: setup is already in progress; URI was not applied',
  )

  releaseTick()
  await vi.waitFor(() => assert.equal(runStartupTick.mock.calls.length, 1))
  await vi.waitFor(() => assert.equal(tickInFlight, false))
})

test('reports setup URI application failures without exposing the error', async () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => {
    throw new Error('setup-token-secret')
  })
  const requestReplan = vi.fn()
  const lifecycle = {
    requestReplan,
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => ({ tickInFlight: false }),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies the complete setup-URI host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token',
    bootstrapMode: 'new-vault',
  })
  const modal = obsidianMocks.FakeModal.last
  assert(modal)
  const applyButton = [...modal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(applyButton)
  applyButton.click()

  await vi.waitFor(() =>
    assert.equal(
      obsidianMocks.FakeNotice.messages.at(-1),
      'Kuroflare setup: URI application failed',
    ),
  )
  assert.equal(
    obsidianMocks.FakeNotice.messages.some((message) => message.includes('secret')),
    false,
  )
  assert.equal(requestReplan.mock.calls.length, 0)
})

test('does not report success when startup is rejected and clears the staged response', async () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  let applyStarted = false
  let plugin!: KuroflareSpikePlugin
  const pendingResponse = {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    deviceId: 'device-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault' as const,
  }
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => {
    applyStarted = true
  })
  const lifecycle = {
    requestReplan: vi.fn(),
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => {
      if (applyStarted) plugin.pendingSetupResponse = pendingResponse
      return {
        tickInFlight: false,
        driverState: {
          shell: { status: 'rejected', lastFailedEffect: undefined },
          startupPlan: { sync: { clientPlan: { action: 'reject' } } },
        },
      }
    },
  }
  const onApplied = vi.fn()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the setup-URI host surface.
  plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(
    plugin,
    {
      endpoint: 'https://sync.example.test',
      vaultId: 'vault-1',
      setupToken: 'setup-token',
      bootstrapMode: 'new-vault',
    },
    onApplied,
  )
  const firstModal = obsidianMocks.FakeModal.last
  assert(firstModal)
  const firstApplyButton = [...firstModal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(firstApplyButton)
  firstApplyButton.click()

  await vi.waitFor(() =>
    assert.equal(
      obsidianMocks.FakeNotice.messages.at(-1),
      'Kuroflare setup: URI application failed',
    ),
  )
  assert.equal(obsidianMocks.FakeNotice.messages.includes('Kuroflare setup: URI applied'), false)
  assert.equal(onApplied.mock.calls.length, 0)
  assert.equal(plugin.pendingSetupResponse, null)

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token-retry',
    bootstrapMode: 'new-vault',
  })
  assert.notEqual(obsidianMocks.FakeModal.last, firstModal)
})

test('keeps staged credentials after a transient startup-step failure', async () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  let applyStarted = false
  let plugin!: KuroflareSpikePlugin
  const pendingResponse = {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    deviceId: 'device-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault' as const,
  }
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => {
    applyStarted = true
  })
  const lifecycle = {
    requestReplan: vi.fn(),
    runStartupTick: vi.fn(async () => undefined),
    snapshot: () => {
      if (applyStarted) plugin.pendingSetupResponse = pendingResponse
      return {
        tickInFlight: false,
        driverState: {
          shell: {
            status: 'rejected',
            lastFailedEffect: {
              effect: {
                kind: 'run-sync-startup-effect',
                effect: {
                  kind: 'run-startup-step',
                  vaultId: 'vault-1',
                  step: 'persist-setup-response',
                  phase: 'setup',
                },
              },
              reason: 'persist-setup-response-failed',
            },
          },
          startupPlan: {
            sync: { clientPlan: { action: 'bootstrap-new-vault' } },
          },
        },
      }
    },
  }
  const onApplied = vi.fn()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the setup-URI host surface.
  plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    syncRuntime: { lifecycle },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(
    plugin,
    {
      endpoint: 'https://sync.example.test',
      vaultId: 'vault-1',
      setupToken: 'setup-token',
      bootstrapMode: 'new-vault',
    },
    onApplied,
  )
  const firstModal = obsidianMocks.FakeModal.last
  assert(firstModal)
  const firstApplyButton = [...firstModal.contentEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply',
  )
  assert(firstApplyButton)
  firstApplyButton.click()

  await vi.waitFor(() =>
    assert.equal(
      obsidianMocks.FakeNotice.messages.at(-1),
      'Kuroflare setup: URI application failed',
    ),
  )
  assert.equal(obsidianMocks.FakeNotice.messages.includes('Kuroflare setup: URI applied'), false)
  assert.equal(onApplied.mock.calls.length, 0)
  assert.equal(plugin.pendingSetupResponse, pendingResponse)

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token-retry',
    bootstrapMode: 'new-vault',
  })
  assert.equal(obsidianMocks.FakeModal.last, firstModal)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: setup is already in progress; URI was not applied',
  )
})

test('rejects setup URI before writing when the sync runtime is unavailable', () => {
  vi.clearAllMocks()
  obsidianMocks.FakeNotice.messages = []
  const previousModal = obsidianMocks.FakeModal.last
  const updateSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the unavailable-runtime host surface.
  const plugin = {
    app: {},
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    syncRuntime: null,
    kuroflareSettings: { setupBootstrapMode: 'new-vault' },
    updateSettings,
  } as unknown as KuroflareSpikePlugin

  confirmAndApplySetupUri(plugin, {
    endpoint: 'https://sync.example.test',
    vaultId: 'vault-1',
    setupToken: 'setup-token',
  })

  assert.equal(obsidianMocks.FakeModal.last, previousModal)
  assert.equal(updateSettings.mock.calls.length, 0)
  assert.equal(
    obsidianMocks.FakeNotice.messages.at(-1),
    'Kuroflare setup: sync runtime is unavailable; URI was not applied',
  )
})
