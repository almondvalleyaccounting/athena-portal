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

    // 2. Check caller has can_manage_portal
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
    const { user_id } = await req.json();
    if (!user_id) {
      return jsonResponse({ success: false, error: "user_id is required" }, 400);
    }

    // 4. Prevent self-deletion
    if (user_id === caller.id) {
      return jsonResponse({ success: false, error: "Cannot delete your own account" }, 400);
    }

    // 5. Delete staff profile first
    const { error: profileError } = await serviceClient
      .from("staff_profiles")
      .delete()
      .eq("id", user_id);

    if (profileError) {
      return jsonResponse({ success: false, error: `Profile delete failed: ${profileError.message}` }, 500);
    }

    // 6. Delete auth user
    const { error: authDeleteError } = await serviceClient.auth.admin.deleteUser(user_id);

    if (authDeleteError) {
      return jsonResponse({
        success: false,
        error: `Profile deleted but auth user delete failed: ${authDeleteError.message}`,
      }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error("delete-user error:", err);
    return jsonResponse({ success: false, error: String(err) }, 500);
  }
});
