// A refresh that failed is not the same as a connection that is broken.
//
// On 2026-07-23 Google answered a routine Gmail token refresh with a bare
// 503 `internal_failure`. The helper wrote status='error' onto the
// gmail_connections row, and nothing ever retries an errored row —
// comms-ingest only scans status='active'. So accounts@ went dark for 36 days
// over a blip that had cleared within the minute, and nobody found out until a
// quote was blind-copied there and failed to appear on the client page.
//
// The fix is to separate the two cases the provider is actually telling us
// apart. A 5xx, a 429 or a dropped connection says "not now" — retry, and if
// it still fails, leave the connection alone so the next cron run tries again.
// Only an RFC 6749 grant error says "this token is dead", and that is the one
// case where a human genuinely has to reconnect.

export interface RefreshOutcome {
  ok: boolean;
  /** Parsed token response — present only when ok. */
  tokens?: Record<string, unknown>;
  /** Last HTTP status seen (0 when the request never completed). */
  status: number;
  /** Last response body, or the network error message. */
  body: string;
  /**
   * True when the grant itself is gone — revoked, expired, or the account
   * password changed. Retrying cannot help; the connection must be disabled
   * and reconnected by a human. False for everything else, including a
   * refresh that exhausted its retries: that connection stays usable and is
   * simply retried on the next run.
   */
  permanent: boolean;
  attempts: number;
}

// Deliberately just the one code. `invalid_grant` is the only RFC 6749 reply
// that means THIS connection is dead — revoked, expired, password changed —
// and so the only one where disabling it is the right answer.
//
// The other 400s (`invalid_client`, `invalid_request`, `unauthorized_client`)
// are faults in our own credentials or request shape. They would hit every
// connection at once, so treating them as permanent would disable the entire
// estate over one bad deploy and require reconnecting every mailbox and all
// ~120 QBO realms by hand. Retrying forever and leaving the row enabled is the
// far cheaper failure: it stays visible in error_message and recovers by
// itself the moment the underlying fault is fixed.
const PERMANENT_ERROR_CODES = ["invalid_grant"];

function isPermanent(status: number, body: string): boolean {
  if (status !== 400) return false;
  return PERMANENT_ERROR_CODES.some((code) => body.includes(code));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST an OAuth refresh, retrying the transient failures.
 *
 * Retries on 5xx, 429 and network errors with a short exponential backoff
 * (~0.5s then ~1.5s by default), which is well inside an edge function's wall
 * clock and long enough to ride out the kind of blip that caused the outage
 * above. Returns rather than throws so the caller can decide what to write to
 * the connection row.
 */
export async function refreshWithRetry(
  url: string,
  body: URLSearchParams,
  // Intuit authenticates the refresh with a Basic header rather than client
  // credentials in the body, so callers can add their own headers.
  headers: Record<string, string> = {},
  attempts = 3,
): Promise<RefreshOutcome> {
  let status = 0;
  let text = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body,
      });
      status = resp.status;
      if (resp.ok) {
        const tokens = await resp.json();
        return { ok: true, tokens, status, body: "", permanent: false, attempts: attempt };
      }
      text = await resp.text();
      // A dead grant will not become live on the next attempt.
      if (isPermanent(status, text)) {
        return { ok: false, status, body: text, permanent: true, attempts: attempt };
      }
    } catch (e) {
      // Network-level failure — never permanent.
      status = 0;
      text = e instanceof Error ? e.message : String(e);
    }
    if (attempt < attempts) await sleep(500 * Math.pow(3, attempt - 1));
  }

  return { ok: false, status, body: text, permanent: false, attempts };
}

/**
 * The row update for a failed refresh.
 *
 * A permanent failure disables the connection — that is what status='error'
 * is for, and the UI shows a reconnect banner. A transient one records what
 * happened but leaves `status` untouched, so the connection stays in the set
 * the cron jobs scan and heals itself on the next run.
 */
export function failureUpdate(outcome: RefreshOutcome): Record<string, unknown> {
  const now = new Date().toISOString();
  const detail = `${outcome.status || "network"} ${outcome.body}`.trim().slice(0, 500);
  if (outcome.permanent) {
    return {
      status: "error",
      error_message: `Token refresh failed, reconnect required: ${detail}`,
      updated_at: now,
    };
  }
  return {
    error_message:
      `Token refresh failed ${outcome.attempts}x (transient, will retry): ${detail}`,
    updated_at: now,
  };
}
