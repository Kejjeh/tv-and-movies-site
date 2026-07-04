/* Status store — read/write your seen-title statuses in Supabase, and merge
 * them over the shipped data.json on load.
 *
 * The anon key is public by design; row-level security lets anyone read your
 * taste but only the logged-in owner write. The pure merge (applyStatuses) is
 * unit-tested under node; the Supabase I/O runs in the browser only.
 *
 * Exposed as a global for classic <script> pages and as a CommonJS export for
 * `node --test`.
 */
(function (global) {
  "use strict";

  function statusKey(tmdbId, kind) {
    return `${tmdbId}|${kind}`;
  }

  // Merge stored statuses over the title list. A stored status marks the title
  // seen and derives `loved`. Returns a new array; inputs are not mutated.
  function applyStatuses(titles, statusMap) {
    return titles.map(t => {
      const s = statusMap.get(statusKey(t.tmdb_id, t.kind));
      if (s == null) return t;
      return { ...t, seen: true, status: s, loved: s === "loved" };
    });
  }

  // ---- Supabase I/O (browser only) ------------------------------------
  let client = null;

  function init(url, anonKey) {
    if (!global.supabase) throw new Error("supabase-js not loaded");
    client = global.supabase.createClient(url, anonKey);
    return client;
  }

  async function loadStatuses() {
    const { data, error } = await client.from("statuses").select("tmdb_id,kind,status");
    if (error) throw error;
    const map = new Map();
    for (const r of data) map.set(statusKey(r.tmdb_id, r.kind), r.status);
    return map;
  }

  async function setStatus(tmdbId, kind, status, source) {
    const row = { tmdb_id: tmdbId, kind, status, updated_at: new Date().toISOString() };
    // Only send `source` when given — omit it so a pre-migration table (no
    // source column) still accepts the upsert.
    if (source != null) row.source = source;
    const { error } = await client.from("statuses").upsert(row);
    if (error) throw error;
  }

  async function clearStatus(tmdbId, kind) {
    const { error } = await client.from("statuses").delete().match({ tmdb_id: tmdbId, kind });
    if (error) throw error;
  }

  // ---- Not-seen / skip (confirm-queue) --------------------------------
  // Records "I haven't seen this" so the confirm queue stops re-surfacing it.
  async function markSkipped(tmdbId, kind) {
    const { error } = await client
      .from("not_seen")
      .upsert({ tmdb_id: tmdbId, kind, marked_at: new Date().toISOString() });
    if (error) throw error;
  }

  // The set of "tmdb_id|kind" keys the user has marked not-seen. Resilient to
  // the table not existing yet (returns an empty set before the migration).
  async function loadSkips() {
    try {
      const { data, error } = await client.from("not_seen").select("tmdb_id,kind");
      if (error) throw error;
      const set = new Set();
      for (const r of data) set.add(statusKey(r.tmdb_id, r.kind));
      return set;
    } catch (_) {
      return new Set();
    }
  }

  // Queue a universe title for the reconcile job to ingest into brain.db.
  async function queueAdd(tmdbId, kind, name) {
    const { error } = await client
      .from("queue")
      .upsert({ tmdb_id: tmdbId, kind, name, requested_at: new Date().toISOString() });
    if (error) throw error;
  }

  // Fire the GitHub reconcile workflow via the "reconcile" Edge Function. The
  // user's session is passed automatically; the GitHub token stays server-side.
  async function triggerReconcile() {
    const { data, error } = await client.functions.invoke("reconcile", { body: {} });
    if (error) throw error;
    return data;
  }

  // ---- Auth (magic link) ----------------------------------------------
  async function signIn(email) {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: global.location ? global.location.href : undefined },
    });
    if (error) throw error;
  }

  async function signOut() {
    await client.auth.signOut();
  }

  async function currentUser() {
    const { data } = await client.auth.getUser();
    return (data && data.user) || null;
  }

  const API = {
    statusKey, applyStatuses,
    init, loadStatuses, setStatus, clearStatus, queueAdd, triggerReconcile,
    markSkipped, loadSkips,
    signIn, signOut, currentUser,
  };
  global.StatusStore = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
