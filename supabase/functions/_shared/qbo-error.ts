// Turn a QuickBooks error into a sentence a human can act on.
//
// QBO answers a failed write with a Fault envelope, and until now we pasted the
// whole thing into the UI. What a user actually saw when 191 Architecture's two
// customer records were merged in QuickBooks was:
//
//   Committed to live billing, but the QBO push failed: Failed to update QBO
//   customer contact details: 400 {"Fault":{"Error":[{"Message":"A business
//   validation error has occurred while processing your request","Detail":
//   "Business Validation Error: You cannot modify a list element that has been
//   deleted.","code":"6000","element":""}],"type":"ValidationFault"},"time":
//   "2026-08-28T05:51:33.391-07:00"}
//
// Every fact needed to fix it is in there and none of it is legible: which
// client, which record, that a merge caused it, or what to do next. The useful
// sentence is "the QuickBooks customer Athena has on file for 191 Architecture
// Ltd no longer exists — it was deleted or merged into another customer — so
// re-link the client on the client page."

export interface QboFaultDetail {
  code: string | null;
  message: string | null;
  detail: string | null;
  type: string | null;
}

/** Pull the first Error out of a QBO Fault envelope. Returns nulls if the body isn't one. */
export function parseQboFault(bodyText: string): QboFaultDetail {
  try {
    const parsed = JSON.parse(bodyText);
    const fault = parsed?.Fault ?? parsed?.fault;
    const err = Array.isArray(fault?.Error) ? fault.Error[0] : null;
    if (!err) return { code: null, message: null, detail: null, type: null };
    return {
      code: err.code != null ? String(err.code) : null,
      message: err.Message ?? null,
      detail: err.Detail ?? null,
      type: fault?.type ?? null,
    };
  } catch {
    return { code: null, message: null, detail: null, type: null };
  }
}

/** True when QBO is refusing because the record we referenced is deleted or merged away. */
export function isDeletedListElement(bodyText: string): boolean {
  const f = parseQboFault(bodyText);
  const haystack = `${f.detail ?? ""} ${f.message ?? ""}`.toLowerCase();
  // 6000 is the generic business-validation code, so match on the text too.
  return haystack.includes("list element that has been deleted") ||
    haystack.includes("deleted list element");
}

/**
 * A one-sentence, actionable description of a failed QBO call.
 *
 * `subject` names the thing in Athena's terms — the client, not the endpoint —
 * because that is what the reader needs in order to do something about it.
 */
export function describeQboError(
  status: number,
  bodyText: string,
  subject: string,
): string {
  const f = parseQboFault(bodyText);

  // The case that prompted this. A QBO merge makes the losing customer a
  // deleted list element; anything still pointing at it fails here forever.
  if (isDeletedListElement(bodyText)) {
    return `The QuickBooks customer Athena has on file for ${subject} no longer exists — ` +
      `it was deleted, or merged into another customer in QuickBooks. ` +
      `Re-link ${subject} to the surviving QuickBooks customer on the client page, then push again.`;
  }

  if (status === 401 || status === 403) {
    return `QuickBooks refused the request for ${subject} (not authorised). ` +
      `The QuickBooks connection may need reconnecting at /admin/connections.`;
  }

  if (status === 429) {
    return `QuickBooks is rate-limiting us, so ${subject} was not pushed. Try again shortly.`;
  }

  if (status >= 500) {
    return `QuickBooks had a server error (${status}) while processing ${subject}. ` +
      `Nothing was changed — try again shortly.`;
  }

  // A fault we haven't given a friendly form yet: lead with QBO's own Detail,
  // which is the readable half of the envelope, and keep the code for support.
  const detail = f.detail || f.message;
  if (detail) {
    return `QuickBooks rejected the change to ${subject}: ${detail}` +
      (f.code ? ` (QuickBooks code ${f.code})` : "");
  }

  return `QuickBooks rejected the change to ${subject} (HTTP ${status}).`;
}
