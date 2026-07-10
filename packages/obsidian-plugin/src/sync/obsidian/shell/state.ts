import { INITIAL_SYNC_RUNTIME_SHELL_STATE } from '../../engine/actuation'
import type { SyncRuntimeObsidianShellDriverState } from '../shell.types'

export const INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE: SyncRuntimeObsidianShellDriverState =
  {
    shell: INITIAL_SYNC_RUNTIME_SHELL_STATE,
    presentation: { shownNoticeCount: 0 },
    startupPlan: undefined,
    startupInput: undefined,
  }
