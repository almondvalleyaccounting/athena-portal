// The BrightPay journal control check's matching rules, kept pure so they can
// be tested (tests/money/journalRecon.test.js). qbo-journal-recon imports this;
// the facts behind each rule are in that function's header and in the comments
// below. No Deno, no network, no database.
//
// NOTE: journal-month-coverage still carries its own copies of round2,
// monthKey, norm, stem and nameMatches.

/* ── Shape ────────────────────────────────────────────────────────── */

export function round2(n: number) { return Math.round(n * 100) / 100; }

export function lineSummary(je: any) {
  const lines = je?.Line ?? [];
  let debit = 0, credit = 0;
  const accounts: string[] = [];
  for (const l of lines) {
    const d = l?.JournalEntryLineDetail;
    const amt = Number(l?.Amount ?? 0);
    if (d?.PostingType === "Debit") debit += amt;
    else if (d?.PostingType === "Credit") credit += amt;
    const nm = d?.AccountRef?.name;
    if (nm && !accounts.includes(nm)) accounts.push(nm);
  }
  return { line_count: lines.length, debit_total: round2(debit), credit_total: round2(credit), accounts };
}

// The source marker BrightPay stamps on every journal it sends. Note this
// identifies BrightPay-vs-manual, NOT which automation drove BrightPay — the
// previous (Cowork) automation drove the same wizard and left the same note.
// CreateTime is the discriminator between the two eras.
export function isBrightPay(je: any) { return /brightpay/i.test(String(je?.PrivateNote ?? "")); }

export function probeEntry(je: any) {
  return {
    id: je?.Id,
    doc_number: je?.DocNumber ?? null,
    txn_date: je?.TxnDate ?? null,
    total_amt: je?.TotalAmt ?? null,
    private_note: je?.PrivateNote ?? null,
    source: isBrightPay(je) ? "brightpay" : "other",
    adjustment: je?.Adjustment ?? null,
    create_time: je?.MetaData?.CreateTime ?? null,
    last_updated: je?.MetaData?.LastUpdatedTime ?? null,
    ...lineSummary(je),
    sample_lines: (je?.Line ?? []).slice(0, 4).map((l: any) => ({
      amount: l?.Amount ?? null,
      posting: l?.JournalEntryLineDetail?.PostingType ?? null,
      account: l?.JournalEntryLineDetail?.AccountRef?.name ?? null,
      description: l?.Description ?? null,
    })),
    top_level_keys: Object.keys(je ?? {}).sort(),
  };
}

/* ── Recon ────────────────────────────────────────────────────────── */

export const PENCE_TOLERANCE = 0.02;
export function monthKey(d: string) { return (d || "").slice(0, 7); }
export const UNCATEGORISED = /uncategori[sz]ed/i;

/**
 * Match BrightPay journals to payroll.task rows for one employer.
 *
 * Only journals carrying BrightPay's source marker are considered. A client's
 * own manual journals are none of this check's business and are never flagged.
 *
 * The period model matters and is not obvious — both of these are REAL,
 * observed on live data (9 Aug 2026), and a naive one-journal-per-month
 * assumption produces false positives on both:
 *
 *   1. BrightPay posts the payroll journal and the Employment Allowance
 *      adjustment as SEPARATE journals. payroll.task.amount is their SUM.
 *      Verified: MAC Recruit July = 31,845.98 + 3,331.24 = 35,177.22.
 *   2. A task period is not always one month. Catch-up tasks span several
 *      (CLF Scotland has one covering 2026-04-01 to 2026-06-30), and weekly
 *      payrolls produce several journals inside one monthly period.
 *
 * So: journals are matched to a task by DATE RANGE, and the comparison is
 * against the SUM of the debits in that range.
 *
 * Duplicate detection is therefore independent of the task amount — two
 * journals sharing a date AND a total is the signal, since that is what a
 * re-send produces and what a weekly payroll does not.
 *
 * Deliberately conservative: anything ambiguous becomes a finding for a human,
 * never an automatic conclusion. Nothing here writes to QuickBooks.
 */
export function reconcile(tasks: any[], allJournals: any[]) {
  const findings: any[] = [];
  const journals = allJournals.filter((j) => j.source === "brightpay");
  const claimed = new Set<string>();

  // 1. Duplicates: same transaction date, same total. Independent of any task.
  const byDateAmount: Record<string, any[]> = {};
  for (const j of journals) {
    if (!(Number(j.debit_total) > 0)) continue;
    const k = `${j.txn_date}|${Number(j.debit_total).toFixed(2)}`;
    (byDateAmount[k] ||= []).push(j);
  }
  for (const [k, group] of Object.entries(byDateAmount)) {
    if (group.length < 2) continue;
    const [date, amt] = k.split("|");
    findings.push({
      kind: "duplicate", severity: "high", period: monthKey(date),
      detail: `${group.length} identical BrightPay journals on ${date}, each totalling ${amt}.`,
      data: { journals: group.map((j) => ({ id: j.id, create_time: j.create_time })) },
    });
  }

  // 2. Each task against the journals inside its period.
  for (const t of tasks) {
    const period = monthKey(t.period_start);
    const inRange = journals.filter((j) => j.txn_date >= t.period_start && j.txn_date <= t.period_end);
    inRange.forEach((j) => claimed.add(j.id));
    const sum = round2(inRange.reduce((a, j) => a + Number(j.debit_total), 0));
    const expected = t.amount != null ? Number(t.amount) : null;

    if (inRange.length === 0) {
      findings.push({
        kind: "missing", severity: "high", task_id: t.id, period,
        detail: `Task says posted for ${t.period_start}..${t.period_end} but no BrightPay journal exists in QuickBooks in that period.`,
        data: { expected },
      });
      continue;
    }

    if (expected == null) {
      // Two very different cases, and calling both "unverified" reads as a
      // defect in the runner when most of it is not one.
      //
      // Rows imported from the sheet's JnlLog stand in for postings made by
      // the PREVIOUS automation, which nobody witnessed and which logged no
      // figure (121 of 161 JnlLog rows carry no amount in any column). There
      // is no expected figure to recover, so this is a known limit of
      // imported history, not something anyone failed to record.
      //
      // A task THIS system posted without an amount WOULD be a real gap. That
      // branch is currently empty and the runner says it cannot happen - which
      // is why it stays: it proves the invariant every month rather than
      // assuming it, and fires if anything ever regresses.
      const legacy = /import|jnllog/i.test(String(t.evidence ?? ""));
      findings.push({
        kind: legacy ? "legacy_no_expected_figure" : "unverifiable_amount",
        severity: "low", task_id: t.id, period,
        detail: legacy
          ? `${inRange.length} BrightPay journal(s) in ${t.period_start}..${t.period_end} totalling ${sum.toFixed(2)}. Existence confirmed; no expected figure exists for this imported pre-system posting, so agreement cannot be tested.`
          : `${inRange.length} BrightPay journal(s) in ${t.period_start}..${t.period_end} totalling ${sum.toFixed(2)}, but this system posted it without recording an amount - existence confirmed, agreement not.`,
        data: { total: sum, legacy, journals: inRange.map((j) => ({ id: j.id, date: j.txn_date, total: j.debit_total })) },
      });
      continue;
    }

    if (Math.abs(sum - expected) > PENCE_TOLERANCE) {
      findings.push({
        kind: "amount_mismatch", severity: "high", task_id: t.id, period,
        detail: `Task records ${expected.toFixed(2)} for ${t.period_start}..${t.period_end}; QuickBooks holds ${sum.toFixed(2)} across ${inRange.length} journal(s). Difference ${(sum - expected).toFixed(2)}.`,
        data: { expected, actual: sum, journals: inRange.map((j) => ({ id: j.id, date: j.txn_date, total: j.debit_total })) },
      });
    }

    for (const j of inRange) {
      if (Math.abs(Number(j.debit_total) - Number(j.credit_total)) > PENCE_TOLERANCE) {
        findings.push({
          kind: "unbalanced", severity: "high", task_id: t.id, period,
          detail: `Journal ${j.id} debits ${j.debit_total} vs credits ${j.credit_total}.`,
        });
      }
    }
  }

  // 3. BrightPay journals no task claims — the previous automation, or a
  //    hand-driven send.
  for (const j of journals) {
    if (claimed.has(j.id)) continue;
    findings.push({
      kind: "orphan", severity: "medium", period: monthKey(j.txn_date),
      detail: `BrightPay journal ${j.id} (${j.txn_date}, ${Number(j.debit_total).toFixed(2)}) falls in no recorded task period.`,
      data: { journal_id: j.id, date: j.txn_date, total: j.debit_total, create_time: j.create_time, accounts: j.accounts },
    });
  }

  // 4. Quality: a payroll journal landing in an uncategorised account.
  for (const j of journals) {
    const bad = (j.accounts || []).filter((a: string) => UNCATEGORISED.test(a));
    if (!bad.length) continue;
    findings.push({
      kind: "uncategorised_account", severity: "medium", period: monthKey(j.txn_date),
      detail: `Journal ${j.id} (${j.txn_date}) posts to ${bad.join(", ")} — the nominal mapping needs attention.`,
      data: { journal_id: j.id, accounts: bad },
    });
  }

  return findings;
}

/* ── Employer names ─────────────────────────────────────────────── */

export const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// "Amy Plumbing Ltd" in BrightPay is "Amy Plumbing Limited" in QuickBooks, and
// the other way round just as often. Comparing with the suffix attached - or
// bolting one suffix onto one side only - misses every Ltd/Limited pair, which
// cost five clients on the first run. Strip the suffix from BOTH sides.
export const stem = (k: string) => k.replace(/(limited|ltd|llp|plc)$/, "");
export function nameMatches(a: string, b: string) {
  const x = stem(a || ""), y = stem(b || "");
  return !!x && !!y && x === y;
}
