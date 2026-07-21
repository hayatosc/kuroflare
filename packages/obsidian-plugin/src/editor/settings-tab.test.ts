// @vitest-environment jsdom

import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import type { App } from 'obsidian'
import { assert, beforeEach, test, vi } from 'vitest'

import type KuroflareSpikePlugin from '../host/plugin'
import type { WorkerVersionFetchResult } from '../sync/worker-version'

function installObsidianDomHelpers(): void {
  Object.defineProperties(HTMLElement.prototype, {
    createEl: {
      configurable: true,
      value: function createEl(
        this: HTMLElement,
        tag: string,
        options?: {
          readonly text?: string
          readonly cls?: string
          readonly attr?: Record<string, string>
        },
      ): HTMLElement {
        const child = document.createElement(tag)
        if (options?.text !== undefined) child.textContent = options.text
        if (options?.cls !== undefined) child.className = options.cls
        for (const [key, value] of Object.entries(options?.attr ?? {})) {
          child.setAttribute(key, value)
        }
        this.append(child)
        return child
      },
    },
    createDiv: {
      configurable: true,
      value: function createDiv(
        this: HTMLElement,
        options?: { readonly cls?: string },
      ): HTMLElement {
        return this.createEl('div', options)
      },
    },
    empty: {
      configurable: true,
      value: function empty(this: HTMLElement): void {
        this.replaceChildren()
      },
    },
  })
}

const obsidianMocks = vi.hoisted(() => {
  class FakeButton {
    readonly buttonEl = document.createElement('button')

    constructor(parent: HTMLElement) {
      parent.append(this.buttonEl)
    }

    setButtonText(value: string): this {
      this.buttonEl.textContent = value
      return this
    }

    setDisabled(value: boolean): this {
      this.buttonEl.disabled = value
      return this
    }

    setIcon(): this {
      return this
    }

    setTooltip(): this {
      return this
    }

    onClick(callback: () => void): this {
      this.buttonEl.addEventListener('click', callback)
      return this
    }
  }

  class FakeText {
    readonly inputEl = document.createElement('input')

    constructor(parent: HTMLElement) {
      parent.append(this.inputEl)
    }

    setPlaceholder(value: string): this {
      this.inputEl.placeholder = value
      return this
    }

    setValue(value: string): this {
      this.inputEl.value = value
      return this
    }

    onChange(callback: (value: string) => void): this {
      this.inputEl.addEventListener('change', () => callback(this.inputEl.value))
      return this
    }
  }

  class FakeDropdown {
    addOption(): this {
      return this
    }

    setValue(): this {
      return this
    }

    onChange(): this {
      return this
    }
  }

  class FakeSetting {
    readonly settingEl = document.createElement('div')

    constructor(parent: HTMLElement) {
      parent.append(this.settingEl)
    }

    setName(value: string): this {
      this.settingEl.dataset.name = value
      return this
    }

    setDesc(value: string): this {
      this.settingEl.dataset.description = value
      return this
    }

    addTextArea(callback: (text: FakeText) => void): this {
      callback(new FakeText(this.settingEl))
      return this
    }

    addText(callback: (text: FakeText) => void): this {
      callback(new FakeText(this.settingEl))
      return this
    }

    addDropdown(callback: (dropdown: FakeDropdown) => void): this {
      callback(new FakeDropdown())
      return this
    }

    addButton(callback: (button: FakeButton) => void): this {
      callback(new FakeButton(this.settingEl))
      return this
    }

    addExtraButton(callback: (button: FakeButton) => void): this {
      callback(new FakeButton(this.settingEl))
      return this
    }
  }

  class FakePluginSettingTab {
    readonly containerEl = document.createElement('div')

    constructor(..._args: unknown[]) {}

    hide(): void {}
  }

  class FakeNotice {
    static messages: string[] = []

    constructor(message: string) {
      FakeNotice.messages.push(message)
    }
  }

  return { FakeNotice, FakePluginSettingTab, FakeSetting }
})

vi.mock('obsidian', () => ({
  Notice: obsidianMocks.FakeNotice,
  PluginSettingTab: obsidianMocks.FakePluginSettingTab,
  Setting: obsidianMocks.FakeSetting,
}))

vi.mock('../host/setup-uri', () => ({
  confirmAndApplySetupUri: vi.fn(),
}))
vi.mock('../sync/obsidian/quarantine-ui', () => ({
  renderQuarantineAdmin: vi.fn(),
}))
vi.mock('../sync/obsidian/snapshot-health-ui', () => ({
  renderSnapshotHealthAdmin: vi.fn(),
}))
vi.mock('../sync/obsidian/repair-ui', () => ({
  planLocalStoreRepairSettingsPresentation: () => ({
    emptyStateText: 'No degraded local store state reported.',
    evidenceDescription: 'No repair evidence.',
    exportDescription: 'Export local outbox.',
    exportButtonText: 'Export',
    importDefaultPath: '',
    rebuildDescription: 'Rebuild local store.',
  }),
}))
vi.mock('../sync/obsidian/rejected-repair-ui', () => ({
  planRejectedUpdateRepairOutcomePresentation: vi.fn(),
  planRejectedUpdateRepairSettingsPresentation: () => ({
    description: 'Rejected update repair.',
    emptyStateText: 'No paused rejected updates loaded.',
    refreshButtonText: 'Refresh',
    disabled: true,
  }),
}))
vi.mock('../sync/worker-version', () => ({
  fetchWorkerVersion: vi.fn(async () => ({ ok: false, reason: 'network' })),
}))
vi.mock('../host/auth', () => ({
  currentSetupMetadata: vi.fn(() => undefined),
  readAccessToken: vi.fn(async () => undefined),
  requireSetupMetadata: vi.fn(),
}))
vi.mock('../sync/auth/invite', () => ({
  issueDeviceInviteSetupToken: vi.fn(),
  buildDeviceInviteSetupUri: vi.fn(() => 'kuroflare://setup?stub'),
}))

import { currentSetupMetadata, readAccessToken } from '../host/auth'
import { issueDeviceInviteSetupToken } from '../sync/auth/invite'
import { fetchWorkerVersion } from '../sync/worker-version'
import { KuroflareSettingTab } from './settings-tab'

const fetchWorkerVersionMock = vi.mocked(fetchWorkerVersion)
const currentSetupMetadataMock = vi.mocked(currentSetupMetadata)
const readAccessTokenMock = vi.mocked(readAccessToken)
const issueDeviceInviteSetupTokenMock = vi.mocked(issueDeviceInviteSetupToken)

beforeEach(() => {
  document.body.replaceChildren()
  fetchWorkerVersionMock.mockReset()
  currentSetupMetadataMock.mockReset().mockReturnValue(undefined)
  readAccessTokenMock.mockReset()
  issueDeviceInviteSetupTokenMock.mockReset()
  fetchWorkerVersionMock.mockResolvedValue({ ok: false, reason: 'network' })
})

function createPathRepairPlugin(
  retryPathConflictRepairEntry: KuroflareSpikePlugin['retryPathConflictRepairEntry'],
): KuroflareSpikePlugin {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test supplies only the host surface rendered by this settings tab.
  return {
    app: {},
    kuroflareSettings: {
      endpoint: 'https://sync.example.test',
      setupVaultId: '',
      setupToken: '',
      requestedDeviceName: 'Obsidian',
      repairLog: [
        {
          id: 'repair-1',
          kind: 'path-conflict',
          fileId: 'file-1',
          path: 'Notes/conflict.md',
          reason: 'path-conflict-renamed',
          createdAt: 1,
        },
      ],
    },
    syncRepairEntries: [],
    syncRejectedUpdateRepairEntries: [],
    invalidMetaIsolationDetail: null,
    binaryRestoreCheckDetail: null,
    trustedSetupMetadata: null,
    pendingSetupResponse: null,
    syncStoppedByAuth: null,
    getSyncRejectedUpdateRepairEntriesSnapshot: () => [],
    refreshSyncRejectedUpdateRepairEntries: vi.fn(async () => undefined),
    repairSyncRejectedUpdate: vi.fn(),
    updateSettings: vi.fn(async () => undefined),
    inspectInvalidMetaRepairEntry: vi.fn(async () => undefined),
    discardInvalidMetaRepairEntry: vi.fn(async () => undefined),
    resolveRemoteMaterializeBlockedRepairEntry: vi.fn(async () => undefined),
    retryRemoteMaterializeBlockedRepairEntry: vi.fn(async () => undefined),
    clearRepairLogEntry: vi.fn(async () => undefined),
    resolvePathConflictRepairEntry: vi.fn(async () => undefined),
    retryPathConflictRepairEntry,
    retryKeepDeletedRepairEntry: vi.fn(async () => undefined),
  } as unknown as KuroflareSpikePlugin
}

function createDeferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test('re-probes a changed endpoint and ignores the stale previous result', async () => {
  installObsidianDomHelpers()
  const oldProbe = createDeferred<WorkerVersionFetchResult>()
  const newProbe = createDeferred<WorkerVersionFetchResult>()
  fetchWorkerVersionMock
    .mockImplementationOnce(async () => oldProbe.promise)
    .mockImplementationOnce(async () => newProbe.promise)
  const plugin = createPathRepairPlugin(vi.fn(async () => undefined))
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  document.body.append(tab.containerEl)
  tab.display()

  const versionHeading = Array.from(tab.containerEl.querySelectorAll('h3')).find(
    (heading) => heading.textContent === 'Worker version',
  )
  assert(versionHeading)
  const versionContainer = versionHeading.nextElementSibling
  assert(versionContainer instanceof HTMLElement)
  const endpointInput = tab.containerEl.querySelector<HTMLInputElement>(
    '[data-name="Worker endpoint"] input',
  )
  assert(endpointInput)
  endpointInput.value = ' https://new-worker.example/path '
  endpointInput.dispatchEvent(new Event('change'))

  assert.deepEqual(
    fetchWorkerVersionMock.mock.calls.map(([endpoint]) => endpoint),
    ['https://sync.example.test', 'https://new-worker.example/path'],
  )
  assert.match(versionContainer.textContent ?? '', /Checking Worker version/)

  oldProbe.resolve({
    ok: true,
    value: {
      productVersion: '0.1.1',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      minimumPluginVersion: '0.1.0',
      channel: 'stable',
      buildCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deploymentVersionId: 'old-deployment',
    },
  })
  await oldProbe.promise
  await Promise.resolve()
  assert.equal(versionContainer.textContent?.includes('old-deployment'), false)
  assert.match(versionContainer.textContent ?? '', /Checking Worker version/)

  newProbe.resolve({
    ok: true,
    value: {
      productVersion: '0.2.0',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      minimumPluginVersion: '0.1.0',
      channel: 'beta',
      buildCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      deploymentVersionId: 'new-deployment',
    },
  })
  await vi.waitFor(() => assert.match(versionContainer.textContent ?? '', /new-deployment/))
  assert.equal(versionContainer.textContent?.includes('old-deployment'), false)
})

test('dispatches the path repair retry callback and refreshes after completion', async () => {
  installObsidianDomHelpers()
  const retryPathConflictRepairEntry = vi.fn(async () => undefined)
  const plugin = createPathRepairPlugin(retryPathConflictRepairEntry)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  tab.display()
  const display = vi.spyOn(tab, 'display').mockImplementation(() => undefined)

  const retryButton = [...tab.containerEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Retry path materialize',
  )
  assert(retryButton)
  retryButton.click()
  await vi.waitFor(() => assert.equal(retryPathConflictRepairEntry.mock.calls.length, 1))
  await vi.waitFor(() => assert.equal(display.mock.calls.length, 1))
})

test('reports repair action failures without exposing the error', async () => {
  installObsidianDomHelpers()
  obsidianMocks.FakeNotice.messages = []
  const retryPathConflictRepairEntry = vi.fn(async () => {
    throw new Error('repair-secret')
  })
  const plugin = createPathRepairPlugin(retryPathConflictRepairEntry)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  tab.display()

  const retryButton = [...tab.containerEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Retry path materialize',
  )
  assert(retryButton)
  retryButton.click()
  await vi.waitFor(() => assert.equal(retryPathConflictRepairEntry.mock.calls.length, 1))
  await vi.waitFor(() =>
    assert.equal(obsidianMocks.FakeNotice.messages.at(-1), 'Kuroflare: repair action failed'),
  )
  assert.equal(
    obsidianMocks.FakeNotice.messages.some((message) => message.includes('secret')),
    false,
  )
})

function localSetupMetadataFixture() {
  return {
    endpoint: 'https://sync.example.test',
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    protocolVersion: 1,
    bootstrapMode: 'join-existing',
    tokenVersion: 1,
  } as const
}

function findInviteButton(tab: KuroflareSettingTab): HTMLButtonElement | undefined {
  return [...tab.containerEl.querySelectorAll('button')].find(
    (button) => button.textContent === 'Generate invite',
  )
}

test('hides the invite action when there is no active device registration', () => {
  installObsidianDomHelpers()
  currentSetupMetadataMock.mockReturnValue(undefined)
  const plugin = createPathRepairPlugin(vi.fn(async () => undefined))
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  tab.display()

  const inviteButton = findInviteButton(tab)
  assert(inviteButton)
  assert.equal(inviteButton.disabled, true)
})

test('hides the invite action while auth is revoked even with setup metadata present', () => {
  installObsidianDomHelpers()
  currentSetupMetadataMock.mockReturnValue(localSetupMetadataFixture())
  const plugin = createPathRepairPlugin(vi.fn(async () => undefined))
  plugin.syncStoppedByAuth = 'revoked'
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  tab.display()

  const inviteButton = findInviteButton(tab)
  assert(inviteButton)
  assert.equal(inviteButton.disabled, true)
})

test('issues a device invite and renders the copyable setup URI with its expiry', async () => {
  installObsidianDomHelpers()
  currentSetupMetadataMock.mockReturnValue(localSetupMetadataFixture())
  readAccessTokenMock.mockResolvedValue('device-access-token')
  issueDeviceInviteSetupTokenMock.mockResolvedValue({
    ok: true,
    response: {
      setupToken: 'issued-token',
      vaultId: makeVaultId('vault-1'),
      expiresAt: 1_700_000_000_000,
    },
  })
  const plugin = createPathRepairPlugin(vi.fn(async () => undefined))
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  document.body.append(tab.containerEl)
  tab.display()

  const inviteButton = findInviteButton(tab)
  assert(inviteButton)
  assert.equal(inviteButton.disabled, false)
  inviteButton.click()

  await vi.waitFor(() => {
    const uriInput = tab.containerEl.querySelector<HTMLInputElement>(
      '[data-name="Invite link"] input',
    )
    assert(uriInput)
    assert.equal(uriInput.value, 'kuroflare://setup?stub')
  })
  const inviteSetting = tab.containerEl.querySelector<HTMLElement>('[data-name="Invite link"]')
  assert(inviteSetting)
  assert.match(inviteSetting.dataset.description ?? '', /2023-11-14T22:13:20\.000Z/)
})

test('reports an auth-rejected invite failure without rendering a setup URI', async () => {
  installObsidianDomHelpers()
  obsidianMocks.FakeNotice.messages = []
  currentSetupMetadataMock.mockReturnValue(localSetupMetadataFixture())
  readAccessTokenMock.mockResolvedValue('device-access-token')
  issueDeviceInviteSetupTokenMock.mockResolvedValue({
    ok: false,
    status: 401,
    error: { code: 'auth/rejected', retryable: false },
  })
  const plugin = createPathRepairPlugin(vi.fn(async () => undefined))
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mocked PluginSettingTab constructor does not inspect App.
  const tab = new KuroflareSettingTab({} as App, plugin)
  document.body.append(tab.containerEl)
  tab.display()

  const inviteButton = findInviteButton(tab)
  assert(inviteButton)
  inviteButton.click()

  await vi.waitFor(() =>
    assert.equal(
      obsidianMocks.FakeNotice.messages.at(-1),
      'Kuroflare invite: failed (auth/rejected)',
    ),
  )
  assert.equal(tab.containerEl.querySelector('[data-name="Invite link"]'), null)
})
