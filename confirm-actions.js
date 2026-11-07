/* The confirm queue's two decisions — "I've seen this (status)" and "haven't
 * seen this" — with their optimistic card-drop made accountable.
 *
 * What these replace (confirm.js, before):
 *   · confirmSeen awaited queueAdd then setStatus directly, so a single
 *     dropped request lost the rating; the rollback path re-rendered but the
 *     user had to notice an alert.
 *   · skip() dropped the card and then swallowed the error entirely
 *     (`catch (e) { /* best-effort *\/ }`). A failed skip looked identical to a
 *     successful one and the title came back the next day with no explanation.
 *
 * Both now go through the durable outbox: the card stays dropped while the
 * write is retried, and comes BACK only if the write permanently fails.
 * queue-before-status (ADR 0005) is expressed as one ordered group, so the
 * outbox enforces it — including a failed queueAdd withholding the status.
 *
 * Dependency-injected; confirm.js supplies the DOM callbacks.
 */
(function (global) {
  "use strict";

  const key = (id, kind) => `${id}|${kind}`;

  /* deps:
   *   isLoggedIn()    -> boolean
   *   submit(ops)     -> Promise<{ok, error, permanent}>
   *   markHandled(k)  -> void   (hide the card; record it for this session)
   *   unmarkHandled(k)-> void   (undo the above)
   *   restore()       -> void   (re-render the deck so the card comes back)
   *   notify(msg, kind) -> void
   */
  async function confirmSeen(deps, title) {
    if (!deps.isLoggedIn()) {
      deps.notify("Log in (top right) to confirm.", "auth");
      return { ok: false, reason: "auth" };
    }
    const k = key(title.tmdbId, title.kind);
    deps.markHandled(k);
    // Queue first (so ingest adds the row) THEN status (so sync marks it seen).
    const result = await deps.submit([
      { op: "queueAdd", key: k, args: { tmdbId: title.tmdbId, kind: title.kind, name: title.name } },
      { op: "setStatus", key: k, args: { tmdbId: title.tmdbId, kind: title.kind, status: title.status } },
    ]);
    if (result.ok) return { ok: true };
    return rollback(deps, k, `Couldn't save “${title.name}”`, result);
  }

  async function skipTitle(deps, title) {
    if (!deps.isLoggedIn()) {
      deps.notify("Log in (top right) to skip.", "auth");
      return { ok: false, reason: "auth" };
    }
    const k = key(title.tmdbId, title.kind);
    deps.markHandled(k);
    const result = await deps.submit([
      { op: "markSkipped", key: k, args: { tmdbId: title.tmdbId, kind: title.kind } },
    ]);
    if (result.ok) return { ok: true };
    // A silently-lost skip is the worst of the three: the card is gone, so the
    // user believes the queue has learned something it hasn't.
    return rollback(deps, k, "Couldn't record “haven't seen”", result);
  }

  function rollback(deps, k, what, result) {
    deps.unmarkHandled(k);
    deps.restore();
    if (result.readOnly) {
      // Never taken: this tab does not hold the account's outbox. The card
      // comes back because the decision has to be made where it can be saved.
      deps.notify(`${what} — ${errText(result.error)}.`, "error");
      return { ok: false, reason: "write", readOnly: true, error: result.error };
    }
    if (result.deferred) {
      // The session ended before the write went out; the outbox still holds it
      // under the account that made it. The card returns to the deck because
      // this tab is no longer that account — but the decision is not lost, and
      // telling the user it failed would send them to re-do work already
      // queued.
      deps.notify(`${what} yet — it's kept, and goes out the next time you log in to this account.`, "error");
      return { ok: false, reason: "write", deferred: true, error: result.error };
    }
    /* Ran out of retries rather than being refused: the write is still in
     * the outbox, on disk, and goes out when the connection is back. The card
     * returns so the deck is honest about what this browser has actually
     * confirmed — but the decision is not lost, and must not be reported as
     * though it were. `lost` is not this case: nothing is holding that one,
     * so it falls through to the tail and asks for the decision again. */
    if (!result.permanent && !result.lost) {
      deps.notify(
        `${what} yet — there's no connection. It's kept, and goes out by itself when you're back online.`,
        "error",
      );
      return { ok: false, reason: "write", stalled: true, error: result.error };
    }
    deps.notify(`${what} — it's back in the deck. ${errText(result.error)}`, "error");
    return { ok: false, reason: "write", error: result.error };
  }

  function errText(err) {
    if (!err) return "";
    return String(err.message || err);
  }

  const API = { confirmSeen, skipTitle };
  global.ConfirmActions = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
