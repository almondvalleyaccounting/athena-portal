// onboarding-reply-scan — Athena Portal
//
// Reads new client emails for anything we asked for during onboarding, so a
// UTR buried in a reply isn't missed and then chased for again (sql/359).
//
// Every 15 minutes (pg_cron, five minutes after the mailbox ingest) it takes
// inbound client_communications rows for clients with an open onboarding that
// it hasn't read yet, and asks Claude which of the onboarding's open client
// items each email appears to provide. Each hit becomes an
// onboarding_reply_findings row — a suggestion that waits for a person to
// accept (ticks the step) or dismiss on the onboarding screen. It never ticks
// a step, never sends anything and never touches the mailbox.
//
// It reads the email body only. Attachments aren't stored with the email, so
// "ID attached" is reported as what the client says they sent, for a person
// to check.
//
// Auth: x-cron-secret matching onboarding_chase_config.cron_secret, or an
// active staff JWT (the "Read replies now" button), optionally with
// { onboarding_id } to read just that client's mail.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";

const MODEL = "claude-opus-5-5";
const PER_RUN = 25;          // emails read per run — the rest wait for the next one
const LOOKBACK_DAYS = 30;    // never reach further back than this, whatever the start date
const OPEN = ["pending", "waiting_client", "waiting_external", "blocked", "received"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}
type Row = Record<string, any>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item_id", "value", "evidence", "confidence"],
        properties: {
          item_id: { type: "string", description: "The id of the outstanding item this provides, exactly as listed." },
          value: { type: "string", description: "What the client gave: the reference itself (e.g. the 10-digit UTR), or a short statement such as 'says passport and driving licence attached'." },
          evidence: { type: "string", description: "The client's own words, quoted briefly (under 25 words)." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

// Keep the client's new text; drop the quoted thread underneath, which repeats
// our own request and would read as if the client had sent every item.
function newTextOnly(body: string): string {
  const cut = [
    /\n\s*On .{3,200}wrote:\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*From:\s.+\n\s*Sent:\s/i,
    /\n_{5,}\s*\n/,
  ].reduce((at, re) => {
    const m = re.exec(body);
    return m && m.index < at ? m.index : at;
  }, body.length);
  return body.slice(0, cut).split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim().slice(0, 20000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ── Auth: cron secret, or an active member of staff ──
  const { data: cfg } = await db.from("onboarding_chase_config").select("cron_secret, reply_read_enabled").eq("id", true).maybeSingle();
  const secret = (cfg?.cron_secret as string) || "";
  const gotSecret = req.headers.get("x-cron-secret") || "";
  const cronAuthed = Boolean(secret && gotSecret && gotSecret === secret);
  if (!cronAuthed) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await anon.auth.getUser();
    if (error || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await db.from("staff_profiles").select("is_active").eq("id", user.id).maybeSingle();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  } else if (cfg && cfg.reply_read_enabled === false) {
    return json({ success: true, skipped: true, reason: "reply_read_enabled is off" });
  }
  if (!ANTHROPIC_API_KEY) return json({ success: false, error: "ANTHROPIC_API_KEY secret is not set" }, 500);

  const body = await req.json().catch(() => ({}));
  const onlyOb: string | null = typeof body.onboarding_id === "string" ? body.onboarding_id : null;

  // ── Open onboardings and their open client items ──
  let obQ = db.from("onboardings")
    .select("id, entity_id, created_at, owner_id, entity:entities!onboardings_entity_id_fkey(name), steps:onboarding_steps(id, name, client_label, owner_type, status)")
    .in("status", ["active", "on_hold", "issues"])
    .is("archived_at", null);
  if (onlyOb) obQ = obQ.eq("id", onlyOb);
  const { data: obs, error: obErr } = await obQ;
  if (obErr) return json({ success: false, error: obErr.message }, 500);
  const byEntity = new Map<string, Row>();
  for (const o of (obs || []) as Row[]) byEntity.set(o.entity_id, o);
  if (!byEntity.size) return json({ success: true, read: 0, findings: 0 });

  // ── Inbound mail not yet read ──
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const { data: mail, error: mErr } = await db.from("client_communications")
    .select("id, entity_id, from_email, subject, body_text, snippet, occurred_at")
    .eq("direction", "in")
    .in("entity_id", [...byEntity.keys()])
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: true })
    .limit(500);
  if (mErr) return json({ success: false, error: mErr.message }, 500);
  const ids = (mail || []).map((m: Row) => m.id);
  const { data: done } = ids.length
    ? await db.from("onboarding_reply_scans").select("communication_id").in("communication_id", ids)
    : { data: [] };
  const seen = new Set((done || []).map((d: Row) => d.communication_id));
  const fresh = ((mail || []) as Row[])
    .filter((m) => !seen.has(m.id))
    .filter((m) => m.occurred_at >= byEntity.get(m.entity_id)!.created_at)
    .slice(0, PER_RUN);

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let found = 0;
  const details: Row[] = [];

  for (const m of fresh) {
    const ob = byEntity.get(m.entity_id)!;
    const items = ((ob.steps || []) as Row[]).filter((s) => s.owner_type === "client" && OPEN.includes(s.status));
    const text = newTextOnly(String(m.body_text || m.snippet || ""));
    // Claim the email first so two overlapping runs can't both read it.
    const { error: claimErr } = await db.from("onboarding_reply_scans").insert({ communication_id: m.id, onboarding_id: ob.id });
    if (claimErr) continue;
    if (!items.length || !text) continue;

    let findings: Row[] = [];
    let failure: string | null = null;
    try {
      // A safety decline on Opus falls back server-side rather than losing the read.
      const response = await anthropic.beta.messages.create({
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system:
          "You read emails that clients of a UK accounting practice send during onboarding, and say which of the practice's outstanding requests each email answers. " +
          "Only report an item when the client's own words provide it or say they have sent or done it. Never infer from the item list itself, and ignore anything that is the practice's earlier message quoted back. " +
          "UK formats: a UTR is 10 digits, an NI number looks like QQ123456C, a PAYE reference like 123/AB45678, a VAT number is 9 digits, a Companies House authentication code is 6 characters, an HMRC agent authorisation code is 6 characters. " +
          "Attachments are not visible to you: if the client says something is attached, report what they say was attached with medium confidence. An empty list is the right answer for an email that provides nothing.",
        messages: [{
          role: "user",
          content:
            `Client: ${ob.entity?.name || "unknown"}\n\nOutstanding items (id — what we asked for):\n` +
            items.map((s) => `${s.id} — ${s.client_label || s.name}`).join("\n") +
            `\n\nEmail from ${m.from_email || "the client"}${m.subject ? `, subject "${m.subject}"` : ""}:\n"""\n${text}\n"""`,
        }],
      });
      if (response.stop_reason === "refusal") {
        failure = "The model declined to read this email.";
      } else {
        const block = response.content.find((b) => b.type === "text");
        if (block && block.type === "text") findings = (JSON.parse(block.text).findings || []) as Row[];
      }
    } catch (e) {
      failure = String((e as Error).message || e).slice(0, 500);
    }

    const valid = findings.filter((f) => items.some((s) => s.id === f.item_id));
    if (valid.length) {
      await db.from("onboarding_reply_findings").insert(valid.map((f) => {
        const step = items.find((s) => s.id === f.item_id)!;
        return {
          onboarding_id: ob.id, communication_id: m.id, step_id: step.id,
          item_label: step.client_label || step.name,
          found_value: String(f.value || "").slice(0, 500) || null,
          evidence: String(f.evidence || "").slice(0, 500) || null,
          confidence: ["high", "medium", "low"].includes(f.confidence) ? f.confidence : "medium",
        };
      }));
      const when = String(m.occurred_at).slice(0, 10);
      await db.from("onboarding_activity").insert({
        onboarding_id: ob.id, kind: "system",
        body: `The client's email of ${when}${m.subject ? ` (“${m.subject}”)` : ""} looks like it includes: ` +
          valid.map((f) => {
            const s = items.find((x) => x.id === f.item_id)!;
            return `${s.client_label || s.name}${f.value ? ` — ${f.value}` : ""}`;
          }).join("; ") + ". Check it and tick or dismiss on the onboarding.",
      });
      if (ob.owner_id) {
        await db.from("notifications").insert({
          recipient_id: ob.owner_id, kind: "chase_reply",
          title: `${ob.entity?.name || "A client"} sent something we asked for — check it`,
          link_path: `/onboarding/${ob.id}`,
        });
      }
      found += valid.length;
    }
    await db.from("onboarding_reply_scans").update({ findings: valid.length, error: failure, scanned_at: new Date().toISOString() })
      .eq("communication_id", m.id);
    details.push({ onboarding: ob.id, communication: m.id, findings: valid.length, error: failure });
  }

  return json({ success: true, read: fresh.length, findings: found, waiting: Math.max(0, ((mail || []).length - seen.size) - fresh.length), details });
});
