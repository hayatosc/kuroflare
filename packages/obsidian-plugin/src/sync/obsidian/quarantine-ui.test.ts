// @vitest-environment jsdom

import {
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { assert, beforeEach, describe, test, vi } from 'vitest'

import type KuroflareSpikePlugin from '../../main'
import type { LocalSetupMetadata } from '../engine/setup'
import type * as QuarantineUi from './quarantine-ui'

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

    get descEl(): HTMLElement {
      return (
        this.settingEl.querySelector<HTMLElement>('.setting-description') ??
        this.settingEl.createEl('div')
      )
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

const entry = {
  id: 'quarantine-1',
  docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
  messageId: makeMessageId('message-1'),
  deviceId: makeDeviceId('device-1'),
  reason: 'yjs-apply-failed',
  updateSha256: makeSha256Hex('a'.repeat(64)),
  updateBytesLength: 4,
  createdAt: 10,
}

const auditEntry = {
  quarantineId: 'quarantine-1',
  docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
  messageId: makeMessageId('message-1'),
  deviceId: makeDeviceId('device-1'),
  reason: 'yjs-apply-failed',
  action: 'discarded-by-admin',
  actor: makeDeviceId('device-2'),
  quarantinedAt: 10,
  resolvedAt: 20,
}

describe('quarantine admin Obsidian settings UI', () => {
  let renderQuarantineAdmin: typeof QuarantineUi.renderQuarantineAdmin
  type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  let fetchMock: ReturnType<typeof vi.fn<Fetch>>

  beforeEach(async () => {
    ;({ renderQuarantineAdmin } = await import('./quarantine-ui'))
    document.body.replaceChildren()
    installObsidianDomHelpers()
    fetchMock = vi.fn<Fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  test('lists entries and paginates with load more', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [entry], nextCursor: '10:quarantine-1' }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))

    const container = document.createElement('div')
    renderQuarantineAdmin(container, fakePlugin())
    document.body.append(container)

    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 1 quarantined update.')
    assert.include(container.textContent, 'quarantine-1: yjs-apply-failed')

    const listMore = queryButtons(container, 'Load more')[0]
    assert.isDefined(listMore)
    assert.equal(listMore.disabled, false)
    listMore.click()
    await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 2))
    assert.include(expectString(fetchMock.mock.calls[1]?.[0]), 'cursor=10%3Aquarantine-1')
  })

  test('prepares, requires the typed confirmation text, and executes force-apply', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [entry] }))
      .mockResolvedValueOnce(
        jsonResponse({
          action: 'force-apply',
          id: entry.id,
          mode: 'dry-run',
          confirmationRequired: true,
          confirmationToken: 'token-1',
          effects: [{ kind: 'quarantine-force-apply', count: 1, detail: 'seq=1' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          action: 'force-apply',
          id: entry.id,
          applied: true,
          effects: [{ kind: 'quarantine-force-apply', count: 1, detail: 'seq=1' }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [auditEntry] }))

    const container = document.createElement('div')
    renderQuarantineAdmin(container, fakePlugin())
    document.body.append(container)
    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 1 quarantined update.')

    clickButton(container, 'Prepare force apply')
    await waitForText(container, 'seq=1')
    assert.include(container.textContent, 'Type FORCE APPLY QUARANTINE to confirm.')

    const confirm = clickTarget(container, 'Confirm')
    assert.equal(confirm.disabled, true)
    setInput(container, 'force-apply confirmation', 'FORCE APPLY QUARANTINE')
    assert.equal(confirm.disabled, false)
    confirm.click()

    await waitForText(container, 'Success: force apply applied.')
    assert.isFalse(container.textContent?.includes('quarantine-1: yjs-apply-failed'))
    assert.include(container.textContent, 'quarantine-1: discarded-by-admin')
    assert.equal(fetchMock.mock.calls.length, 4)
    assert.equal(
      JSON.parse(expectString(fetchMock.mock.calls[2]?.[1]?.body)).confirmationToken,
      'token-1',
    )
  })

  test('surfaces an error when preparing an action fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [entry] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))

    const container = document.createElement('div')
    renderQuarantineAdmin(container, fakePlugin())
    document.body.append(container)
    clickButton(container, 'Refresh')
    await waitForText(container, 'Success: loaded 1 quarantined update.')

    clickButton(container, 'Prepare discard')
    await waitForText(container, 'Quarantine action request failed (HTTP 503).')
  })
})

// oxlint-disable no-unsafe-type-assertion
function fakePlugin(): KuroflareSpikePlugin {
  // Test fixture supplies only the plugin fields consumed by the operator surface.
  // oxlint-disable-next-line no-unsafe-type-assertion
  return {
    pendingSetupResponse: null,
    trustedSetupMetadata: setup,
    kuroflareSettings: {},
    app: { secretStorage: { getSecret: () => 'device-access-token' } },
  } as unknown as KuroflareSpikePlugin
}
// oxlint-enable no-unsafe-type-assertion

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function expectString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${typeof value}`)
  return value
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

function queryButtons(container: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (candidate) => candidate.textContent === text,
  )
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
