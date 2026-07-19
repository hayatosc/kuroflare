// @vitest-environment jsdom

import { makeDeviceId, makeVaultId, makeYDocId } from '@kuroflare/core'
import * as v from 'valibot'
import { assert, beforeEach, describe, test, vi } from 'vitest'

import type KuroflareSpikePlugin from '../../host/plugin'
import type { LocalSetupMetadata } from '../engine/setup'
import type * as SnapshotHealthUi from './snapshot-health-ui'

vi.mock('obsidian', () => {
  class FakeButtonComponent {
    readonly buttonEl = document.createElement('button')

    constructor(parent: HTMLElement) {
      parent.append(this.buttonEl)
    }

    setButtonText(value: string): this {
      this.buttonEl.textContent = value
      return this
    }

    setCta(): this {
      return this
    }

    setWarning(): this {
      return this
    }

    setDisabled(value: boolean): this {
      this.buttonEl.disabled = value
      return this
    }

    onClick(callback: () => void): this {
      this.buttonEl.addEventListener('click', () => callback())
      return this
    }
  }

  class FakeTextComponent {
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
      const notify = () => callback(this.inputEl.value)
      this.inputEl.addEventListener('input', notify)
      this.inputEl.addEventListener('change', notify)
      return this
    }
  }

  class FakeSetting {
    readonly settingEl = document.createElement('div')

    constructor(parent: HTMLElement) {
      this.settingEl.className = 'setting'
      parent.append(this.settingEl)
    }

    setName(value: string): this {
      const element = this.settingEl.querySelector('.setting-name') ?? document.createElement('div')
      element.className = 'setting-name'
      element.textContent = value
      this.settingEl.append(element)
      return this
    }

    setDesc(value: string): this {
      const element =
        this.settingEl.querySelector('.setting-description') ?? document.createElement('div')
      element.className = 'setting-description'
      element.textContent = value
      this.settingEl.append(element)
      return this
    }

    addText(callback: (text: FakeTextComponent) => void): this {
      const text = new FakeTextComponent(this.settingEl)
      callback(text)
      return this
    }

    addButton(callback: (button: FakeButtonComponent) => void): this {
      const button = new FakeButtonComponent(this.settingEl)
      callback(button)
      return this
    }
  }

  return { ButtonComponent: FakeButtonComponent, Notice: class {}, Setting: FakeSetting }
})

const setup = {
  endpoint: 'https://sync.example.test/base',
  vaultId: makeVaultId('vault-1'),
  deviceId: makeDeviceId('device-1'),
  protocolVersion: 1,
  bootstrapMode: 'join-existing',
  tokenVersion: 1,
} satisfies LocalSetupMetadata

const docId = { kind: 'file', ydocId: makeYDocId('ydoc-1') } as const
const snapshotKey = 'snapshots/vault-1/file/1.yupdate'
const unverifiedEntry = {
  docId,
  snapshotKey,
  upperSeq: 1,
  actor: 'system:legacy',
  authorityStatus: 'candidate' as const,
  allowedActions: ['verify'] as ('verify' | 'quarantine' | 'rollback')[],
  physicalStatus: 'unverified' as const,
  logicalStatus: 'healthy' as const,
  reasons: ['missing-evidence'],
  observedAt: 10,
}
const verifiedEntry = {
  ...unverifiedEntry,
  actor: 'device-1',
  authorityStatus: 'authoritative' as const,
  allowedActions: ['quarantine', 'rollback'] as ('verify' | 'quarantine' | 'rollback')[],
  physicalStatus: 'verified' as const,
  reasons: ['operator-approved'],
}
const verifiedCandidateEntry = {
  ...verifiedEntry,
  authorityStatus: 'candidate' as const,
  allowedActions: ['quarantine'] as ('verify' | 'quarantine' | 'rollback')[],
}
const legacyUntrackedEntry = {
  ...unverifiedEntry,
  allowedActions: [],
  actionBlockReason: 'snapshot-health-approval-not-authoritative',
}
const lastHealthyEntry = {
  ...verifiedEntry,
  allowedActions: ['rollback'] as ('verify' | 'quarantine' | 'rollback')[],
  actionBlockReason: 'snapshot-health-quarantine-would-break-floor',
}

describe('snapshot health Obsidian settings UI', () => {
  let renderSnapshotHealthAdmin: typeof SnapshotHealthUi.renderSnapshotHealthAdmin
  type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  let fetchMock: ReturnType<typeof vi.fn<Fetch>>

  beforeEach(async () => {
    ;({ renderSnapshotHealthAdmin } = await import('./snapshot-health-ui'))
    document.body.replaceChildren()
    installObsidianDomHelpers()
    fetchMock = vi.fn<Fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  test('explains composite authority and the SQLite-loss disaster boundary', () => {
    const container = document.createElement('div')
    renderSnapshotHealthAdmin(container, fakePlugin())

    assert.include(
      container.textContent,
      'Recovery authority is composite: the latest authoritative, verified, healthy R2 snapshot plus later Durable Object SQLite operation-log rows.',
    )
    assert.include(
      container.textContent,
      'Normal runtime eviction is recoverable because SQLite survives.',
    )
    assert.include(container.textContent, 'Complete SQLite loss is a disaster/manual-recovery case')
    assert.include(
      container.textContent,
      'Checkpoint triggers (128 operations or 30 seconds) are best effort, not a recovery-point bound.',
    )
  })

  test('renders statuses and actor, paginates, and refreshes after verify with one submit', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: [unverifiedEntry], nextCursor: '1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, entry: verifiedEntry }))
      .mockResolvedValueOnce(jsonResponse({ entries: [verifiedEntry] }))

    const container = document.createElement('div')
    renderSnapshotHealthAdmin(container, fakePlugin())
    document.body.append(container)

    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 1 snapshot health entry.')
    assert.include(container.textContent, 'Physical: unverified')
    assert.include(container.textContent, 'Logical: healthy')
    assert.include(container.textContent, 'Authority: candidate')
    assert.include(container.textContent, 'Reason: missing-evidence')
    assert.include(container.textContent, 'Audit time: 1970-01-01T00:00:00.010Z')
    assert.include(container.textContent, 'Actor: system:legacy')

    const verify = clickTarget(container, 'Verify')
    assert.equal(verify.disabled, true)
    setInput(container, 'verify reason', 'operator approved')
    setInput(container, 'verify confirmation', 'VERIFY SNAPSHOT')
    assert.equal(verify.disabled, false)
    verify.click()
    verify.click()
    await waitForText(container, 'Success: loaded 1 snapshot health entry.')
    assert.include(container.textContent, 'Physical: verified')
    assert.include(container.textContent, 'Authority: authoritative')
    assert.equal(fetchMock.mock.calls.length, 3)
    assert.equal(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length, 1)

    const next = clickTarget(container, 'Next')
    assert.equal(next.disabled, true)
  })

  test('requires separate destructive confirmations and surfaces invalid responses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: [verifiedEntry], nextCursor: '2' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid' }))

    const container = document.createElement('div')
    renderSnapshotHealthAdmin(container, fakePlugin())
    document.body.append(container)
    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 1 snapshot health entry.')

    const quarantine = clickTarget(container, 'Quarantine')
    const rollback = clickTarget(container, 'Rollback')
    assert.equal(quarantine.disabled, true)
    assert.equal(rollback.disabled, true)
    setInput(container, 'quarantine reason', 'operator quarantine')
    setInput(container, 'quarantine confirmation', 'QUARANTINE SNAPSHOT')
    assert.equal(quarantine.disabled, false)
    assert.equal(rollback.disabled, true)
    quarantine.click()
    await waitForText(container, 'Snapshot health response was invalid.')
    assert.equal(quarantine.disabled, false)

    const next = clickTarget(container, 'Next')
    assert.equal(next.disabled, false)
    next.click()
    await waitForText(container, 'Snapshot health response was invalid.')
  })

  test('keeps rollback unavailable for a verified candidate while allowing quarantine', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [verifiedCandidateEntry] }))

    const container = document.createElement('div')
    renderSnapshotHealthAdmin(container, fakePlugin())
    document.body.append(container)
    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 1 snapshot health entry.')

    assert.isDefined(clickTarget(container, 'Quarantine'))
    assert.isFalse(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Rollback',
      ),
    )
    assert.include(container.textContent, 'Authority: candidate')
  })

  test('uses server-computed allowed actions and shows a block reason when none are allowed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ entries: [legacyUntrackedEntry, lastHealthyEntry] }),
    )

    const container = document.createElement('div')
    renderSnapshotHealthAdmin(container, fakePlugin())
    document.body.append(container)
    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 2 snapshot health entries.')

    const buttons = Array.from(container.querySelectorAll('button'))
    assert.isFalse(buttons.some((button) => button.textContent === 'Verify'))
    assert.isFalse(buttons.some((button) => button.textContent === 'Quarantine'))
    assert.isTrue(buttons.some((button) => button.textContent === 'Rollback'))
    assert.include(
      container.textContent,
      'Actions blocked: snapshot-health-approval-not-authoritative',
    )
  })
})

function fakePlugin(): KuroflareSpikePlugin {
  // Test fixture supplies only the plugin fields consumed by the operator surface.
  return v.parse(
    v.custom<KuroflareSpikePlugin>((v) => typeof v === 'object' && v !== null),
    {
      pendingSetupResponse: null,
      trustedSetupMetadata: setup,
      kuroflareSettings: {},
      app: { secretStorage: { getSecret: () => 'device-access-token' } },
    },
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clickButton(container: HTMLElement, text: string): void {
  clickTarget(container, text).click()
}

function clickTarget(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === text,
  )
  assert.isDefined(button)
  return button
}

function setInput(container: HTMLElement, label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  assert.isNotNull(input)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(() => assert.include(container.textContent, text))
}

function installObsidianDomHelpers(): void {
  HTMLElement.prototype.setText = function setText(value: string): void {
    this.textContent = value
  }
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren()
  }
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: string | Record<string, unknown>,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag)
    const info = typeof options === 'object' && options !== null ? options : undefined
    if (typeof options === 'string') element.textContent = options
    if (typeof info?.text === 'string') element.textContent = info.text
    if (typeof info?.cls === 'string') element.className = info.cls
    const attributes = info?.attr
    for (const [name, value] of Object.entries(
      typeof attributes === 'object' && attributes !== null ? attributes : {},
    )) {
      element.setAttribute(name, value)
    }
    this.append(element)
    return element
  }
  HTMLElement.prototype.toggle = function toggle(show: boolean): void {
    this.hidden = !show
  }
}
