// Fetch every row of a query, not the first 1000.
//
// PostgREST caps a response at 1000 rows on this project, and `.limit(5000)` does
// NOT raise it. You get HTTP 206 with `Content-Range: 0-999/1876` — and supabase-js
// surfaces neither: `error` is null and `data` simply has 1000 rows. So any total
// computed from the response is quietly wrong and the page looks fine.
//
// It cost us twice on 2026-08-11. The HMRC Corporation Tax league table reported
// £351,234 owed against a true £478,611 once a scrape pushed the detail view past
// 1000 rows — £127,377 of debt missing from the screen used to decide who to chase.
// And the work planner read all of bm_task_schedule (2,256 rows), planned an
// arbitrary 1,000 of them, and reported "total: 1000" as though that were the lot.
//
// Both had passed review, because both were correct when the data was smaller.
//
// Prefer aggregating in SQL when you only need totals — one row per client beats
// paging thousands of rows to add them up in the browser (that is what sql/222
// does for the HMRC tables). Use this when you genuinely need every row.
//
// Pass a FUNCTION that builds the query, because a Supabase query builder is
// single-use and each page needs a fresh one:
//
//   const rows = await fetchAllRows(() =>
//     supabase.from('bm_task_schedule').select('id, entity_id').order('id'));
//
// ALWAYS give the query a stable .order(). Range paging without an ORDER BY can
// repeat or skip rows between pages, because the server is free to return them in
// any order.

const PAGE = 1000;

export async function fetchAllRows(build, { page = PAGE, maxRows = 200000 } = {}) {
  const out = [];
  for (let from = 0; from < maxRows; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw error;
    const batch = data || [];
    out.push(...batch);
    // A short page means we have reached the end. A full page might be the end
    // too, in which case the next request simply returns nothing.
    if (batch.length < page) return out;
  }
  // Hitting the ceiling means the caller is reading more than it should. Loud,
  // because silently returning a prefix is the bug this file exists to prevent.
  throw new Error(`fetchAllRows: exceeded ${maxRows} rows — aggregate in SQL instead`);
}

export default fetchAllRows;
