import { workerApp } from './app'
import type {
  WorkerEnv,
  WorkerExecutionContextBinding,
  WorkerModuleBinding,
  WorkerScheduledEventBinding,
} from './types'
import { UPDATE_COORDINATOR_ID_NAME, UPDATE_COORDINATOR_REQUEST_PATH } from './update-coordinator'

/** Trigger the singleton coordinator from the Worker's Cron handler. */
export function scheduled(
  event: WorkerScheduledEventBinding,
  env: WorkerEnv,
  context: WorkerExecutionContextBinding,
): Promise<void> {
  const operation = requestUpdateCoordinator(event, env)
  context.waitUntil(operation)
  return operation
}

async function requestUpdateCoordinator(
  event: WorkerScheduledEventBinding,
  env: WorkerEnv,
): Promise<void> {
  const namespace = env.UPDATE_COORDINATOR
  if (namespace === undefined) {
    throw new Error('UPDATE_COORDINATOR binding is not configured')
  }

  const id = namespace.idFromName(UPDATE_COORDINATOR_ID_NAME)
  const stub = namespace.get(id)
  const response = await stub.fetch(
    new Request(`https://kuroflare.invalid${UPDATE_COORDINATOR_REQUEST_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedAt: event.scheduledTime }),
    }),
  )
  if (!response.ok) {
    throw new Error(`UpdateCoordinator request failed: ${response.status}`)
  }
}

/** Public Workers module surface; named app exports remain available for RPC clients. */
export const workerModule = {
  fetch(request: Request, env: WorkerEnv, context?: WorkerExecutionContextBinding) {
    // Hono's type adds Wrangler-only `props`/`exports` fields, but the Workers
    // runtime object itself is passed through unchanged so prototype methods
    // and their receiver are preserved.
    return workerApp.fetch(request, env, context as Parameters<typeof workerApp.fetch>[2])
  },
  scheduled,
} satisfies WorkerModuleBinding

export default workerModule
