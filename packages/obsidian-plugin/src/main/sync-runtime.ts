import type KuroflareSpikePlugin from './plugin'

export async function runSyncStartupTick(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const runtime = plugin.syncRuntime
  if (runtime === null) {
    return
  }

  const result = await runtime.lifecycle.runStartupTick()
  console.info('[kuroflare] sync startup tick', {
    reason,
    status: result.driver.state.shell.status,
    repairEntries: plugin.syncRepairEntries,
    retryEnabled: plugin.syncRetryEnabled,
    setupExchangeCompleted: result.driver.setupExchangeReplan !== undefined,
    completedEffects: result.driver.state.shell.completedEffects.length,
  })
}

export async function handleLifecycleResume(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const runtime = plugin.syncRuntime
  if (runtime === null) {
    return
  }
  const result = await runtime.lifecycle.runResumeTick(reason)
  console.info('[kuroflare] sync lifecycle resume tick', {
    reason,
    action: result.action,
    completedEffects:
      result.action === 'ran'
        ? result.startup.driver.state.shell.completedEffects.length
        : undefined,
  })
}
