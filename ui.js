/* Shared UI primitives for the static pages.
 *
 * The pages are classic <script> tags (no bundler), so this file exposes its
 * helpers as globals AND as CommonJS exports so they can be unit-tested under
 * `node --test`. Load it before any page script:
 *
 *     <script src="ui.js"></script>
 *     <script src="app.js"></script>
 */
(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // " (2010)" for a truthy year, "" otherwise — matches the inline template
  // literals the pages used to repeat.
  function formatYear(year) {
    return year ? ` (${year})` : "";
  }

  // Resolve a narrative id to its human label, falling back to the id itself.
  function narrativeLabel(narratives, id) {
    const found = (narratives || []).find(n => n.id === id);
    return found ? found.label : id;
  }

  // map[key] when present, otherwise the fallback colour.
  function colorFor(map, key, fallback) {
    return (map && map[key] != null) ? map[key] : fallback;
  }

  // Capitalise the first letter of each word (hyphen counts as a boundary):
  // "animation-dark" -> "Animation-Dark".
  function titleCase(s) {
    return String(s || "").replace(/\b\w/g, c => c.toUpperCase());
  }

  // ---- unsaved-writes indicator (the durable outbox's only UI) ----------
  // Why this tab can't save, in the user's terms, keyed by the outbox's
  // `readOnlyReason`. The two storage ones end in the thing to try, because
  // unlike the other two they are the user's to clear — and what they ask for
  // is a retry or some free space, never "clear this site's data". That last
  // one does work, and it works by deleting exactly the unsent decisions this
  // whole module exists to keep; offering it as the routine fix would trade
  // the user's intent for a tidy indicator.
  const READ_ONLY_TEXT = {
    "other-tab": "This account is open in another tab — make changes there.",
    unsupported: "This browser can't safely share unsaved changes between tabs, so saving is off here.",
    storage: "Saving is paused: this browser is holding unsent changes that can't be read, and new ones could be undone by them. Nothing has been thrown away — try again, or reload the page.",
    stale: "Saving is paused: this browser has no room to record what's already been sent, so sending anything more could undo it. Free up some space on this device, then try again.",
  };
  // The reasons that mean "we own this account, but the mirror can't be
  // trusted" — as opposed to "another tab owns it". Only these can be true
  // while this tab is still holding work of its own.
  const MIRROR_BLOCKED = { storage: true, stale: true };

  // Pure: what the banner should say for a given write-queue state, or null
  // when there is nothing owed. Tested; renderOutbox below is the DOM glue.
  function outboxMessage(state) {
    if (!state) return null;
    const plural = n => (n === 1 ? "change" : "changes");
    /* A mirror that can't be trusted outranks everything else the indicator
     * could say. Nothing is going out while it is blocked, so "Saving 2
     * changes…" would be a progress bar for something that has stopped, and a
     * failed count would point the user at the network when the problem is
     * this browser. What is held is named here instead — it has not been
     * thrown away, and it goes out in order the moment the mirror is true
     * again, which is what "Try again" is for. */
    if (state.readOnly && MIRROR_BLOCKED[state.readOnlyReason]) {
      const held = (state.pending || 0) + (state.failed || 0);
      let owed = "";
      if (held > 0) {
        owed = ` ${held} ${plural(held)} ${held === 1 ? "is" : "are"} waiting here`;
        owed += state.unsaved > 0 ? " and not stored, so keep this tab open." : ".";
      }
      return { kind: "error", text: READ_ONLY_TEXT[state.readOnlyReason] + owed, retry: true };
    }
    if (state.failed > 0) {
      return {
        kind: "error",
        text: `${state.failed} ${plural(state.failed)} couldn't be saved.`,
        retry: true,
        dismiss: true,     // only a dead letter can be given up on
      };
    }
    if (state.pending > 0) {
      const saving = `Saving ${state.pending} ${plural(state.pending)}…`;
      // Some of what is owed never reached this browser's storage, so closing
      // the tab now would simply lose it. Said while it can still be acted on
      // — waiting until the writes are gone to mention it helps nobody.
      if (state.unsaved > 0) {
        return {
          kind: "error",
          text: `${saving} this browser won't store them, so keep this tab open until it's done.`,
          retry: false,
        };
      }
      return { kind: "pending", text: saving, retry: false };
    }
    // This tab is signed in but cannot save anything. Announced rather than
    // left to be discovered one refused rating at a time — and never as an
    // error the user could try again, because there is nothing owed here to
    // retry. Each reason says what would actually fix it; telling someone to
    // go and use "the other tab" when the real problem is this browser's
    // storage sends them looking for a tab that isn't there.
    if (state.readOnly) {
      return { kind: "error", text: READ_ONLY_TEXT[state.readOnlyReason] || READ_ONLY_TEXT["other-tab"], retry: false };
    }
    return null;
  }

  // Paint the indicator into `el` for `state`, wiring Retry/Dismiss to the
  // queue. Hidden entirely when nothing is owed, so the steady state is quiet.
  function renderOutbox(el, state, queue) {
    if (!el) return;
    const msg = outboxMessage(state);
    if (!msg) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.className = `outbox outbox-${msg.kind}`;
    el.innerHTML = `<span>${escapeHtml(msg.text)}</span>`
      + (msg.retry ? '<button class="auth-btn" data-outbox="retry">Try again</button>' : "")
      + (msg.dismiss ? '<button class="auth-btn" data-outbox="discard">Dismiss</button>' : "");
    if (!queue) return;
    // Try again is both affordances in one: it replays the dead letters, and
    // it re-attempts the storage write a paused queue is waiting on. Dismiss
    // is offered only where there is something to give up on.
    if (msg.retry) el.querySelector('[data-outbox="retry"]').onclick = () => queue.retryFailed();
    if (msg.dismiss) el.querySelector('[data-outbox="discard"]').onclick = () => queue.discardFailed();
  }

  const UI = { escapeHtml, formatYear, narrativeLabel, colorFor, titleCase,
               outboxMessage, renderOutbox };

  // Browser globals (classic scripts).
  global.escapeHtml = escapeHtml;
  global.formatYear = formatYear;
  global.narrativeLabel = narrativeLabel;
  global.colorFor = colorFor;
  global.titleCase = titleCase;
  global.renderOutbox = renderOutbox;
  global.UI = UI;

  // Register the service worker (installable PWA + offline shell). Browser
  // only, best-effort — never blocks or throws into page code.
  if (global.document && global.navigator && "serviceWorker" in global.navigator) {
    global.addEventListener("load", () => {
      global.navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // Node / test harness.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = UI;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
