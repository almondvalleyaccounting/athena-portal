import { getServiceClient, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Returns realm ids, company names and token health — reconnaissance for the
  // other QBO endpoints. Its only caller is the staff app.
  try { await requireStaffOrService(req); }
  catch (err) { return authErrorResponse(err, corsHeaders()); }

  try {
    const sb = getServiceClient();

    // Get active connection (without exposing tokens)
    const { data: conn, error } = await sb
      .from("qbo_connections")
      .select("id, realm_id, company_name, token_expires_at, refresh_token_expires_at, connected_at, last_refreshed_at, status, error_message")
      .eq("status", "active")
      .single();

    if (error || !conn) {
      return jsonResponse({
        success: true,
        connected: false,
        status: "disconnected",
      });
    }

    // Calculate token health
    const now = new Date();
    const tokenExpires = new Date(conn.token_expires_at);
    const refreshExpires = conn.refresh_token_expires_at ? new Date(conn.refresh_token_expires_at) : null;

    let tokenHealth: "healthy" | "expiring_soon" | "expired" | "refresh_expired" = "healthy";
    if (refreshExpires && refreshExpires < now) {
      tokenHealth = "refresh_expired";
    } else if (tokenExpires < now) {
      tokenHealth = "expired"; // Will auto-refresh on next API call
    } else if (tokenExpires.getTime() - now.getTime() < 10 * 60 * 1000) {
      tokenHealth = "expiring_soon";
    }

    // Days until refresh token expires
    const refreshDaysLeft = refreshExpires
      ? Math.floor((refreshExpires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    // Get last sync info
    const { data: lastSync } = await sb
      .from("qbo_sync_log")
      .select("direction, status, created_at, entity_name")
      .order("created_at", { ascending: false })
      .limit(5);

    // Get sync stats
    const { count: totalSynced } = await sb
      .from("live_billing")
      .select("id", { count: "exact", head: true })
      .eq("qbo_sync_status", "synced");

    const { count: pendingSync } = await sb
      .from("live_billing")
      .select("id", { count: "exact", head: true })
      .or("qbo_sync_status.is.null,qbo_sync_status.eq.pending,qbo_sync_status.eq.error");

    return jsonResponse({
      success: true,
      connected: true,
      status: conn.status,
      company_name: conn.company_name,
      realm_id: conn.realm_id,
      connected_at: conn.connected_at,
      last_refreshed_at: conn.last_refreshed_at,
      token_health: tokenHealth,
      refresh_days_left: refreshDaysLeft,
      error_message: conn.error_message,
      sync_stats: {
        total_synced: totalSynced || 0,
        pending_sync: pendingSync || 0,
      },
      recent_syncs: lastSync || [],
    });
  } catch (err) {
    console.error("qbo-status error:", err);
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
