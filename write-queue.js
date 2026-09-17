/* Write queue — a durable, ordered outbox for every owner-facing write.
 *
 * The problem it solves: each rating / skip / queue-add used to be a
 * fire-and-forget `await StatusStore.x()` behind an optimistic re-render. A
 * flaky phone connection meant the card left the deck (or the title left the
 * candidate list) while nothing reached Supabase — the visible state claimed a
 * decision the server never recorded, and the only signal was an alert() the
 * user could dismiss. Skips didn't even get that: confirm.js swallowed the
 * error entirely.
 *
 * This module makes a write survive the network instead:
 *   · ORDERED — one strictly FIFO queue, so the queue-before-status invariant
 *     (ADR 0005) holds across the whole session, not just within one call.
 *   · RETRIED — transient failures (offline, timeout, 5xx, 429) back off
 *     exponentially, bounded by `maxAttempts`. Nothing retries forever.
 *   · FAIL-CLOSED — when one op of a group permanently fails, the rest of that
 *     group is withheld: a failed queueAdd never lets its setStatus through.
 *     The withheld ops are dead-lettered WITH it, so "Try again" replays the
 *     whole intent (queueAdd first) instead of only the half that ran.
 *   · DURABLE — the outbox is mirrored to storage, so a write in flight when
 *     the tab closes flushes on the next load instead of vanishing — and when
 *     the browser refuses to store it, the caller is told that rather than
 *     told it was kept (see DURABILITY below).
 *   · SCOPED — the mirror lives under a key of its own per account, and only
 *     the signed-in account's key is ever read or drained, so one owner's
 *     unsent intent can never be replayed as another's.
 *   · SINGLE-WRITER — at most one tab per account may send or store, enforced
 *     by a Web Lock held for the whole session (see OWNERSHIP below).
 *   · BOUND — every drain pass is tied to the session that started it. A
 *     request still on the wire when the account changes settles into the
 *     account it was made for and touches nothing of the new one's.
 *   · HONEST — submit() resolves with the terminal outcome, so the caller can
 *     roll its optimistic edit back; `onChange` reports pending/failed counts
 *     and read-only status for a visible indicator.
 *
 * OWNERSHIP — why a lock and not a cleverer mirror.
 *
 * localStorage has no atomic read-modify-write. Every earlier shape here —
 * one blob, then a blob bucketed per account, then one bucketed per account
 * AND per tab — still made each tab read the stored value, edit it and write
 * the whole thing back. Two tabs interleaving get/get/set/set means the second
 * set is computed from a snapshot taken before the first, so the first tab's
 * unsent edits are erased. Splitting the blob into finer slots does not help:
 * the unit of atomicity is the STORAGE KEY, not the object inside it, so any
 * two writers of one key race no matter how the value is carved up.
 *
 * So the queue does not try to make concurrent writers safe; it makes sure
 * there is only ever one. `navigator.locks` is the browser's own mutual
 * exclusion, scoped to the origin and enforced by the browser rather than by
 * our bookkeeping: the lock for an account is taken before that account's key
 * is read and held — across every persist, every retry, every backoff — until
 * the session ends or the tab goes away. A tab that does not hold it never
 * reads, writes or drains that key, and says so (`state().readOnly`) instead
 * of quietly queueing writes it can never send.
 *
 * Handoff is the lock's too: closing the owner tab releases it, and a waiting
 * tab is granted it and picks up whatever was left unsent — no heartbeat, no
 * wall-clock "probably dead by now" guess, no window in which two tabs both
 * believe they own the same op.
 *
 * Without Web Locks there is no safe way to do this, so the queue FAILS CLOSED:
 * editing is refused with a plain explanation rather than accepted into a
 * mirror that another tab may erase. Reading the site is unaffected.
 *
 * DURABILITY — telling the truth about the mirror.
 *
 * localStorage can refuse: a full quota, a private window, a profile with site
 * data blocked. Every access here is already wrapped so a refusal cannot take
 * the page down, but swallowing it silently turned into a worse failure than
 * the one this module exists to prevent: the write was never written anywhere,
 * and the user was still told "it's kept, and goes out the next time you log
 * in". A promise of recovery that nothing can keep is worse than an error,
 * because the user acts on it and closes the tab.
 *
 * So the mirror's outcome is carried, not discarded:
 *   · Each op knows whether it is IN the mirror (`saved`). Ops read back from
 *     storage are, by definition; ops queued while a write to storage failed
 *     are not.
 *   · Ending a session reports per write which of the two it was — `deferred`
 *     ("kept, goes out next sign-in") only for intent that really is on disk,
 *     `lost` for intent that never reached it, with a message saying so.
 *   · `state()` publishes `unsaved` and `storageError`, so the indicator can
 *     warn while the writes are still owed rather than after they are gone.
 *   · A key we could not READ — access refused, bytes that are not JSON, or an
 *     outbox in a shape this version does not know — is never written over. It
 *     may hold unsent writes, and replacing them with an empty outbox would be
 *     exactly the silent loss of saved intent this module forbids. Nor is it
 *     sent AROUND: a backlog we cannot see is older than anything typed now,
 *     so sending the new write first and finding the old one at the next
 *     sign-in replays a stale value on top of it. Unreadable means unknown,
 *     never empty — so saving is refused, in its own words, until the key can
 *     be read. Reading and browsing the site are unaffected.
 *   · A refusal to WRITE is not fatal on its own — the network, not the
 *     mirror, is where a write is going — so editing stays open, loudly
 *     un-backed-up, and every later persist is the retry.
 *   · ...unless that refusal left work on disk that is no longer owed. An op
 *     the mirror holds and the queue has finished with — sent, superseded,
 *     dead-lettered — is pruned by the next persist; when that persist is
 *     refused the copy stays, and the next sign-in replays it over whatever
 *     newer value the same title has been given since. That copy is older
 *     than everything still queued here, so while it is there NOTHING MAY BE
 *     SENT: not a new write, and not one already accepted and waiting. The
 *     queue PAUSES — refusing edits, holding what it has taken, retrying the
 *     prune — and the first persist that lands makes the mirror true again,
 *     drains what was held in the order it was made, and reopens editing.
 *     Accepted work is never discarded to get moving again: it is either
 *     sent once the mirror is true, or reported at sign-out like any other
 *     write the session ended under.
 *
 * Deliberate, documented limit:
 *   · AT LEAST ONCE. A request already on the wire when the session ends
 *     cannot be cancelled, and its op stays in that account's key — so it can
 *     be sent a second time at the next sign-in. Every transport op is an
 *     idempotent upsert of one (title, value), so a replay re-states the same
 *     intent rather than compounding.
 *
 * Pure and dependency-injected (transport / storage / locks / sleep), so the
 * real shipped code path is unit-tested under `node --test` without a network.
 *
 * Exposed as a global for classic <script> pages and as a CommonJS export.
 */
(function (global) {
  "use strict";

  /* One key per account: `twb.outbox.v4.<account>` holding {v, pending, failed}.
   *
   * Per-account KEYS rather than one keyed blob of accounts, because the key is
   * the unit localStorage is atomic over: two accounts open in two tabs hold
   * two different locks, so they must not share one key or they would race each
   * other exactly as two tabs of one account used to. */
  const STORAGE_KEY = "twb.outbox.v4";
  /* v3's blob: {v, accounts: {<account>: {tabs: {<tab>: {at, pending, failed}}}}}.
   * Read once, per account, to carry unsent writes across the upgrade — never
   * written. Dropping it silently would lose exactly the intent this module
   * exists to keep. */
  const LEGACY_KEY = "twb.outbox.v3";
  const ANON_BUCKET = "anon";
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 500;
  const MAX_DELAY_MS = 30000;

  // Ops where a newer write for the same key makes an older queued one
  // pointless: re-tapping "loved" then "liked" should send one status, not two
  // (and must not send them out of order). queueAdd is NOT here — it is the
  // ordering anchor its group's status depends on.
  const LAST_WRITE_WINS = new Set(["setStatus", "markSkipped"]);

  const BUSY_MSG = "this account is already open in another tab — make changes there";
  const NO_LOCK_MSG = "this browser can't safely share unsaved changes between tabs";
  /* Saving is paused because the mirror cannot be trusted — NOT because another
   * tab owns it. Sending the user to look for a tab that does not exist is its
   * own kind of lie, so these say what is actually wrong. */
  const UNREADABLE_MSG = "this browser is holding changes that can't be read, so saving is paused here";
  const STALE_MSG = "this browser couldn't update its record of what's already been sent, so saving is paused here";
  // Reporting intent that was taken but never stored. Its own sentence: these
  // follow a full stop in the caller's message, and each ends with the action.
  const LOST_QUOTA_MSG = "There was no room in this browser to store it, so please make the change again.";
  const LOST_READ_MSG = "It couldn't be stored in this browser, so please make the change again.";
  const LOST_MSG = "It was never stored, so please make the change again.";

  // Is this failure worth retrying, or will it fail identically forever?
  //
  // Transient: no response at all (offline / DNS / abort), a timeout, 429, or
  // any 5xx. Permanent: the request itself is refused — 4xx, or a PostgREST
  // error carrying a Postgres SQLSTATE in a class that cannot be retried away
  // (22 data exception, 23 integrity violation, 42 syntax/insufficient
  // privilege — an RLS refusal is 42501 and is the likeliest one here).
  function classifyError(err) {
    if (!err) return "transient";
    const status = Number(err.status || err.statusCode || 0);
    if (status === 429 || status === 408) return "transient";
    if (status >= 500) return "transient";
    if (status >= 400) return "permanent";
    const code = String(err.code == null ? "" : err.code);
    if (/^(22|23|42)/.test(code)) return "permanent";
    // PostgREST's own auth codes: the JWT is bad/expired, so retrying the same
    // request cannot help — the user has to log in again.
    if (code === "PGRST301" || code === "PGRST302") return "permanent";
    return "transient";
  }

  /* Storage that never throws, and never hides that it didn't work. Safari
   * private mode, a blocked-cookies profile and a full quota all make plain
   * access raise, and an outbox is not worth taking the page down for — but
   * `get` returning null for "refused" is indistinguishable from "nothing
   * stored", and a swallowed `set` is a write the user is told survives. So
   * both report: get -> {ok, value}, set -> true/false. Applied to the
   * injected store too, so a caller can't hand us a hostile one. */
  function guard(get, set) {
    return {
      get(k) {
        try { return { ok: true, value: get(k) }; }
        catch (_) { return { ok: false, value: null }; }
      },
      set(k, v) {
        try { set(k, v); return true; }
        catch (_) { return false; }     // quota / private mode / blocked
      },
    };
  }

  // No localStorage at all: reads are honestly empty, writes honestly fail —
  // so the queue runs un-mirrored and says so, instead of pretending to store.
  function defaultStorage() {
    try {
      const ls = global.localStorage;
      if (ls) return guard(k => ls.getItem(k), (k, v) => ls.setItem(k, v));
    } catch (_) { /* access itself can throw */ }
    return { get: () => ({ ok: true, value: null }), set: () => false };
  }

  // The browser's LockManager, or null where it isn't usable (no Web Locks, or
  // an insecure context). null means fail closed, never "assume we're alone".
  function defaultLocks() {
    try {
      const nav = global.navigator;
      if (nav && nav.locks && typeof nav.locks.request === "function") return nav.locks;
    } catch (_) { /* access itself can throw */ }
    return null;
  }

  /* Per-LOAD group-id prefix. Group ids are the identity a settling op uses to
   * find the promise it must resolve, and they are PERSISTED — so a restored
   * op carries the id it had in the tab that queued it. A counter that restarts
   * at 0 hands that same id to the first NEW submit, and the restored op then
   * resolves a promise belonging to a write that hasn't run. A fresh prefix per
   * load makes ids unique across reloads and across tabs. */
  function newSessionId() {
    try {
      const c = global.crypto;
      if (c && typeof c.randomUUID === "function") return c.randomUUID().slice(0, 8);
    } catch (_) { /* no webcrypto */ }
    return Date.now().toString(36) + "." + Math.random().toString(36).slice(2, 8);
  }

  /* opts:
   *   transport   {setStatus, queueAdd, markSkipped} — async fn(args) per op
   *   storage     {get(key), set(key, value)} — defaults to localStorage
   *   locks       a LockManager — defaults to navigator.locks; pass null to
   *               exercise the fail-closed path
   *   sleep       async (ms) => void — injected in tests to skip real waiting
   *   onChange    (state) => void — called whenever the reportable state moves
   *   sessionId   string — pin the group-id prefix (tests only)
   *   maxAttempts / baseDelayMs / maxDelayMs
   */
  function createWriteQueue(opts) {
    opts = opts || {};
    const transport = opts.transport || {};
    const raw = opts.storage;
    const storage = raw ? guard(k => raw.get(k), (k, v) => raw.set(k, v)) : defaultStorage();
    const locks = opts.locks !== undefined ? opts.locks : defaultLocks();
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const onChange = opts.onChange || function () {};
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : MAX_ATTEMPTS;
    const baseDelay = opts.baseDelayMs != null ? opts.baseDelayMs : BASE_DELAY_MS;
    const maxDelay = opts.maxDelayMs != null ? opts.maxDelayMs : MAX_DELAY_MS;
    const sid = opts.sessionId || newSessionId();

    let pending = [];          // ops still owed to the server, in write order
    let failed = [];           // ops that gave up — kept for reporting + retry
    let seq = 0;
    let active = false;        // a drain loop is running right now
    let inflight = null;       // the op that loop is currently sending
    let drainPromise = Promise.resolve();
    let started = false;       // bound to an account
    let everStarted = false;
    let account = null;        // whose outbox we are bound to
    let writer = false;        // ...and do we hold the lock that lets us send it
    let settled = false;       // has the ownership question been answered yet
    let unlock = null;         // releases our hold; resolves once fully released
    let releasing = null;      // an in-progress release, awaited before re-taking
    let waiting = null;        // an outstanding request for a lock another tab holds
    let binding = 0;           // start()s whose ownership question is still open
    /* How storage is failing us right now, or null when it isn't:
     *   "unwritable" — the browser refused to store the outbox (quota, private
     *                  mode). Editing stays open; nothing claims to be kept.
     *   "unreadable" — this account's key could not be read, parsed, or
     *                  recognised. Its bytes are left exactly as they are,
     *                  because they may be unsent writes, and nothing is sent
     *                  or accepted for this account until a read succeeds.
     * "unwritable" is cleared by the first persist() that succeeds; so is
     * "unreadable" by the first read that works (bind, or a later edit). */
    let fault = null;
    /* True when the mirror holds a copy of work the live queue has finished
     * with and the write that should have pruned it was refused. That copy is
     * a GHOST: nothing here can remove it, and the next sign-in replays it as
     * if it were still owed — on top of any newer value the same title has
     * been given in the meantime. Set when such an op leaves the queue,
     * cleared by the first persist() that lands. */
    let retired = false;
    /* Bumped every time the bound session changes (account switch, sign-out).
     * A drain pass captures it and re-checks after every await: a response that
     * arrives once the generation has moved on belongs to a session that is
     * over, and must not touch the live queue, the new account's key, or the
     * bookkeeping (`active` / `inflight`) of the pass that replaced it. The
     * same counter guards every lock grant, so a lock handed to us after we
     * moved on is released instead of adopted. */
    let generation = 0;
    /* start()/stop() are serialised: they take and give back a lock, which is
     * asynchronous, and two auth events landing together must not interleave
     * an acquire for one account with a release for another. */
    let lifecycle = Promise.resolve();
    const groups = new Map();  // gid -> {left, resolve, error} for this session

    function bucket() { return account == null ? ANON_BUCKET : String(account); }
    function keyFor(b) { return `${STORAGE_KEY}.${b}`; }
    function lockFor(b) { return `${STORAGE_KEY}.${b}`; }
    function readOnlyReason() { return locks ? "other-tab" : "unsupported"; }
    function readOnlyMessage() { return locks ? BUSY_MSG : NO_LOCK_MSG; }
    // Why a write that was taken never reached the mirror. Said to the user
    // after their write is rolled back, so it ends in what to do about it.
    function lostMessage() {
      if (fault === "unreadable") return LOST_READ_MSG;
      if (fault === "unwritable") return LOST_QUOTA_MSG;
      return LOST_MSG;
    }

    /* Why this tab must refuse an edit even though it holds the account's
     * lock, or null when it needn't. Both cases are the same shape: the mirror
     * is in a state where taking the write would let older intent land on the
     * server after it. Both are recoverable — see recover(). */
    function mirrorBlock() {
      if (fault === "unreadable") return "storage";
      if (retired) return "stale";
      return null;
    }
    function mirrorMessage(reason) {
      return reason === "stale" ? STALE_MSG : UNREADABLE_MSG;
    }

    /* Storage that refused once may take the next one: the key we couldn't
     * read may be readable now, the space we needed may have been freed. Every
     * attempt IS the retry — no timer, no watcher, no extra state — so trying
     * once more is the whole recovery path, and it is run from every place the
     * queue naturally gets to: before an edit is refused, when the indicator's
     * Try again is pressed, and from the drain itself while it is paused.
     *
     * A read that works adopts the backlog we were blocked on AHEAD of
     * anything this session takes, which is exactly the order it is owed in.
     * A read that fails again changes nothing at all — it does not re-refuse
     * what is already held, because work accepted before the mirror went bad
     * is still owed and is not this function's to throw away. */
    function recover() {
      if (!started || !settled || !writer) return;
      if (fault === "unreadable") { if (mirrorReadable()) adopt(pending); }
      else if (retired) persist();
    }

    // Can this account's key be read and recognised right now? Asked before
    // re-adopting, so a still-broken read is a no-op rather than a second
    // trip through adopt()'s refusal path.
    function mirrorReadable() {
      const mine = readJson(keyFor(bucket()));
      return mine.ok && (mine.value === null || isOutbox(mine.value));
    }

    /* Nothing may be sent while the mirror holds something we cannot read or
     * could not prune: what it holds was queued BEFORE everything still in
     * this queue, so sending any of this now puts the older intent on top of
     * it at the next sign-in — the same inversion for work already accepted
     * as for a write taken afresh. The answer is not to give the work up; it
     * is to make the mirror true. Each attempt is the retry, on the same
     * bounded backoff the network gets, because it is the same kind of
     * failure: a resource that refused us and may not next time.
     *
     * Resolves true when the mirror can be trusted and the drain may carry
     * on. False when it still cannot: the drain then stops exactly where it
     * is, holding everything it has taken — nothing sent, nothing dropped,
     * no waiter resolved — and the next flush() picks up from here. That
     * flush comes from a reload, from the indicator's Try again, or from an
     * edit whose own recover() lands; none of them needs a new rating, and
     * whichever arrives first drains the held work and settles its waiters. */
    async function repairMirror(gen) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        recover();
        if (!mirrorBlock()) { notify(); return true; }
        await sleep(delayFor(attempt, null));
        if (gen !== generation) return false;
      }
      notify();          // paused — said while the work is still held, not after
      return false;
    }

    /* Read one key. {ok:true, value} — value null when nothing is stored —
     * or {ok:false}, which means we could not see what is there. Those are
     * different facts and the caller must not confuse them: "empty" is safe to
     * write over, "can't see it" is not. Bytes that don't parse count as
     * can't-see-it: something is stored, we just can't read it. */
    function readJson(key) {
      const got = storage.get(key);
      if (!got.ok) return { ok: false, value: null };
      if (!got.value) return { ok: true, value: null };
      try {
        const saved = JSON.parse(got.value);
        if (saved && typeof saved === "object") return { ok: true, value: saved };
      } catch (_) { /* fall through */ }
      return { ok: false, value: null };
    }

    function listOf(holder, field) {
      return (holder && Array.isArray(holder[field])) ? holder[field] : [];
    }

    /* Is this parsed value really one of our outboxes? Version and shape both,
     * because "parsed to an object" is not the same fact as "I know what this
     * is". A blob written by a LATER version, or one whose lists aren't ops,
     * is somebody's unsent intent in a form we can't drain — treating it as an
     * empty outbox would write over it and send around it, which are the two
     * things an unreadable key must never suffer. */
    function isOp(o) {
      return !!o && typeof o === "object" && typeof o.op === "string" && !!o.op
        && !!o.args && typeof o.args === "object";
    }
    function isOutbox(o) {
      return !!o && o.v === 4 && Array.isArray(o.pending) && Array.isArray(o.failed)
        && o.pending.every(isOp) && o.failed.every(isOp);
    }

    /* Mirror this account's outbox. Only the lock holder ever gets here, so the
     * read-modify-write below cannot interleave with another tab's; and the key
     * is this account's alone, so it cannot interleave with another account's
     * either. Refuses to write while unbound or read-only — ops with no owner,
     * or no right to send, must not be filed under an account. */
    function persist() {
      if (!started || !writer) return false;
      // Never write over a key we could not read: it may hold unsent intent.
      if (fault === "unreadable") return false;
      const ok = storage.set(keyFor(bucket()), JSON.stringify({ v: 4, pending, failed }));
      // Every op held right now is in the bytes we just wrote — that is what
      // lets teardown() tell "kept" from "lost" per write rather than guessing.
      if (ok) {
        for (const o of pending) o.saved = true;
        for (const o of failed) o.saved = true;
        // The mirror matches the live queue again, so whatever it used to hold
        // and we had finished with is gone from it: no ghosts left to replay.
        retired = false;
      }
      // Each persist is also the retry: storage that refused once may take the
      // next one (the queue drained, the user freed space), and the first that
      // lands clears the warning.
      fault = ok ? null : "unwritable";
      return ok;
    }

    /* v3 kept every account's tabs in one blob. Read our account's slots once,
     * oldest stamp first so each tab's own order survives, and hand them to the
     * (single) writer. Never written back: the blob is left exactly as found,
     * so this cannot race another account's tab, and it is consulted only while
     * this account has no v4 key — which persist() creates immediately. */
    function readLegacy(b) {
      const out = { pending: [], failed: [] };
      // A legacy blob we can't read migrates nothing, and is never written
      // to, so it is not a fault — only the account's own key can be one.
      const blob = readJson(LEGACY_KEY).value;
      const acct = blob && blob.accounts && typeof blob.accounts === "object"
        ? blob.accounts[b] : null;
      const tabs = acct && acct.tabs;
      if (!tabs || typeof tabs !== "object") return out;
      const slots = Object.keys(tabs)
        .map(k => tabs[k])
        .filter(s => s && typeof s === "object")
        .sort((x, y) => Number(x.at || 0) - Number(y.at || 0));
      for (const s of slots) {
        out.pending = out.pending.concat(listOf(s, "pending"));
        out.failed = out.failed.concat(listOf(s, "failed"));
      }
      return out;
    }

    /* Load the bound account's outbox, and take over `carried` — anything
     * submitted while the ownership question was still open. Only ever called
     * while holding this account's lock.
     *
     * A key that cannot be read — access refused, bytes that are not JSON, or
     * an outbox whose version or shape this build doesn't know — is left
     * EXACTLY as it is: it may hold unsent writes, and an empty outbox written
     * over them is the silent loss of saved intent this module exists to
     * prevent. It is not sent around either. Whatever is in there was queued
     * BEFORE anything this session takes, so a write accepted now would reach
     * the server first and be overwritten by that backlog at the next sign-in
     * — the user's newest decision undone by their oldest. Unknown is not
     * empty, so the account is refused (`readOnlyReason: "storage"`) until a
     * read succeeds; browsing the site is untouched. */
    function adopt(carried) {
      const mine = readJson(keyFor(bucket()));
      if (!mine.ok || !(mine.value === null || isOutbox(mine.value))) {
        fault = "unreadable";        // persist() refuses this key from here on
        pending = carried || [];
        failed = [];
        refuseHeld(UNREADABLE_MSG);  // nothing may go out ahead of the unknown
        return;
      }
      fault = null;                  // readable again after an earlier failure
      retired = false;               // and what it holds is what we hold
      if (mine.value) {
        pending = listOf(mine.value, "pending");
        failed = listOf(mine.value, "failed");
      } else {
        const legacy = readLegacy(bucket());
        pending = legacy.pending;
        failed = legacy.failed;
      }
      // Read back out of storage, so on disk by definition — even if the next
      // persist is refused, this intent is not lost.
      for (const o of pending) o.saved = true;
      for (const o of failed) o.saved = true;
      if (carried && carried.length) pending = pending.concat(carried);
      persist();
    }

    function state() {
      // Signed in, but unable to save — because another tab owns the account,
      // or because the mirror itself can't be trusted to keep the order. One
      // flag for the callers, `readOnlyReason` for which of them it is.
      const noLock = started && settled && !writer;
      const block = (started && settled && writer) ? mirrorBlock() : null;
      return {
        pending: pending.length,
        failed: failed.length,
        // The keys still owed to the server. A page reloading its overlay uses
        // these to avoid replacing an optimistic edit with the stale server
        // value of a write that simply hasn't landed yet.
        pendingKeys: [...new Set(pending.map(o => o.key))],
        // Copies: callers render these, they must not be able to edit the
        // outbox. `blocked` marks an op that was withheld because an earlier
        // op of the same write failed — it was never sent.
        failedOps: failed.map(o => ({ op: o.op, key: o.key, error: o.error, blocked: !!o.blocked })),
        // This tab is signed in but cannot save edits. Surfaced rather than
        // hidden: a tab that silently swallows ratings is the failure this
        // module exists to prevent.
        readOnly: noLock || !!block,
        // "other-tab" | "unsupported" — someone else owns the write lock;
        // "storage" | "stale" — we own it, but the mirror can't be trusted.
        readOnlyReason: noLock ? readOnlyReason() : block,
        // Of the pending writes, how many are NOT in the mirror — i.e. how
        // many would simply be gone if this tab closed now. The indicator
        // warns on this while they are still owed, instead of after the fact.
        unsaved: pending.reduce((n, o) => n + (o.saved ? 0 : 1), 0),
        // null | "unwritable" | "unreadable" — see `fault`.
        storageError: fault,
      };
    }

    function notify() { onChange(state()); }

    function delayFor(attempts, err) {
      const hinted = Number(err && err.retryAfter);
      if (hinted > 0) return Math.min(hinted * 1000, maxDelay);
      return Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
    }

    // Remove by identity, never by position: a retryFailed() that lands while
    // the head op is in flight shifts every index, and `pending.shift()` would
    // then delete an untried op and re-send the one that just succeeded.
    function remove(op) {
      const i = pending.indexOf(op);
      if (i >= 0) { pending.splice(i, 1); retire(op); }
    }

    // This op is no longer owed where the mirror says it is. If the persist
    // that follows lands, the mirror is corrected and this is forgotten; if it
    // is refused, the stale copy is still on disk and will be replayed.
    function retire(op) {
      if (op && op.saved) retired = true;
    }

    // Settle one op against its submitting group. A group resolves once every
    // op in it has landed or failed; the first error wins the outcome.
    function settle(op, err, info) {
      const g = groups.get(op.gid);
      if (!g) return;                       // restored from storage: no waiter
      if (err && !g.error) g.error = err;
      if (info && info.superseded) g.superseded = true;
      if (info && info.deferred) g.deferred = true;
      if (info && info.readOnly) g.readOnly = true;
      if (info && info.lost) g.lost = true;
      g.left -= 1;
      if (g.left > 0) return;
      groups.delete(op.gid);
      if (g.error) {
        g.resolve({
          ok: false,
          error: g.error,
          // `deferred` is not a refusal: the session ended before the write
          // could be sent and the op is kept in that account's key. Callers
          // must not tell the user it was undone, and must not treat it as a
          // permanent failure — nothing has been given up on. It is claimed
          // ONLY for intent that is really on disk: a group with even one op
          // the browser refused to store is reported lost, because a promise
          // to send it next time is one nothing here can keep.
          deferred: !!g.deferred && !g.lost,
          // `lost` means the write was taken but never reached the server OR
          // storage, so there is nothing to recover and nothing to retry: the
          // caller must undo its optimistic edit and say it has to be redone.
          lost: !!g.lost,
          // `readOnly` is not a refusal by the server either: this tab never
          // owned the outbox, so the write was never accepted. Nothing is
          // stored and nothing will be retried — the user has to make the edit
          // in the tab that holds the account.
          readOnly: !!g.readOnly,
          // Not a server refusal either way, so neither of those is permanent.
          permanent: !g.deferred && !g.readOnly && !g.lost
            && classifyError(g.error) === "permanent",
        });
        return;
      }
      // `superseded` means a newer write for the same key replaced this one
      // before it was sent. The intent is satisfied, but by the newer value —
      // callers must not treat this op's value as the one the server holds.
      g.resolve(g.superseded ? { ok: true, superseded: true } : { ok: true });
    }

    // One op of a group died, so the group's remaining ops must not be sent:
    // this is what keeps a failed queueAdd from letting its setStatus through.
    // They are dead-lettered rather than dropped — withholding the status is
    // the right call at the time, but throwing it away would mean "Try again"
    // could never recover the rating the user actually made.
    function abandonGroup(op, err) {
      const doomed = pending.filter(o => o.gid === op.gid);
      pending = pending.filter(o => o.gid !== op.gid);
      for (const o of doomed) {
        retire(o);
        o.attempts = 0;
        o.blocked = true;
        o.error = `not sent — "${op.op}" failed first in the same write`;
        failed.push(o);     // after the op that failed, so a retry keeps order
      }
      settle(op, err);
      for (const o of doomed) settle(o, err);
    }

    // Drop older queued writes the new one supersedes. The op currently being
    // sent is exempt — it may already be on the wire.
    function supersede(op) {
      if (!LAST_WRITE_WINS.has(op.op)) return;
      const kept = [];
      const dropped = [];
      for (const o of pending) {
        if (o !== inflight && o.op === op.op && o.key === op.key) dropped.push(o);
        else kept.push(o);
      }
      pending = kept;
      for (const o of dropped) { retire(o); settle(o, null, { superseded: true }); }
    }

    /* ---- ownership ---------------------------------------------------- */

    /* Ask for `name` only if it is free right now, and hold it until released.
     * Resolves {held, release}: held=false means another tab owns the account,
     * which is an answer, not a failure — this tab goes read-only and waits for
     * a handoff rather than blocking the page behind an unbounded request. */
    function acquire(name) {
      let letGo;
      const holdUntil = new Promise(r => { letGo = r; });
      return new Promise(resolve => {
        let answered = false;
        const answer = value => { if (!answered) { answered = true; resolve(value); } };
        let done;
        try {
          done = locks.request(name, { mode: "exclusive", ifAvailable: true }, lock => {
            if (!lock) { answer({ held: false, release: () => Promise.resolve() }); return; }
            // `done` is assigned by the line below once request() returns;
            // deferring the read keeps this correct even for a LockManager
            // that runs the callback synchronously.
            answer({ held: true, release: () => { letGo(); return Promise.resolve().then(() => done); } });
            return holdUntil;      // hold the lock for as long as we are the writer
          });
        } catch (_) {
          answer({ held: false, release: () => Promise.resolve() });
          return;
        }
        // Belt and braces: if the request settles without the callback ever
        // having been handed a lock, treat it as "not ours" rather than
        // leaving the page waiting on an answer that is not coming.
        const noLock = () => answer({ held: false, release: () => Promise.resolve() });
        Promise.resolve(done).then(noLock, noLock);
      });
    }

    /* Queue behind the tab that holds `name`. The browser grants this when that
     * tab releases it — including when it is simply closed, which is the whole
     * handoff story: no heartbeat, no staleness guess, no overlap. */
    function awaitHandoff(name, gen) {
      const ctl = typeof global.AbortController === "function" ? new global.AbortController() : null;
      let letGo;
      const holdUntil = new Promise(r => { letGo = r; });
      let request;
      const options = ctl ? { mode: "exclusive", signal: ctl.signal } : { mode: "exclusive" };
      try {
        request = locks.request(name, options, lock => {
          // Granted after we moved on (signed out, switched account): returning
          // without holding gives it straight back to whoever is next in line.
          if (!lock || gen !== generation) return;
          promote(() => { letGo(); return Promise.resolve().then(() => request); });
          return holdUntil;
        });
      } catch (_) {
        return { abort: () => {} };
      }
      Promise.resolve(request).catch(() => {});   // aborted: nothing owed
      return {
        abort: () => {
          try { if (ctl) ctl.abort(); } catch (_) { /* already granted */ }
          letGo();
        },
      };
    }

    // The previous owner let go and we are next: take over its unsent writes.
    function promote(release) {
      waiting = null;
      writer = true;
      settled = true;
      unlock = release;
      adopt([]);
      notify();
      flush();
    }

    /* End the current session's hold on the outbox.
     *
     * The bound account's outbox is mirrored FIRST, so everything unsent
     * survives for the next time they sign in here; then it is dropped from
     * memory so nothing of theirs can be sent, persisted or reported under
     * whoever comes next, the generation is bumped so any request still on the
     * wire settles into nothing, the lock is handed back so another tab can
     * take over, and every caller still awaiting is told its write is kept
     * rather than left hanging. */
    function teardown(message) {
      persist();
      generation += 1;
      active = false;
      inflight = null;
      drainPromise = Promise.resolve();
      const orphaned = pending;
      pending = [];
      failed = [];
      if (waiting) { waiting.abort(); waiting = null; }
      if (unlock) { releasing = Promise.resolve(unlock()).catch(() => {}); unlock = null; }
      writer = false;
      settled = false;
      /* Per write, which of the two happened: mirrored under this account and
       * genuinely waiting for the next sign-in, or never stored at all. The
       * second used to be reported as the first — "kept until you sign in
       * again" over a write that no storage ever accepted — which is the one
       * lie this module must not tell, because the user closes the tab on it. */
      const kept = new Error(message);
      const gone = new Error(lostMessage());
      for (const o of orphaned) {
        if (o.saved) settle(o, kept, { deferred: true });
        else settle(o, gone, { lost: true });
      }
    }

    /* Take over the live queue for `acct`, then find out whether this tab may
     * actually write for it.
     *
     * The rebinding itself is SYNCHRONOUS — a sign-in or account switch takes
     * effect the instant the auth event fires, so a tap in the same turn is
     * filed under the account that is signed in now, never the one that just
     * left. Only the question "may I write for it" is asynchronous, because
     * only the browser can answer it; until it does, writes are held in memory
     * and nothing is read from or written to storage.
     *
     * Binding is held back until the caller knows who is signed in, for two
     * reasons: a restored write replayed at a logged-out client is refused and
     * dead-lettered for nothing, and — the sharper one — storage is shared by
     * every account that uses this browser. Each account's outbox has a key of
     * its own and only the named one is ever read, so signing in as someone
     * else leaves the previous owner's unsent writes untouched and unsent
     * rather than replaying their ratings under the new session.
     *
     * Safe to call on every auth event: re-starting the same account just
     * resumes the drain. */
    function start(accountId) {
      const acct = accountId == null ? null : String(accountId);
      const target = acct == null ? ANON_BUCKET : acct;
      if (!(started && bucket() === target)) {
        // Ops queued before the first start() were made by whoever is signing
        // in now — the page just hadn't resolved the session yet — so they stay
        // in the live queue. After a stop(), submit() refuses, so there are
        // none to carry; after a switch, teardown() has already emptied it.
        if (started) teardown("signed out before this write was sent");
        account = acct;
        started = true;
        everStarted = true;
        settled = false;
        generation += 1;
        binding += 1;
        const gen = generation;
        const finish = () => { binding -= 1; };
        lifecycle = lifecycle.then(() => claim(gen)).then(finish, finish);
      }
      notify();
      return lifecycle.then(() => flush());
    }

    /* Ask the browser for the bound account's write lock, and act on the
     * answer. Every step re-checks the generation: a grant that arrives after
     * the session moved on is handed straight back rather than adopted. */
    async function claim(gen) {
      if (gen !== generation) return;
      if (!locks) {
        // No browser-enforced mutual exclusion, so there is no safe way to own
        // the mirror. Refuse rather than accept writes another tab may erase.
        settled = true;
        refusePending();
        notify();
        return;
      }
      // Never re-request a lock we are still giving back: the grant could
      // otherwise be decided before the release lands and this tab would see
      // itself as busy.
      if (releasing) { const r = releasing; releasing = null; await r; }
      if (gen !== generation) return;

      const got = await acquire(lockFor(bucket()));
      if (gen !== generation) { got.release(); return; }   // session ended while asking
      settled = true;
      if (got.held) {
        writer = true;
        unlock = got.release;
        adopt(pending);               // what is on disk, plus what we carried
      } else {
        // Another tab owns this account. Nothing of ours is stored or sent;
        // say so, and queue for the handoff if that tab ever lets go.
        refusePending();
        waiting = awaitHandoff(lockFor(bucket()), gen);
      }
      notify();
    }

    /* This tab may not write, so tell every caller still waiting that its edit
     * was never taken. Holding them "for later" would be the silent loss all
     * over again: a read-only tab cannot mirror them, so a crash would lose
     * them without a word, and replaying a backlog of stale ratings if it is
     * ever promoted is not the intent the user expressed. */
    function refusePending() { refuseHeld(readOnlyMessage()); }

    // Drop everything held in memory and tell each caller why it was never
    // taken. `readOnly` on the result is the callers' "not queued anywhere,
    // roll your edit back" — the reason differs, the obligation doesn't.
    function refuseHeld(message) {
      const held = pending;
      pending = [];
      failed = [];
      if (!held.length) return;
      const err = new Error(message);
      for (const o of held) settle(o, err, { readOnly: true });
    }

    /* Suspend the outbox: this tab is no longer signed in.
     *
     * Pages only ever called start(), on the theory that a logged-out page
     * simply never submits. That left a signed-out tab still draining — and
     * still retrying, for up to maxAttempts of backoff — under an account whose
     * session had ended, and holding its lock so no other tab could take over.
     * Signing out now explicitly hands the outbox back: what is unsent stays
     * mirrored under that account, and nothing further is sent or stored until
     * someone signs in again.
     *
     * Synchronous on purpose — a sign-out must take effect the instant it
     * happens, not one turn of the event loop later. */
    function stop() {
      if (!started) { notify(); return; }
      teardown("not sent yet — kept until you sign in to this account again");
      account = null;
      started = false;
      notify();
    }

    /* Submit an ordered group of ops. They are written in array order and
     * treated as one unit: the returned promise resolves {ok:true} once all of
     * them land, or {ok:false, error, ...} as soon as one gives up. */
    function submit(ops) {
      if (!started && everStarted) {
        return Promise.resolve({
          ok: false, permanent: true, deferred: false, readOnly: false, lost: false,
          error: new Error("signed out — log in again to save this"),
        });
      }
      if (started && settled && !writer) {
        // Read-only tab: refuse up front instead of taking the write into a
        // queue that can never be stored or sent.
        return Promise.resolve({
          ok: false, permanent: false, deferred: false, readOnly: true, lost: false,
          error: new Error(readOnlyMessage()),
        });
      }
      recover();                // the storage that refused may take one now
      const block = (started && settled) ? mirrorBlock() : null;
      if (block) {
        // We own the account but the mirror is holding something we cannot
        // read or cannot prune. Either way there is older intent on disk that
        // will be sent AFTER this write and overwrite it, so taking it would
        // be accepting a decision we know is going to be undone. Refused, in
        // its own words, with the edit rolled back — the same contract as a
        // read-only tab, for a different reason.
        return Promise.resolve({
          ok: false, permanent: false, deferred: false, readOnly: true, lost: false,
          error: new Error(mirrorMessage(block)),
        });
      }
      const gid = `${sid}-${++seq}`;
      const group = ops.map((o, i) => ({
        id: `${gid}.${i}`, gid, op: o.op, key: o.key, args: o.args, attempts: 0,
      }));
      for (const o of group) supersede(o);
      pending.push(...group);
      persist();
      notify();
      const p = new Promise(resolve => groups.set(gid, { left: group.length, resolve }));
      flush();
      return p;
    }

    // Returns the in-flight drain when one is already running, so `await
    // flush()` means "the outbox is empty", not "someone else is draining it".
    // `active` is cleared inside drain's `finally`, i.e. synchronously with the
    // loop exiting — clearing it in a `.then` instead would let a submit that
    // lands in the same tick see a stale drain and never be sent.
    function flush() {
      // A start() has been asked for but ownership is not decided yet. Whatever
      // was submitted in that window is dealt with the moment it is — carried
      // into the queue by claim(), or refused there.
      if (binding || (started && !settled)) return lifecycle.then(() => flush());
      if (!started || !writer) return drainPromise;
      // A key we can't read may hold writes queued before these. Sending
      // around a backlog we cannot see is how the newest decision ends up
      // underneath the oldest — nothing goes out until the key can be read.
      if (fault === "unreadable") return drainPromise;
      if (!active) {
        active = true;
        drainPromise = drain(generation);
      }
      return drainPromise;
    }

    async function drain(gen) {
      try {
        while (gen === generation && pending.length) {
          /* The gate the whole ordering guarantee hangs on. It is not enough
           * to refuse NEW edits while the mirror is untrustworthy: work
           * already accepted and queued is just as able to land on the server
           * ahead of the stale copy on disk and be undone by it at the next
           * sign-in. So the drain stops here — for queued, grouped, retried
           * and carried work alike — until storage takes the queue as it now
           * stands. */
          if (mirrorBlock()) {
            if (!(await repairMirror(gen))) return;   // paused, everything kept
            if (gen !== generation) return;
            continue;
          }
          const op = pending[0];
          const fn = transport[op.op];
          if (typeof fn !== "function") {
            op.error = `no transport for ${op.op}`;
            remove(op);
            failed.push(op);
            abandonGroup(op, new Error(op.error));
            persist(); notify();
            continue;
          }
          inflight = op;
          let failure = null;
          try {
            await fn(op.args);
          } catch (err) {
            failure = err || new Error("write failed");
          }
          /* The session can end while a request is on the wire. Everything
           * below mutates the LIVE queue and the CURRENTLY bound account's
           * key; this op belongs to neither. It was already mirrored under its
           * own account and its caller already told the truth ("kept until you
           * sign in again"), so the only correct thing left to do is nothing —
           * including leaving `active`/`inflight` alone, since they now belong
           * to whatever pass replaced this one. */
          if (gen !== generation) return;
          inflight = null;
          if (!failure) {
            remove(op);
            settle(op, null);
            persist(); notify();
            continue;
          }
          op.attempts += 1;
          const giveUp = classifyError(failure) === "permanent" || op.attempts >= maxAttempts;
          if (giveUp) {
            op.error = String((failure && failure.message) || failure);
            remove(op);
            failed.push(op);
            abandonGroup(op, failure);
            persist(); notify();
          } else {
            persist(); notify();
            await sleep(delayFor(op.attempts, failure));
            if (gen !== generation) return;   // signed out mid-backoff
          }
        }
      } finally {
        if (gen === generation) { active = false; inflight = null; }
      }
    }

    /* Put the dead-lettered ops back at the head of the queue — the "try
     * again" affordance behind the unsaved-writes indicator. Attempt counts
     * reset, because the user asking again is new information. They go in
     * AFTER the op being sent right now, which keeps that op's completion
     * (and its FIFO position) intact. */
    function retryFailed() {
      // Try again is the recovery affordance too: storage that refused the
      // prune (or the read) may take it now, and that is what lets a paused
      // queue move again without the user having to re-rate anything.
      recover();
      if (!failed.length) return flush();
      const revived = failed.map(o => ({ ...o, attempts: 0, error: undefined, blocked: false }));
      failed = [];
      const at = inflight ? pending.indexOf(inflight) + 1 : 0;
      pending = pending.slice(0, at).concat(revived, pending.slice(at));
      persist(); notify();
      return flush();
    }

    /* Forget the dead-lettered ops (the user accepted the loss). Pending ops
     * are untouched — this never throws away a write still being tried. */
    function discardFailed() {
      if (!failed.length) return;
      for (const o of failed) retire(o);
      failed = [];
      persist(); notify();
    }

    return { submit, start, stop, flush, state, retryFailed, discardFailed };
  }

  const API = { createWriteQueue, classifyError, STORAGE_KEY, LEGACY_KEY };
  global.WriteQueue = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
