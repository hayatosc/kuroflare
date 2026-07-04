import { parseSetupUri, type QuarantinedUpdateActionDryRunResponse } from '@kuroflare/core'
import { type App, Notice, PluginSettingTab, Setting } from 'obsidian'

import {
  DEVICE_REVOKE_CONFIRMATION,
  docIdLabel,
  INVALID_META_DISCARD_CONFIRMATION,
  LOCAL_STORE_DISCARD_CONFIRMATION,
  LOCAL_STORE_REBUILD_CONFIRMATION,
  quarantineActionConfirmationText,
  quarantineActionLabel,
  repairLogDescription,
} from '../main'
import type KuroflareSpikePlugin from '../main'
import { planLocalStoreRepairSettingsPresentation } from '../sync/obsidian/local-store-repair-presentation'

export class KuroflareSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: KuroflareSpikePlugin,
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    const settings = this.plugin.getSettingsSnapshot()
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
        .setValue(settings.setupBootstrapMode)
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
          void this.plugin.revokeCurrentDeviceAfterConfirmation(revokeConfirmation).then(() => {
            this.display()
          })
        })
      })

    containerEl.createEl('h3', { text: 'Local store repair' })
    const runtimeRepairEntries = this.plugin.getSyncRepairEntriesSnapshot()
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
          void this.plugin.exportLocalOutboxRepair()
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
          void this.plugin.stageLocalOutboxRepairImport(repairImportPath)
        })
      })
    let rebuildConfirmation = ''
    new Setting(containerEl)
      .setName('Rebuild local store')
      .setDesc(localStoreRepairPresentation.rebuildDescription)
      .addText((text) => {
        text.setPlaceholder(LOCAL_STORE_REBUILD_CONFIRMATION).onChange((value) => {
          rebuildConfirmation = value.trim()
        })
      })
      .addButton((button) => {
        button.setButtonText('Rebuild').onClick(() => {
          void this.plugin.rebuildLocalStoreAfterConfirmation(rebuildConfirmation)
        })
      })
    new Setting(containerEl)
      .setName('Resume staged repair imports')
      .setDesc('Move reviewed repair-import outbox entries back to pending.')
      .addButton((button) => {
        button.setButtonText('Resume').onClick(() => {
          void this.plugin.resumeStagedRepairImports()
        })
      })

    containerEl.createEl('h3', { text: 'Quarantine admin' })
    new Setting(containerEl)
      .setName('Quarantined updates')
      .setDesc('Fetch server-side quarantined update entries for inspection.')
      .addButton((button) => {
        button.setButtonText('Refresh').onClick(() => {
          void this.plugin.refreshQuarantineAdminEntries().then(() => {
            this.display()
          })
        })
      })
    const quarantine = this.plugin.getQuarantineAdminSnapshot()
    if (quarantine.entries.length === 0) {
      containerEl.createEl('p', { text: 'No quarantined updates loaded.' })
    }
    for (const entry of quarantine.entries.slice(0, 10)) {
      new Setting(containerEl)
        .setName(`${entry.id}: ${entry.reason}`)
        .setDesc(
          `${docIdLabel(entry.docId)} ${entry.messageId} ${entry.updateSha256} ${new Date(
            entry.createdAt,
          ).toISOString()}`,
        )
        .addButton((button) => {
          button.setButtonText('Inspect').onClick(() => {
            void this.plugin.inspectQuarantineAdminEntry(entry.id).then(() => {
              this.display()
            })
          })
        })
        .addButton((button) => {
          button.setButtonText('Prepare discard').onClick(() => {
            void this.plugin.prepareQuarantineAdminAction(entry.id, 'discard').then(() => {
              this.display()
            })
          })
        })
        .addButton((button) => {
          button.setButtonText('Prepare force apply').onClick(() => {
            void this.plugin.prepareQuarantineAdminAction(entry.id, 'force-apply').then(() => {
              this.display()
            })
          })
        })
    }
    const detail = quarantine.detail
    if (detail !== null) {
      new Setting(containerEl)
        .setName(`Selected quarantine: ${detail.entry.id}`)
        .setDesc(
          `${docIdLabel(detail.entry.docId)} ${detail.entry.messageId} bytes=${
            detail.entry.updateBytesLength
          } updateBytesBase64=${detail.updateBytesBase64?.length ?? 0} chars`,
        )
    }
    const pendingAction = quarantine.pendingAction
    if (pendingAction !== null) {
      let quarantineConfirmation = ''
      const confirmationText = quarantineActionConfirmationText(pendingAction.action)
      new Setting(containerEl)
        .setName(
          `Pending ${quarantineActionLabel(pendingAction.action).toLowerCase()}: ${
            pendingAction.id
          }`,
        )
        .setDesc(
          `Effects: ${pendingAction.effects
            .map(
              (effect: QuarantinedUpdateActionDryRunResponse['effects'][number]) =>
                `${effect.kind} x${effect.count}${effect.detail === undefined ? '' : ` ${effect.detail}`}`,
            )
            .join(', ')}. Type ${confirmationText} to execute.`,
        )
        .addText((text) => {
          text.setPlaceholder(confirmationText).onChange((value) => {
            quarantineConfirmation = value.trim()
          })
        })
        .addButton((button) => {
          button.setButtonText('Execute').onClick(() => {
            void this.plugin
              .executeQuarantineAdminAction(
                pendingAction.id,
                pendingAction.action,
                quarantineConfirmation,
              )
              .then(() => {
                this.display()
              })
          })
        })
    }

    containerEl.createEl('h3', { text: 'Repair log' })
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
        let invalidMetaConfirmation = ''
        setting
          .setDesc(
            `${repairLogDescription(entry)}. Type ${INVALID_META_DISCARD_CONFIRMATION} to discard the invalid meta key.`,
          )
          .addText((text) => {
            text.setPlaceholder(INVALID_META_DISCARD_CONFIRMATION).onChange((value) => {
              invalidMetaConfirmation = value.trim()
            })
          })
          .addButton((button) => {
            button.setButtonText('Discard invalid meta').onClick(() => {
              void this.plugin
                .discardInvalidMetaRepairEntry(entry, invalidMetaConfirmation)
                .then(() => {
                  this.display()
                })
            })
          })
      } else if (entry.kind === 'remote-materialize-blocked') {
        setting
          .addButton((button) => {
            button.setButtonText('Retry materialize').onClick(() => {
              void this.plugin.retryRemoteMaterializeBlockedRepairEntry(entry).then(() => {
                this.display()
              })
            })
          })
          .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
              void this.plugin.clearRepairLogEntry(entry).then(() => {
                this.display()
              })
            })
          })
      } else if (entry.kind === 'path-conflict') {
        setting
          .addButton((button) => {
            button.setButtonText('Retry path materialize').onClick(() => {
              void this.plugin.retryPathConflictRepairEntry(entry).then(() => {
                this.display()
              })
            })
          })
          .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
              void this.plugin.clearRepairLogEntry(entry).then(() => {
                this.display()
              })
            })
          })
      } else if (entry.kind === 'delete-vs-edit' && entry.reason === 'missing-binary-content') {
        setting
          .addButton((button) => {
            button.setButtonText('Retry binary restore check').onClick(() => {
              void this.plugin.retryKeepDeletedRepairEntry(entry).then(() => {
                this.display()
              })
            })
          })
          .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
              void this.plugin.clearRepairLogEntry(entry).then(() => {
                this.display()
              })
            })
          })
      }
    }
  }
}
