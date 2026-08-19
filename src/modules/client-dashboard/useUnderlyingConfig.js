import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

/*
  The per-client "what isn't really trading" configuration, in one place.

  Owner-cost nominal codes (dashboard_adjustment_accounts, group_key
  'owner_costs') and one-off items (dashboard_oneoff_items) used to be loaded
  and mutated inside the Underlying Performance tab. The Overview tab now needs
  the same config — its reported/underlying toggle strips exactly the same
  codes, bucket by bucket — and two independent copies would drift the moment
  someone tagged a code on one tab while the other was mounted.

  So the page owns one instance of this hook and hands it to both tabs. The
  Underlying tab still owns the editing UI; Overview only reads.

  `accounts` is the QBO chart of accounts (P&L codes), pulled through
  dashboard-qbo-pull's `accounts` metric — server-cached, so re-selecting a
  client is cheap.
*/

const GROUP = 'owner_costs';

export function useUnderlyingConfig(realmId) {
  const { profile } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [adjRows, setAdjRows] = useState([]);   // both statuses
  const [oneoffs, setOneoffs] = useState([]);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadConfig = useCallback(async () => {
    if (!realmId) return;
    setCfgLoading(true);
    try {
      const [{ data: oa }, { data: oo }] = await Promise.all([
        supabase.from('dashboard_adjustment_accounts').select('*')
          .eq('realm_id', realmId).eq('group_key', GROUP),
        supabase.from('dashboard_oneoff_items').select('*')
          .eq('realm_id', realmId).order('entry_date', { ascending: false }),
      ]);
      setAdjRows(oa || []);
      setOneoffs(oo || []);
    } catch { /* silent */ }
    setCfgLoading(false);
  }, [realmId]);

  const loadAccounts = useCallback(async () => {
    if (!realmId) return;
    setAccountsLoading(true);
    try {
      const { data: payload } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: { realmId, metrics: ['accounts'] },
      });
      setAccounts(payload?.metrics?.accounts?.accounts || []);
    } catch { /* silent */ }
    setAccountsLoading(false);
  }, [realmId]);

  useEffect(() => { setAccounts([]); setAdjRows([]); setOneoffs([]); }, [realmId]);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const accountsById = useMemo(() => {
    const m = {};
    for (const a of accounts) m[a.id] = a;
    return m;
  }, [accounts]);

  // `status` may be absent on rows written before sql/174, so default to active.
  const statusOf = (r) => r.status || 'active';
  const ownerRows = useMemo(() => adjRows.filter((r) => statusOf(r) === 'active'), [adjRows]);
  const dismissedRows = useMemo(() => adjRows.filter((r) => statusOf(r) === 'dismissed'), [adjRows]);
  const ownerAccountIds = useMemo(
    () => new Set(ownerRows.map((r) => String(r.account_id))),
    [ownerRows],
  );

  /* Mutations ------------------------------------------------------ */
  // One writer for both statuses. Upsert (not insert) because a code may already
  // have a dismissed row from an earlier suggestion round — confirming it later
  // has to flip that row, not collide with it.
  const writeAdj = async (entries, status) => {
    if (!realmId || !entries.length) return;
    setBusy(true);
    try {
      await supabase.from('dashboard_adjustment_accounts').upsert(
        entries.map((e) => {
          const a = accountsById[e.account_id];
          return {
            realm_id: realmId, group_key: GROUP, account_id: e.account_id,
            acct_num: a?.acct_num || e.acct_num || null,
            account_name: a?.name || e.account_name || null,
            status, suggested_rule: e.rule_key || null,
            created_by: profile?.id || null,
          };
        }),
        { onConflict: 'realm_id,group_key,account_id' },
      );
      await loadConfig();
    } catch { /* silent */ }
    setBusy(false);
  };

  const addOwnerAccount = (accountId) => writeAdj([{ account_id: accountId }], 'active');
  const confirmSuggestions = (picked) => writeAdj(picked, 'active');
  const dismissSuggestions = (picked) => writeAdj(picked, 'dismissed');

  const restoreDismissed = async () => {
    if (!dismissedRows.length) return;
    setBusy(true);
    try {
      await supabase.from('dashboard_adjustment_accounts').delete()
        .in('id', dismissedRows.map((r) => r.id));
      await loadConfig();
    } catch { /* silent */ }
    setBusy(false);
  };

  const removeOwnerAccount = async (id) => {
    setBusy(true);
    try { await supabase.from('dashboard_adjustment_accounts').delete().eq('id', id); await loadConfig(); }
    catch { /* silent */ }
    setBusy(false);
  };

  const addOneoff = async (entry) => {
    if (!realmId) return;
    setBusy(true);
    try {
      const a = entry.account_id ? accountsById[entry.account_id] : null;
      await supabase.from('dashboard_oneoff_items').insert({
        realm_id: realmId, kind: entry.kind, entry_date: entry.entry_date,
        amount: Number(entry.amount), account_id: entry.account_id || null,
        acct_num: a?.acct_num || null, account_name: a?.name || null,
        note: entry.note || null, created_by: profile?.id || null,
      });
      await loadConfig();
    } catch { /* silent */ }
    setBusy(false);
  };

  const removeOneoff = async (id) => {
    setBusy(true);
    try { await supabase.from('dashboard_oneoff_items').delete().eq('id', id); await loadConfig(); }
    catch { /* silent */ }
    setBusy(false);
  };

  return {
    accounts, accountsById, accountsLoading,
    adjRows, ownerRows, dismissedRows, ownerAccountIds,
    oneoffs, cfgLoading, busy,
    reload: loadConfig,
    addOwnerAccount, removeOwnerAccount,
    confirmSuggestions, dismissSuggestions, restoreDismissed,
    addOneoff, removeOneoff,
  };
}
