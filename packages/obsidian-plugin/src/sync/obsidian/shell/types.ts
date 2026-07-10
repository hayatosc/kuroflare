import { type SyncEngineStartupEffect } from '../../engine/engine'
import { type SyncRuntimeStartupEffect } from '../../engine/startup'

export type SyncRuntimeSetupExchangeRuntimeEffect = Extract<
  SyncRuntimeStartupEffect,
  { readonly kind: 'run-sync-startup-effect' }
> & {
  readonly effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>
}

export type SyncRuntimeStartupStepRuntimeEffect = Extract<
  SyncRuntimeStartupEffect,
  { readonly kind: 'run-sync-startup-effect' }
> & {
  readonly effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-startup-step' }>
}
