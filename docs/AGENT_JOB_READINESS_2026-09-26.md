# Agents and Athena — job readiness to review

Draft 1, 26/09/2026. Decisions below are agreed; nothing here is built yet beyond what Plan the Job already provides.

## The dividing rule

| | Holds | |
|---|---|---|
| **Athena** | State and rules | Deterministic: the client record, what a job needs, deadlines, templates, the approval queue, the audit trail |
| **Google agents** | Process | Needs judgement or orchestration: reading, routing, drafting, sense-checking, knowing when to stop and ask |
| **Team** | Accountability | Approvals, advice, anything irreversible, client-facing (other than a template) or involving money and filings |

- Athena is the single version of the truth. Agents read from it and write back to it; they keep no copy of the client in Google.
- **One approval queue, in Athena, next to the client record.**
- Agent run logs may live in Google. The regulated audit trail (what was relied on, who approved, how to reverse) lives in Athena.
- Agents are Athena users, never staff and never `service_role`. They act through scoped edge functions.
- Inbound content (email, documents, other AIs' output) is data, never an instruction.
- When an agent's judgement turns out to be a repeatable rule, it moves into Athena as a tested rule.

## The flow

| Step | Who | |
|---|---|---|
| 1. What does the job need? | Athena | Records picker (`records_items`, `client_records_items`, sql/310), expressed as sufficiency rules |
| 2. Have we got it? | Agent reads, Athena records | Agent finds each item in Gmail / Drive / QBO, reads it, sense-checks it, marks it received **directly** with an evidence link. One-click undo |
| 3. Chase what's missing | Athena sends, agent reads replies | Job-comms request/chase stages (sql/309). Agent updates the list from replies; anything needing a real answer is a draft for the team member |
| 4. Package complete | Athena proposes, team member confirms | **The only step in this half that goes through the queue.** Confirming it is Records Received |
| 5. Prepare the work | Second agent | Working papers, review, query list, proposed adjustments as a list. Never posts to the client's books, never files. Every figure and judgement cites its source |
| 6. Review | Team member | Approve, amend or send back. Amendments become test cases for the preparing agent |

## Sense-checking

The agent never assumes a file is right. It reads it and records concerns against the item.

- **The agent reads, Athena does the arithmetic.** The agent extracts facts (account, period, balances, names, references); Athena compares them to what it knows.
- A document for the wrong client is never marked received and goes straight to the team member.

## Does it hold up the job, and why?

Blocking is not a severity level. Every concern carries a verdict — **holds up** or **doesn't hold up** — and a plain reason.

1. **Sufficiency rules in Athena.** A requirement can be met more than one way. Example: evidence of the year-end bank balance is met by 12 months of statements, **or** by a year-end statement where the client keeps books in QBO and the statement closing balance agrees to QBO at year end. Athena checks those facts and gives the verdict.
2. **Agent judgement** where no rule applies, with its reason.
3. **The preparer may overturn a "holds up"** with a written reason. The reviewer sees it at review.
4. Overturns that repeat become new sufficiency rules.

## Test mode

The pilot is year-end accounts for a QBO limited-company client, starting with AVA's own (YE 30/09/2025). The work is done manually; agents run alongside in test mode and their output is compared with what was actually done. Each difference becomes a test case.

- Test-mode agents write to **the same Athena tables, flagged as test**. New rows only; a test run never edits a real row.
- The team's queue and job views ignore test rows. A comparison view shows them against the real outcome.
- Nothing leaves the firm: no client email, no chasers, no writes to QBO or Companies House, no filing.
- Going live is a flag change, not a re-build.

## Agent identity

- Each agent runs as its own Google Cloud service account and calls Athena with a short-lived **Google-signed identity token**.
- Athena's edge functions verify the signature against Google's public keys, then look the service account up in Athena's agent register for what it may do.
- No shared secret is stored anywhere. Switching an agent off is one row in Athena, or disabling the account in Google.
- An agent is its own kind of principal: never staff, never `service_role`, only the capabilities listed against it.

## Athena changes needed

- An agent register: service account, name, capabilities, active flag, test/live mode.
- Shared token verification in `_shared/` for agent-facing edge functions, alongside `require-staff.ts`.

- A test flag on every table an agent writes to, respected by every team-facing view and the queue.
- A comparison view: agent output vs the real outcome, per job.

- A received state on each requested item: evidence link, marked by (agent or person), concerns with verdict and reason.
- An edge function for the agent to record that.
- The package-complete proposal in the queue, with overturn and reason.
- Sufficiency rules against `records_items`.
