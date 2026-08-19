// Shared outbound-fetch timeout helper. Every module that calls an external
// HTTP endpoint (Amazon LWA/SP-API, Keepa, ntfy, the Hub) routes its fetch
// through here so a hung socket can never freeze the caller indefinitely —
// see "THE DEFECT" in the timeout hardening task: a stuck sweep fetch used
// to latch `sweepRunning` true forever because nothing ever timed out.

/**
 * Thrown when a fetch is aborted by our own timeout budget (as opposed to a
 * caller-supplied AbortSignal firing for some other reason). Always a
 * transient/retryable failure — never mistake it for "no data".
 *
 * Deliberately carries only `label` and `timeoutMs`, never the request URL
 * or headers, so a timeout error can never echo a credential (e.g. Keepa's
 * API key travels in the query string).
 */
export class FetchTimeoutError extends Error {
  readonly name = 'FetchTimeoutError' as const
  constructor(message: string, readonly timeoutMs: number) {
    super(message)
  }
}

function isTimeoutReason(signal: AbortSignal): boolean {
  const reason = signal.reason as unknown
  return reason instanceof Error && reason.name === 'TimeoutError'
}

/**
 * Combines a `timeoutMs` budget with an optional caller-supplied signal so
 * neither clobbers the other (uses `AbortSignal.any` when a caller signal is
 * present).
 */
export function timeoutSignal(timeoutMs: number, existing?: AbortSignal | null): AbortSignal {
  const budget = AbortSignal.timeout(timeoutMs)
  return existing ? AbortSignal.any([budget, existing]) : budget
}

/**
 * Calls `fetchImpl(input, init)` with an abort signal enforcing `timeoutMs`,
 * combined with any signal already present on `init`. Rejects with a
 * `FetchTimeoutError` on expiry independent of whether `fetchImpl` itself
 * honors the signal — an injected test stub that never resolves (or a
 * genuinely wedged production socket) can never hang the caller.
 */
export async function fetchWithTimeout<Input>(
  fetchImpl: (input: Input, init?: RequestInit) => Promise<Response>,
  input: Input,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const signal = timeoutSignal(timeoutMs, init?.signal ?? undefined)

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      run()
    }
    const onAbort = (): void => {
      finish(() => {
        if (isTimeoutReason(signal)) {
          reject(new FetchTimeoutError(`${label} timed out after ${timeoutMs}ms`, timeoutMs))
        } else {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'))
        }
      })
    }
    signal.addEventListener('abort', onAbort)

    fetchImpl(input, { ...init, signal })
      .then((response) => finish(() => resolve(response)))
      .catch((error: unknown) => finish(() => {
        if (isTimeoutReason(signal)) {
          reject(new FetchTimeoutError(`${label} timed out after ${timeoutMs}ms`, timeoutMs))
        } else {
          reject(error)
        }
      }))
  })
}
