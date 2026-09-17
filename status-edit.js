/* Optimistic status editing, shared by index (app.js) and search (search.js).
 *
 * Both pages used to do the same three unsafe things inline: mutate the live
 * status map, re-render (so the rated title left the candidate list), then
 * `await StatusStore.setStatus(...)` and, on failure, only `alert()`. The
 * alert could be dismissed; the map kept the rating forever. The page then
 * showed a decision the server had never accepted — and, because the overlay
 * is only reloaded on an auth event, it kept showing it for the rest of the
 * session.
 *
 * markStatus() keeps the optimistic edit (it is what makes the loop feel
 * instant) but makes it accountable: the write goes through the durable
 * outbox, and if it permanently fails the map is restored to EXACTLY its prior
 * value — including "no entry at all", which is different from 'ok'.
 *
 * Dependency-injected so the shipped path is unit-tested; the pages are glue.
 */
(function (global) {
  "use strict";

  const MISSING = Symbol("no prior status");

  /* Per-key bookkeeping for edits that are still in flight.
   *
   * Rolling back to "the value this edit found" is only right for the NEWEST
   * edit of a key, and only if that value was ever real. Rate a title liked
   * then loved before either write lands and you get two rollback candidates,
   * neither of them the truth: if the liked write is refused, restoring its
   * prior wipes the loved the user can see and the server may still accept;
   * if both are refused, restoring loved's prior leaves `liked` showing — a
   * rating that never existed anywhere.
   *
   * So each key gets one entry while any edit of it is outstanding:
   *   version — bumped per edit; only the edit whose version is still current
   *             owns the visible value, and only it may roll back.
   *   base    — the last value known to be real (what was there before the
   *             first outstanding edit, advanced as writes actually land).
   * The entry is dropped once the newest edit settles, so the steady state
   * holds nothing. Keyed by the status map itself, so two pages (or two tests)
   * never share bookkeeping.
   */
  const EDITS = new WeakMap();

  function editsFor(statusMap) {
    let m = EDITS.get(statusMap);
    if (!m) { m = new Map(); EDITS.set(statusMap, m); }
    return m;
  }

  function claim(statusMap, key) {
    const edits = editsFor(statusMap);
    let entry = edits.get(key);
    if (!entry) {
      entry = { version: 0, base: statusMap.has(key) ? statusMap.get(key) : MISSING };
      edits.set(key, entry);
    }
    entry.version += 1;
    return { edits, entry, version: entry.version };
  }

  function release(edits, key, entry) {
    if (edits.get(key) === entry) edits.delete(key);
  }

  /* deps:
   *   isLoggedIn()      -> boolean
   *   statusMap         -> Map(statusKey -> status|{status,source})
   *   statusKey(id,kind)-> string
   *   submit(ops)       -> Promise<{ok, error, permanent}>   (the write queue)
   *   repaint()         -> void   (re-merge + re-render)
   *   notify(message, kind) -> void
   */
  async function markStatus(deps, tmdbId, kind, status) {
    if (!deps.isLoggedIn()) {
      deps.notify("Log in (top right) to save your ratings.", "auth");
      return { ok: false, reason: "auth" };
    }
    const key = deps.statusKey(tmdbId, kind);
    const map = deps.statusMap;
    // `has` before `get` (inside claim): a title with no stored status is not
    // the same as one stored as 'ok', and rolling the wrong one back would
    // invent a rating.
    const { edits, entry, version } = claim(map, key);

    map.set(key, status);
    deps.repaint();

    const result = await deps.submit([
      { op: "setStatus", key, args: { tmdbId, kind, status } },
    ]);
    const mine = entry.version === version;   // still the newest edit of this key?

    if (result.ok) {
      // Superseded: the outbox dropped this write because a newer one for the
      // same key replaced it before it was sent. The newer edit owns both the
      // visible value and what the server will hold, so claim neither.
      if (result.superseded) return { ok: true, superseded: true };
      if (mine) release(edits, key, entry);
      else entry.base = status;    // landed, but a newer edit is still in flight
      return { ok: true };
    }

    if (result.readOnly) {
      // This tab never owned the outbox, so the write was not merely delayed —
      // it was never taken at all. Put the map back and say where the edit can
      // be made, rather than reporting a save that is not queued anywhere.
      if (mine) {
        if (entry.base === MISSING) map.delete(key);
        else map.set(key, entry.base);
        release(edits, key, entry);
        deps.repaint();
      }
      deps.notify(`“${status}” wasn't saved — ${errText(result.error)}.`, "error");
      return { ok: false, reason: "write", readOnly: true, stale: !mine, error: result.error };
    }

    if (result.deferred) {
      // Not a refusal: the session ended before this write could be sent, and
      // the outbox is holding it under the account that made it. Take the
      // optimistic value off screen — whoever is signed in now did not make
      // this rating, and the overlay is about to be rebuilt for them — but say
      // what is actually true. "Undone" here would be a lie that pushes the
      // user to re-rate a title whose rating is already queued.
      if (mine) {
        if (entry.base === MISSING) map.delete(key);
        else map.set(key, entry.base);
        release(edits, key, entry);
        deps.repaint();
      }
      deps.notify(
        `“${status}” isn't saved yet — it's kept, and goes out the next time you log in to this account.`,
        "error",
      );
      return { ok: false, reason: "write", deferred: true, stale: !mine, error: result.error };
    }

    if (!mine) {
      // A newer rating is on screen and still being written. Undoing to this
      // edit's prior would throw that away, so report the loss and leave it.
      deps.notify(
        `Couldn't save “${status}” — a newer rating is showing instead. ${errText(result.error)}`,
        "error",
      );
      return { ok: false, reason: "write", stale: true, error: result.error };
    }

    if (entry.base === MISSING) map.delete(key);
    else map.set(key, entry.base);
    release(edits, key, entry);
    deps.repaint();
    deps.notify(
      `Couldn't save “${status}” — the rating was undone. ${errText(result.error)}`,
      "error",
    );
    return { ok: false, reason: "write", error: result.error };
  }

  function errText(err) {
    if (!err) return "";
    return String(err.message || err);
  }

  /* Re-merge a freshly loaded server overlay into the LIVE status map.
   *
   * Both pages used to do `STATUS_MAP = await loadStatuses()` on every auth
   * event (TOKEN_REFRESHED fires on its own schedule). Two problems:
   *   · it REBINDS the map, so an edit still in flight — which captured the
   *     old object — rolls back into a map nothing renders from, leaving the
   *     phantom rating on screen: exactly the failure markStatus exists to
   *     prevent;
   *   · it replaces an optimistic edit with the server's older value whenever
   *     the refresh lands before the write does, so the rating visibly
   *     flickers back and then forward again.
   * Mutating in place, and holding keys the outbox still owes, fixes both.
   * Pure — no I/O, no DOM.
   */
  function mergeServerStatuses(statusMap, serverMap, pendingKeys) {
    const owed = new Set(pendingKeys || []);
    for (const key of [...statusMap.keys()]) {
      if (!serverMap.has(key) && !owed.has(key)) statusMap.delete(key);
    }
    for (const [key, value] of serverMap) {
      if (owed.has(key) && statusMap.has(key)) continue;   // our write wins until it lands
      statusMap.set(key, value);
    }
    return statusMap;
  }

  const API = { markStatus, mergeServerStatuses };
  global.StatusEdit = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
