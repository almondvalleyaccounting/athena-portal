// doc-extract — Athena Portal
// Reads a client-uploaded onboarding document with Claude: classifies it
// (passport, UTR letter, P60, VAT certificate, ...) and extracts key fields
// into onboarding_documents.extracted, then posts a summary to the
// onboarding activity timeline. Fired automatically by the
// notify_doc_extract trigger on insert (x-cron-secret auth via
// onboarding_chase_config.cron_secret) or manually by staff (JWT).
//
// Requires the ANTHROPIC_API_KEY secret on the project.
//
// Body: { document_id: string, force?: boolean }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("DOC_EXTRACT_CRON_SECRET") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_type", "summary", "person_or_company", "reference_number", "expiry_date", "fields", "confidence"],
  properties: {
    doc_type: {
      type: "string",
      enum: [
        "passport", "driving_licence", "national_id", "utility_bill", "bank_statement",
        "hmrc_utr_letter", "hmrc_paye_letter", "hmrc_vat_letter", "hmrc_agent_code_letter",
        "companies_house_letter", "p45", "p60", "payslip", "letter_of_engagement",
        "invoice", "rental_statement", "client_interview", "other",
      ],
    },
    summary: { type: "string", description: "One short sentence describing the document, written for an accountant's file notes." },
    person_or_company: { anyOf: [{ type: "string" }, { type: "null" }], description: "The person or company the document belongs to / is addressed to." },
    reference_number: { anyOf: [{ type: "string" }, { type: "null" }], description: "The single most important reference on the document: UTR, PAYE reference, VAT number, passport/licence number, NI number, company number." },
    expiry_date: { anyOf: [{ type: "string" }, { type: "null" }], description: "ISO 8601 date (YYYY-MM-DD) if the document has an expiry date, else null." },
    fields: {
      type: "array",
      description: "Every other useful data point on the document as label/value pairs (dates of birth, addresses, tax codes, pay figures, accounts office references, employer names, tax years, amounts...).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: { label: { type: "string" }, value: { type: "string" } },
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: automation secret (trigger) OR active-staff JWT (manual re-run) ──
  const cronHeader = req.headers.get("x-cron-secret") || "";
  let expectedSecret = CRON_SECRET;
  if (!expectedSecret) {
    const { data: cfg } = await service.from("onboarding_chase_config").select("cron_secret").eq("id", true).maybeSingle();
    expectedSecret = (cfg?.cron_secret as string) || "";
  }
  if (!(expectedSecret && cronHeader && cronHeader === expectedSecret)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const documentId: string | null = body.document_id || null;
  const force = body.force === true;
  if (!documentId) return json({ success: false, error: "document_id required" }, 400);

  const { data: doc, error: docErr } = await service
    .from("onboarding_documents")
    .select("*, onboarding:onboardings(id, entity:entities!onboardings_entity_id_fkey(id, name)), step:onboarding_steps(id, name, client_label)")
    .eq("id", documentId)
    .single();
  if (docErr || !doc) return json({ success: false, error: docErr?.message || "Document not found" }, 404);
  if (doc.extract_status === "done" && !force) {
    return json({ success: true, skipped: true, reason: "already extracted" });
  }

  const fail = async (status: string, message: string, httpStatus = 200) => {
    await service.from("onboarding_documents").update({
      extract_status: status, extract_error: message, extracted_at: new Date().toISOString(),
    }).eq("id", documentId);
    return json({ success: status !== "error", status, message }, httpStatus);
  };

  const mime = (doc.mime_type as string) || "";
  const isImage = IMAGE_MIMES.includes(mime);
  const isPdf = mime === "application/pdf";
  if (!isImage && !isPdf) {
    return await fail("unsupported", `Cannot read ${mime || "unknown type"} automatically — open the file to review it manually.`);
  }
  if (!ANTHROPIC_API_KEY) {
    return await fail("error", "ANTHROPIC_API_KEY secret is not set on the Supabase project.");
  }

  const { data: blob, error: dlErr } = await service.storage.from("client-documents").download(doc.storage_path);
  if (dlErr || !blob) return await fail("error", `Storage download failed: ${dlErr?.message || "no data"}`);
  const b64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));

  const entityName = ((doc.onboarding as Record<string, unknown>)?.entity as Record<string, unknown>)?.name || "a client";
  const stepLabel = (doc.step as Record<string, unknown>)?.client_label || (doc.step as Record<string, unknown>)?.name || null;

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const mediaBlock = isImage
    ? { type: "image" as const, source: { type: "base64" as const, media_type: mime as "image/jpeg", data: b64 } }
    : { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: b64 } };

  let extracted: Record<string, unknown>;
  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          mediaBlock,
          {
            type: "text",
            text: `You are reading a document uploaded by a client of a UK accounting practice during onboarding. The client is "${entityName}".` +
              (stepLabel ? ` It was uploaded against the checklist item: "${stepLabel}".` : "") +
              ` Classify the document and extract the key information an accountant needs on file. UK context: UTRs are 10 digits, PAYE employer references look like 123/AB456, VAT numbers are 9 digits (often prefixed GB), NI numbers look like QQ123456C.` +
              ` If this is a new-client interview / fact-find document (typically a PDF the practice produced summarising a client conversation), classify it as client_interview and be exhaustive in fields: capture every data point — personal and business details, services discussed, payroll arrangements and frequency, VAT scheme, year end, banking, software, key dates, anything actionable.` +
              ` If text is unreadable or the document is not what it claims to be, reflect that in confidence and the summary.`,
          },
        ],
      }],
    });
    if (response.stop_reason === "refusal") {
      return await fail("error", "The model declined to read this document.");
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return await fail("error", "No text output from the model.");
    }
    extracted = JSON.parse(textBlock.text);
  } catch (e) {
    return await fail("error", `Extraction failed: ${String((e as Error).message || e)}`);
  }

  await service.from("onboarding_documents").update({
    doc_type: extracted.doc_type || "other",
    extracted,
    extract_status: "done",
    extract_error: null,
    extracted_at: new Date().toISOString(),
  }).eq("id", documentId);

  // Activity note — flag expired ID documents loudly
  const expiry = extracted.expiry_date as string | null;
  const expired = expiry && !isNaN(Date.parse(expiry)) && Date.parse(expiry) < Date.now();
  const bits = [
    `AI read "${doc.original_name}": ${extracted.summary}`,
    extracted.reference_number ? `Reference: ${extracted.reference_number}` : null,
    expiry ? `Expires: ${expiry}${expired ? " — ⚠ APPEARS EXPIRED, request a current document" : ""}` : null,
    extracted.confidence !== "high" ? `(confidence: ${extracted.confidence})` : null,
  ].filter(Boolean);
  await service.from("onboarding_activity").insert({
    onboarding_id: (doc.onboarding as Record<string, unknown>).id,
    step_id: doc.step_id,
    kind: "system",
    body: bits.join("\n"),
  });

  return json({ success: true, doc_type: extracted.doc_type, summary: extracted.summary, expired: Boolean(expired) });
});
