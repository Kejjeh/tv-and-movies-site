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

  /* Name the titles a message is about, so "2 changes couldn't be saved" is
   * something the user can act on instead of a riddle. `labelFor(key)` is the
   * page's own lookup (it already has the titles on screen); without one, or
   * for a key it doesn't know, the list is simply omitted rather than padded
   * with ids the user has never seen. Capped, because a banner is not a list
   * view and the count above it is already exact. */
  const NAMED = 3;
  function nameThem(ops, labelFor) {
    if (typeof labelFor !== "function") return "";
    const names = [];
    for (const o of ops || []) {
      const label = labelFor(o.key);
      if (label && !names.includes(label)) names.push(label);
    }
    if (!names.length) return "";
    if (names.length <= NAMED) return ` (${names.join(", ")})`;
    const rest = names.length - NAMED;
    return ` (${names.slice(0, NAMED).join(", ")} and ${rest} more)`;
  }

  // Pure: what the banner should say for a given write-queue state, or null
  // when there is nothing owed. Tested; renderOutbox below is the DOM glue.
  function outboxMessage(state, labelFor) {
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
      const ops = state.failedOps || [];
      const stalled = state.stalled || 0;
      /* Two very different facts used to share one sentence. A write the
       * server refused needs the user to decide something. A write that ran
       * out of retries while the connection was down needs nothing from them
       * at all — it is still here, still on disk, and goes out by itself when
       * the browser reconnects. Telling them that one "couldn't be saved" is
       * how a rating gets re-entered, or given up on, for no reason. */
      if (stalled === state.failed) {
        return {
          kind: "error",
          text: `${state.failed} ${plural(state.failed)} ${state.failed === 1 ? "hasn't" : "haven't"} been sent`
            + `${nameThem(ops, labelFor)} — there was no connection. `
            + `Nothing is lost: this goes out by itself when you're back online.`,
          retry: true,
          dismiss: true,
        };
      }
      const refused = ops.filter(o => o.fatal);
      const n = state.failed - stalled;
      let text = `${n} ${plural(n)} couldn't be saved${nameThem(refused, labelFor)}.`;
      if (stalled > 0) text += ` ${stalled} more ${stalled === 1 ? "is" : "are"} waiting for the connection.`;
      return { kind: "error", text, retry: true, dismiss: true };
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

  /* What the user is asked before anything is thrown away.
   *
   * The button used to say "Dismiss" and delete the writes on the first
   * click. Dismiss means "hide this message" to anyone who has used a
   * computer, and what it actually did was erase unsent ratings from memory
   * and from disk, with no confirmation and without ever saying which ones.
   * Giving up on a write is a real choice the user is allowed to make — but
   * it has to be the choice they think they are making, so it is named, it is
   * counted, and it takes a second click. */
  function discardPrompt(state, labelFor) {
    const n = (state && state.failed) || 0;
    const what = nameThem((state && state.failedOps) || [], labelFor);
    return `Give up on ${n} unsaved ${n === 1 ? "change" : "changes"}${what}? `
      + `They will never be sent, and this can't be undone.`;
  }

  // Paint the indicator into `el` for `state`, wiring the buttons to the
  // queue. Hidden entirely when nothing is owed, so the steady state is quiet.
  // `labelFor(key)` is optional — see nameThem.
  function renderOutbox(el, state, queue, labelFor) {
    if (!el) return;
    const msg = outboxMessage(state, labelFor);
    if (!msg) { el.hidden = true; el.innerHTML = ""; el.dataset.confirming = ""; return; }
    el.hidden = false;
    el.className = `outbox outbox-${msg.kind}`;
    // Mid-confirmation, and there is still something to give up on: keep
    // asking rather than repainting the question away under the cursor.
    if (el.dataset.confirming === "discard" && msg.dismiss) {
      el.innerHTML = `<span>${escapeHtml(discardPrompt(state, labelFor))}</span>`
        // Keep them first: the destructive answer should not be the one
        // sitting where the button the user just pressed used to be.
        + '<button class="auth-btn" data-outbox="discard-no">Keep them</button>'
        + '<button class="auth-btn" data-outbox="discard-yes">Give up on them</button>';
      if (!queue) return;
      el.querySelector('[data-outbox="discard-yes"]').onclick = () => {
        el.dataset.confirming = "";
        queue.discardFailed();
      };
      el.querySelector('[data-outbox="discard-no"]').onclick = () => {
        el.dataset.confirming = "";
        renderOutbox(el, state, queue, labelFor);
      };
      return;
    }
    el.dataset.confirming = "";
    el.innerHTML = `<span>${escapeHtml(msg.text)}</span>`
      + (msg.retry ? '<button class="auth-btn" data-outbox="retry">Try again</button>' : "")
      + (msg.dismiss ? '<button class="auth-btn" data-outbox="discard">Give up on them…</button>' : "");
    if (!queue) return;
    // Try again is every affordance in one: it replays the dead letters, and
    // it re-attempts the storage write a paused queue is waiting on.
    if (msg.retry) el.querySelector('[data-outbox="retry"]').onclick = () => queue.retryFailed();
    if (msg.dismiss) el.querySelector('[data-outbox="discard"]').onclick = () => {
      el.dataset.confirming = "discard";
      renderOutbox(el, state, queue, labelFor);
    };
  }

  const UI = { escapeHtml, formatYear, narrativeLabel, colorFor, titleCase,
               outboxMessage, renderOutbox, discardPrompt };

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
