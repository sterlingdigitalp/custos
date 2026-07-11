import { deliverPending, type Fetch } from '../alerts/deliver.js'
import { evaluateAlerts } from '../alerts/evaluate.js'
import { runSweep, type SweepSummary } from '../collector/sweep.js'
import { getSettings } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import type { CustosApiClient } from '../spapi/client.js'

export type CustosClientFactory = () => CustosApiClient | Promise<CustosApiClient>

export interface SchedulerSweepSummary extends SweepSummary {
  fetched: number
  failed: number
  alertsFired: number
}

export interface SchedulerStatus {
  running: boolean
  sweepRunning: boolean
  lastSummary: SchedulerSweepSummary | null
  lastError: string | null
  nextRunAt: string | null
}

export interface SchedulerController {
  stop(): void
  getStatus(): SchedulerStatus
}

export interface SchedulerOptions {
  fetchImpl?: Fetch
  now?: () => Date
}

export function startScheduler(
  db: DatabaseHandle,
  clientFactory: CustosClientFactory,
  options: SchedulerOptions = {},
): SchedulerController {
  let stopped = false
  let sweepRunning = false
  let lastSummary: SchedulerSweepSummary | null = null
  let lastError: string | null = null
  let nextRunAt: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const scheduleNext = (): void => {
    if (stopped) return
    const intervalMs = Math.max(15, getSettings(db).sweepIntervalMin) * 60_000
    nextRunAt = new Date(Date.now() + intervalMs).toISOString()
    timer = setTimeout(() => void runIteration(), intervalMs)
  }

  const runIteration = async (): Promise<void> => {
    if (stopped || sweepRunning) return
    sweepRunning = true
    nextRunAt = null
    try {
      const now = (options.now ?? (() => new Date()))()
      const client = await clientFactory()
      const sweep = await runSweep(db, client, now)
      const alertsFired = evaluateAlerts(db, now)
      await deliverPending(db, getSettings(db), options.fetchImpl)
      lastSummary = {
        ...sweep,
        fetched: sweep.asins - sweep.bothMissed,
        failed: sweep.bothMissed,
        alertsFired,
      }
      lastError = null
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      sweepRunning = false
      scheduleNext()
    }
  }

  void runIteration()

  return {
    stop(): void {
      stopped = true
      nextRunAt = null
      if (timer) clearTimeout(timer)
    },
    getStatus(): SchedulerStatus {
      return { running: !stopped, sweepRunning, lastSummary, lastError, nextRunAt }
    },
  }
}
