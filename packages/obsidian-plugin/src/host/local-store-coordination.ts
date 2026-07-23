import type KuroflareSpikePlugin from './plugin'

interface LocalStoreCoordinationState {
  tail: Promise<void>
  pending: number
}

const localStoreCoordination = new WeakMap<KuroflareSpikePlugin, LocalStoreCoordinationState>()

/** Serializes a local-store mutation with repair operations for the same plugin instance. */
export async function runLocalStoreMutation<Result>(
  plugin: KuroflareSpikePlugin,
  operation: () => Promise<Result>,
): Promise<Result> {
  return runCoordinated(plugin, operation, false)
}

/** Runs one repair operation only when no local-store operation is already active or queued. */
export async function runExclusiveLocalStoreRepair<Result>(
  plugin: KuroflareSpikePlugin,
  operation: () => Promise<Result>,
): Promise<Result> {
  return runCoordinated(plugin, operation, true)
}

async function runCoordinated<Result>(
  plugin: KuroflareSpikePlugin,
  operation: () => Promise<Result>,
  rejectIfBusy: boolean,
): Promise<Result> {
  const state = localStoreCoordination.get(plugin) ?? { tail: Promise.resolve(), pending: 0 }
  if (rejectIfBusy && state.pending > 0) throw new Error('local-store-repair-operation-in-progress')
  localStoreCoordination.set(plugin, state)

  const previous = state.tail
  let release = (): void => undefined
  state.tail = new Promise<void>((resolve) => {
    release = resolve
  })
  state.pending += 1
  await previous
  try {
    return await operation()
  } finally {
    state.pending -= 1
    release()
    if (state.pending === 0) localStoreCoordination.delete(plugin)
  }
}
