import { parseSetupUri } from '@kuroflare/core'
import { type App, Notice, PluginSettingTab, Setting } from 'obsidian'

import { readAccessToken, requireSetupMetadata } from '../host/auth'
import {
  DEVICE_REVOKE_CONFIRMATION,
  INVALID_META_DISCARD_CONFIRMATION,
  LOCAL_STORE_DISCARD_CONFIRMATION,
  LOCAL_STORE_REBUILD_CONFIRMATION,
} from '../host/constants'
import {
  accessTokenSecretKeyForSetup,
  deviceRevokeUrl,
  docIdLabel,
  repairLogDescription,
} from '../host/helpers'
import type KuroflareSpikePlugin from '../host/plugin'
import { renderQuarantineAdmin } from '../sync/obsidian/quarantine-ui'
import {
  planRejectedUpdateRepairOutcomePresentation,
  planRejectedUpdateRepairSettingsPresentation,
} from '../sync/obsidian/rejected-repair-ui'
import { planLocalStoreRepairSettingsPresentation } from '../sync/obsidian/repair-ui'
import { renderSnapshotHealthAdmin } from '../sync/obsidian/snapshot-health-ui'

export class KuroflareSettingTab extends PluginSettingTab {
  private rejectedRepairStatusText = ''

  constructor(
    app: App,
    private readonly plugin: KuroflareSpikePlugin,
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    const settings = this.plugin.kuroflareSettings
    containerEl.empty()

    let setupUri = ''
    new Setting(containerEl)
      .setName('Setup URI')
      .setDesc('Paste a kuroflare://setup URI to fill endpoint, vault ID, and setup token.')
      .addTextArea((text) => {
        text.setPlaceholder('kuroflare://setup?...').onChange((value) => {
          setupUri = value.trim()
        })
      })
      .addButton((button) => {
        button.setButtonText('Apply').onClick(() => {
          const parsed = parseSetupUri(setupUri)
          if (parsed === undefined) {
            new Notice('Kuroflare setup: invalid setup URI')
            return
          }
          void this.plugin
            .updateSettings({
              endpoint: parsed.endpoint,
              setupVaultId: parsed.vaultId,
              setupToken: parsed.setupToken,
            })
            .then(() => {
              new Notice('Kuroflare setup: setup URI applied')
              this.display()
            })
        })
      })

    new Setting(containerEl).setName('Worker endpoint').addText((text) => {
      text
        .setPlaceholder('http://127.0.0.1:8787')
        .setValue(settings.endpoint)
        .onChange((value) => {
          void this.plugin.updateSettings({ endpoint: value.trim() })
        })
    })

    new Setting(containerEl).setName('Vault ID').addText((text) => {
      text.setValue(settings.setupVaultId).onChange((value) => {
        void this.plugin.updateSettings({ setupVaultId: value.trim() })
      })
    })

    new Setting(containerEl).setName('Setup token').addText((text) => {
      text.setValue(settings.setupToken).onChange((value) => {
        void this.plugin.updateSettings({ setupToken: value.trim() })
      })
    })

    new Setting(containerEl).setName('Device name').addText((text) => {
      text.setValue(settings.requestedDeviceName).onChange((value) => {
        void this.plugin.updateSettings({ requestedDeviceName: value.trim() })
      })
    })

    new Setting(containerEl).setName('Bootstrap mode').addDropdown((dropdown) => {
      dropdown
        .addOption('new-vault', 'New vault')
        .addOption('join-existing', 'Join existing')
        .setValue(settings.setupBootstrapMode ?? 'new-vault')
        .onChange((value) => {
          if (value === 'new-vault' || value === 'join-existing') {
            void this.plugin.updateSettings({ setupBootstrapMode: value })
          }
        })
    })

    containerEl.createEl('h3', { text: 'Auth' })
    let revokeConfirmation = ''
    new Setting(containerEl)
      .setName('Revoke this device')
      .setDesc(
        `Stop this device from syncing and clear local token material. Pending local outbox entries are kept. Type ${DEVICE_REVOKE_CONFIRMATION} to confirm.`,
      )
      .addText((text) => {
        text.setPlaceholder(DEVICE_REVOKE_CONFIRMATION).onChange((value) => {
          revokeConfirmation = value.trim()
        })
      })
      .addButton((button) => {
        button.setButtonText('Revoke').onClick(() => {
          void (async () => {
            if (revokeConfirmation !== DEVICE_REVOKE_CONFIRMATION) return
            const setup = requireSetupMetadata(this.plugin)
            const token = await readAccessToken(this.plugin, accessTokenSecretKeyForSetup(setup))
            if (token === undefined) {
              new Notice('No access token')
              return
            }
            const response = await fetch(deviceRevokeUrl(setup), {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            })
            if (response.ok) {
              new Notice('Device revoked')
            } else {
              new Notice(`Revoke failed: ${response.status}`)
            }
            this.display()
          })()
        })
      })

    containerEl.createEl('h3', { text: 'Local store repair' })
    const runtimeRepairEntries = this.plugin.syncRepairEntries
    const repairExport = settings.localRepairExport
    const localStoreRepairPresentation = planLocalStoreRepairSettingsPresentation({
      repairEntries: runtimeRepairEntries,
      repairExport,
      rebuildConfirmation: LOCAL_STORE_REBUILD_CONFIRMATION,
      discardConfirmation: LOCAL_STORE_DISCARD_CONFIRMATION,
    })
    if (runtimeRepairEntries.length === 0) {
      if (localStoreRepairPresentation.emptyStateText !== undefined) {
        containerEl.createEl('p', { text: localStoreRepairPresentation.emptyStateText })
      }
    } else {
      for (const entry of runtimeRepairEntries) {
        new Setting(containerEl).setName(entry.title).setDesc(entry.description)
      }
    }
    new Setting(containerEl)
      .setName('Repair evidence')
      .setDesc(localStoreRepairPresentation.evidenceDescription)
    new Setting(containerEl)
      .setName('Export local outbox')
      .setDesc(localStoreRepairPresentation.exportDescription)
      .addButton((button) => {
        button.setButtonText(localStoreRepairPresentation.exportButtonText).onClick(() => {
          new Notice('Kuroflare: export local outbox under refactoring')
        })
      })
    let repairImportPath = localStoreRepairPresentation.importDefaultPath
    new Setting(containerEl)
      .setName('Stage repair export import')
      .setDesc('Read a repair export JSON and stage safe y-update entries as paused.')
      .addText((text) => {
        text
          .setPlaceholder('.obsidian/kuroflare/repair-exports/kuroflare-local-outbox.json')
          .setValue(repairImportPath)
          .onChange((value) => {
            repairImportPath = value.trim()
          })
      })
      .addButton((button) => {
        button.setButtonText('Stage').onClick(() => {
          new Notice('Kuroflare: stage repair import under refactoring')
        })
      })
    let _rebuildConfirmation = ''
    new Setting(containerEl)
      .setName('Rebuild local store')
      .setDesc(localStoreRepairPresentation.rebuildDescription)
      .addText((text) => {
        text.setPlaceholder(LOCAL_STORE_REBUILD_CONFIRMATION).onChange((value) => {
          _rebuildConfirmation = value.trim()
        })
      })
      .addButton((button) => {
        button.setButtonText('Rebuild').onClick(() => {
          new Notice('Kuroflare: rebuild local store under refactoring')
        })
      })
    new Setting(containerEl)
      .setName('Resume staged repair imports')
      .setDesc('Move reviewed repair-import outbox entries back to pending.')
      .addButton((button) => {
        button.setButtonText('Resume').onClick(() => {
          new Notice('Kuroflare: resume staged imports under refactoring')
        })
      })

    containerEl.createEl('h3', { text: 'Rejected update repair' })
    let rejectedRepairSetupAvailable = true
    try {
      requireSetupMetadata(this.plugin)
    } catch {
      rejectedRepairSetupAvailable = false
    }
    const rejectedRepairEntries = this.plugin.getSyncRejectedUpdateRepairEntriesSnapshot()
    const rejectedRepairPresentation = planRejectedUpdateRepairSettingsPresentation({
      entryCount: rejectedRepairEntries.length,
      setupAvailable: rejectedRepairSetupAvailable,
    })
    containerEl.createEl('p', { text: rejectedRepairPresentation.description })
    const rejectedRepairStatus = containerEl.createEl('p', {
      attr: { role: 'status', 'aria-live': 'polite' },
    })
    if (this.rejectedRepairStatusText.length > 0) {
      const statusText = this.rejectedRepairStatusText
      window.setTimeout(() => {
        if (rejectedRepairStatus.isConnected) rejectedRepairStatus.setText(statusText)
      }, 0)
    }
    new Setting(containerEl)
      .setName('Paused rejected updates')
      .setDesc('Refresh IndexedDB to list current sync-update-rejected rows.')
      .addButton((button) => {
        button
          .setButtonText(rejectedRepairPresentation.refreshButtonText)
          .setDisabled(rejectedRepairPresentation.disabled)
          .onClick(() => {
            button.setDisabled(true)
            this.rejectedRepairStatusText = 'Pending: loading paused rejected updates…'
            rejectedRepairStatus.setText(this.rejectedRepairStatusText)
            void this.plugin
              .refreshSyncRejectedUpdateRepairEntries()
              .then(() => {
                this.rejectedRepairStatusText = `Success: loaded ${this.plugin.getSyncRejectedUpdateRepairEntriesSnapshot().length} paused rejected update(s).`
                this.display()
              })
              .catch(() => {
                this.rejectedRepairStatusText = 'Error: could not read paused rejected updates.'
                rejectedRepairStatus.setText(this.rejectedRepairStatusText)
                button.setDisabled(false)
              })
          })
      })
    if (rejectedRepairPresentation.emptyStateText !== undefined) {
      containerEl.createEl('p', { text: rejectedRepairPresentation.emptyStateText })
    }
    for (const entry of rejectedRepairEntries) {
      const docLabel = entry.docId === undefined ? 'unknown document' : docIdLabel(entry.docId)
      const messageLabel = entry.messageId ?? 'unknown message'
      new Setting(containerEl)
        .setName(`${docLabel} — ${messageLabel}`)
        .setDesc(
          `Exact local update hash: ${entry.updateSha256 ?? 'missing'}. Rejection evidence: ${
            entry.rejectionUpdateSha256 ?? 'missing'
          }. The row remains paused until a valid import response and local commit.`,
        )
        .addButton((button) => {
          button
            .setButtonText('Repair')
            .setDisabled(!rejectedRepairSetupAvailable)
            .onClick(() => {
              button.setDisabled(true)
              this.rejectedRepairStatusText = `Pending: importing ${docLabel}…`
              rejectedRepairStatus.setText(this.rejectedRepairStatusText)
              void this.plugin
                .repairSyncRejectedUpdate(entry.id)
                .then((result) => {
                  const outcome = result.ok
                    ? planRejectedUpdateRepairOutcomePresentation({
                        ok: true,
                        docLabel,
                        snapshotSeq: result.snapshotSeq,
                      })
                    : planRejectedUpdateRepairOutcomePresentation({
                        ok: false,
                        docLabel,
                        reason: result.reason,
                      })
                  new Notice(outcome.noticeText)
                  this.rejectedRepairStatusText = outcome.statusText
                  this.display()
                })
                .catch(() => {
                  new Notice('Kuroflare: repair kept paused (unexpected failure).')
                  this.rejectedRepairStatusText = 'Error: repair kept paused (unexpected failure).'
                  rejectedRepairStatus.setText(this.rejectedRepairStatusText)
                  button.setDisabled(false)
                })
            })
        })
    }

    renderQuarantineAdmin(containerEl, this.plugin)
    renderSnapshotHealthAdmin(containerEl, this.plugin)
    containerEl.createEl('h3', { text: 'Repair log' })
    const invalidMetaIsolation = this.plugin.invalidMetaIsolationDetail
    if (invalidMetaIsolation !== null) {
      new Setting(containerEl)
        .setName(`Isolated invalid meta: ${invalidMetaIsolation.fileId}`)
        .setDesc(
          `${invalidMetaIsolation.reason} at ${new Date(
            invalidMetaIsolation.inspectedAt,
          ).toISOString()}${invalidMetaIsolation.truncated ? ' (truncated)' : ''}`,
        )
      containerEl.createEl('pre', { text: invalidMetaIsolation.rawJson })
    }
    const binaryRestoreCheck = this.plugin.binaryRestoreCheckDetail
    if (binaryRestoreCheck !== null) {
      new Setting(containerEl)
        .setName(`Binary restore check degraded: ${binaryRestoreCheck.fileId}`)
        .setDesc(
          `${binaryRestoreCheck.reason}: ${binaryRestoreCheck.path} at ${new Date(
            binaryRestoreCheck.checkedAt,
          ).toISOString()}`,
        )
    }
    const repairLog = settings.repairLog ?? []
    if (repairLog.length === 0) {
      containerEl.createEl('p', { text: 'No repair events recorded.' })
      return
    }
    for (const entry of repairLog.slice(0, 10)) {
      const setting = new Setting(containerEl)
        .setName(`${entry.kind}: ${entry.fileId}`)
        .setDesc(repairLogDescription(entry))
      const path = entry.path
      if (path !== undefined) {
        setting.addExtraButton((button) => {
          button.setIcon('link').setTooltip(path)
        })
      }
      if (entry.kind === 'invalid-meta') {
        let _invalidMetaConfirmation = ''
        setting
          .setDesc(
            `${repairLogDescription(entry)}. Type ${INVALID_META_DISCARD_CONFIRMATION} to discard the invalid meta key.`,
          )
          .addButton((button) => {
            button.setButtonText('Inspect invalid meta').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
          .addText((text) => {
            text.setPlaceholder(INVALID_META_DISCARD_CONFIRMATION).onChange((value) => {
              _invalidMetaConfirmation = value.trim()
            })
          })
          .addButton((button) => {
            button.setButtonText('Discard invalid meta').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
      } else if (entry.kind === 'remote-materialize-blocked') {
        setting
          .addButton((button) => {
            button.setButtonText('Resolve to conflict path').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
          .addButton((button) => {
            button.setButtonText('Retry materialize').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
          .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
      } else if (entry.kind === 'path-conflict' || entry.kind === 'portable-path') {
        setting
          .addButton((button) => {
            button.setButtonText('Resolve to conflict path').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
          .addButton((button) => {
            button.setButtonText('Retry path materialize').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
          .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
      } else if (entry.kind === 'delete-vs-edit' && entry.reason === 'missing-binary-content') {
        setting
          .addButton((button) => {
            button.setButtonText('Retry binary restore check').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
          .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
              new Notice('Kuroflare: repair actions under refactoring')
            })
          })
      }
    }
  }
}
