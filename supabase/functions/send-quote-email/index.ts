import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { to, subject, message, pdfBase64, filename, quoteId } = await req.json();

    if (!to || !subject || !message) {
      throw new Error("Missing required fields: to, subject, message");
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "quotes@almondvalleyaccounting.co.uk";

    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

    // Build email payload
    const emailPayload: Record<string, unknown> = {
      from: `Almond Valley Accounting <${FROM_EMAIL}>`,
      to: [to],
      subject,
      html: message.replace(/\n/g, "<br>"),
    };

    // Attach PDF if provided
    if (pdfBase64 && filename) {
      emailPayload.attachments = [
        {
          filename: filename.endsWith(".pdf") ? filename : `${filename}.pdf`,
          content: pdfBase64,
        },
      ];
    }

    // Send via Resend API
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(emailPayload),
    });

    const resendData = await resendResp.json();

    if (!resendResp.ok) {
      console.error("[send-quote-email] Resend error:", resendData);
      throw new Error(resendData?.message || `Resend API error: ${resendResp.status}`);
    }

    return new Response(
      JSON.stringify({ success: true, emailId: resendData.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (err) {
    console.error("[send-quote-email] Error:", err.message);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
