import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    // 1. Verify caller JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ success: false, error: "Missing authorization" }, 401);
    }

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: caller }, error: authError } = await anonClient.auth.getUser();
    if (authError || !caller) {
      return jsonResponse({ success: false, error: "Invalid token" }, 401);
    }

    // 2. Check caller has can_manage_portal permission
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: callerProfile } = await serviceClient
      .from("staff_profiles")
      .select("can_manage_portal")
      .eq("id", caller.id)
      .single();

    if (!callerProfile?.can_manage_portal) {
      return jsonResponse({ success: false, error: "Not authorised" }, 403);
    }

    // 3. Parse request
    const { name, email, password } = await req.json();
    if (!name || !email || !password) {
      return jsonResponse({ success: false, error: "Name, email, and password are required" }, 400);
    }
    if (password.length < 6) {
      return jsonResponse({ success: false, error: "Password must be at least 6 characters" }, 400);
    }

    // 4. Create auth user via admin API
    const { data: newUser, error: createError } = await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError) {
      return jsonResponse({ success: false, error: createError.message }, 400);
    }

    // 5. Create staff_profiles record
    const { error: profileError } = await serviceClient
      .from("staff_profiles")
      .insert({
        id: newUser.user.id,
        name,
        email,
        is_active: true,
        can_view_quotes: false,
        can_edit_quotes: false,
        can_approve_quotes: false,
        can_edit_fee_schedule: false,
        can_view_client_fees: false,
        can_view_reports: false,
        can_view_work_planner: false,
        can_view_pd_tracker: false,
        can_manage_portal: false,
      });

    if (profileError) {
      console.error("Profile insert failed:", profileError);
      return jsonResponse({
        success: false,
        error: `Auth user created but profile insert failed: ${profileError.message}`,
      }, 500);
    }

    return jsonResponse({ success: true, user_id: newUser.user.id });
  } catch (err) {
    console.error("invite-user error:", err);
    return jsonResponse({ success: false, error: String(err) }, 500);
  }
});
