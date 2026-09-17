/* Confirm-queue — the "Have you seen this?" surface.
 *
 * Proactively surfaces titles you've PROBABLY seen and lets you confirm each
 * with one tap (loved..hated) or skip ("haven't seen"). Several sources feed
 * one shared renderer:
 *   · Suggested   — discovery.json unseen pool, ranked by p_seen (offline).
 *   · By creator  — filmography of auteurs you already follow (live TMDb).
 *   · Because…    — /recommendations neighbours of your favourites (neighbors.json).
 *   · Discover    — stratified cross-genre probes (probes.json).
 *   · Import      — drop an IMDb / Letterboxd export (import.js).
 *
 * A confirmation writes BOTH queue (so the title enters brain.db) and status
 * (so the reconcile bake marks it seen). Live Supabase statuses + skips overlay
 * client-side so a handled card leaves the deck immediately.
 */
(function () {
  "use strict";

  const STATUS_CHOICES = [
    ["loved", "Loved"], ["liked", "Liked"], ["ok", "Seen"],
    ["started", "Started"], ["disliked", "Disliked"], ["hated", "Hated"],
  ];
  const STRONG_ROLES = new Set(["creator", "showrunner", "writer", "director"]);
  const key = (id, kind) => `${id}|${kind}`;

  const state = {
    titles: [],           // data.json titles merged with live statuses
    knownKeys: new Set(),  // everything already in brain.db (seen + candidates)
    seenKeys: new Set(),   // already marked seen — an import must not overwrite these
    handled: new Set(),    // keys to hide: server statuses + skips + this session's actions
    sessionHandled: new Set(), // this session's confirms/skips — survives overlay reloads
    loggedIn: false,
    activeTab: "suggested",
    cache: {},             // tab id -> rendered card list (lazy)
  };

  // The durable outbox every confirm / skip / queue-add goes through
  // (web/write-queue.js). Null until Supabase init succeeds.
  let writes = null;

  async function init() {
    try {
      const r = await fetch("data.json");
      const data = await r.json();
      state.titles = data.titles || [];
    } catch (_) { state.titles = []; }
    for (const t of state.titles) {
      state.knownKeys.add(key(t.tmdb_id, t.kind));
      if (t.seen) state.seenKeys.add(key(t.tmdb_id, t.kind));
    }

    await initStatuses();
    bindTabs();
    document.getElementById("confirm-deck").addEventListener("click", onDeckClick);
    showTab("suggested");
  }

  /* ---- Supabase status + skip overlay ---- */
  async function initStatuses() {
    if (!window.StatusStore || !window.SUPABASE_URL) return;
    try {
      const sb = StatusStore.init(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      writes = WriteQueue.createWriteQueue({
        transport: StatusStore.writeTransport(),
        onChange: st => renderOutbox(document.getElementById("outbox"), st, writes),
      });
      sb.auth.onAuthStateChange(() => { refreshAuthUI(); reloadOverlay(); });
      await reloadOverlay();
    } catch (e) { console.warn("status init failed:", e); }
    await refreshAuthUI();
  }

  async function reloadOverlay() {
    try {
      const [statusMap, skips] = await Promise.all([
        StatusStore.loadStatuses(), StatusStore.loadSkips(),
      ]);
      state.handled = new Set();
      for (const k of statusMap.keys()) {
        state.handled.add(k);
        // A live Supabase status means the title IS seen/rated, even if the
        // baked data.json doesn't know yet — without this, a bare paste line
        // could downgrade a rating made on-site since the last nightly bake.
        state.seenKeys.add(k);
      }
      for (const k of skips) state.handled.add(k);
      // Keep this session's confirms/skips — a silent TOKEN_REFRESHED auth event
      // must not resurface cards the user already handled (esp. skips, which may
      // only live client-side before the not_seen migration lands).
      for (const k of state.sessionHandled) state.handled.add(k);
      state.cache = {};
      if (state.activeTab !== "import") showTab(state.activeTab);
    } catch (_) {}
  }

  async function refreshAuthUI() {
    const el = document.getElementById("auth");
    if (!el || !window.StatusStore) return;
    let user = null;
    try { user = await StatusStore.currentUser(); } catch (_) {}
    state.loggedIn = !!user;
    // Only drain the outbox once there's a session — a write replayed at a
    // logged-out client is refused and dead-lettered for nothing, and one
    // replayed under another account would write their ratings into this one.
    // ...and stop it on sign-out, so no completion from the ended session
    // can reach the next account's outbox. See app.js for the long note.
    if (writes) { if (state.loggedIn) writes.start(user.id); else writes.stop(); }
    if (state.loggedIn) {
      el.innerHTML = `<span class="auth-who">${escapeHtml(user.email)}</span>` +
        `<button class="auth-btn" id="reconcile">Reconcile now</button>` +
        `<button class="auth-btn" id="logout">Log out</button>`;
      document.getElementById("logout").onclick = async () => {
        await StatusStore.signOut(); state.loggedIn = false; refreshAuthUI();
      };
      document.getElementById("reconcile").onclick = async (e) => {
        const b = e.target; b.disabled = true; b.textContent = "Reconciling…";
        try { await StatusStore.triggerReconcile(); b.textContent = "Reconcile queued ✓"; }
        catch (err) { b.disabled = false; b.textContent = "Reconcile now"; alert("Could not start reconcile: " + (err.message || err)); }
      };
    } else {
      el.innerHTML = `<button class="auth-btn" id="login">Log in to confirm</button>`;
      document.getElementById("login").onclick = async () => {
        const email = prompt("Email for a one-time login link:");
        if (!email) return;
        try { await StatusStore.signIn(email.trim()); alert("Check your email for the login link."); }
        catch (e) { alert("Could not send login link: " + (e.message || e)); }
      };
    }
  }

  /* ---- Tabs ---- */
  function bindTabs() {
    document.querySelectorAll("#confirm-tabs .mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#confirm-tabs .mode-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        showTab(btn.dataset.tab);
      });
    });
  }

  const SOURCES = {
    suggested: loadSuggested,
    creator: loadCreator,
    franchise: loadFranchise,
    watched: () => loadJsonSource("neighbors.json", "Because you watched", n => n.items || []),
    discover: () => loadJsonSource("probes.json", "Discover", n => n.items || []),
    canon: () => loadJsonSource("lists.json", "Canon", n => n.items || []),
    rate: loadRate,
  };

  // Tabs whose cards are the user's OWN already-seen titles: they carry an 'ok'
  // status (so they're in `handled`) but re-rating them is the entire point, so
  // they're filtered only by this session's actions, not the server overlay.
  const OWN_TABS = new Set(["rate"]);

  async function showTab(tab) {
    state.activeTab = tab;
    const deck = document.getElementById("confirm-deck");
    const importPanel = document.getElementById("import-panel");
    const pastePanel = document.getElementById("paste-panel");
    deck.hidden = true; importPanel.hidden = true; pastePanel.hidden = true;
    if (tab === "import") {
      importPanel.hidden = false;
      if (!importPanel.dataset.mounted) {
        window.Import.init(importPanel, {
          knownKeys: state.knownKeys,
          seenKeys: state.seenKeys,
          isLoggedIn: () => state.loggedIn,
          onImported: (k) => state.handled.add(k),
        });
        importPanel.dataset.mounted = "1";
      }
      return;
    }
    if (tab === "paste") {
      pastePanel.hidden = false;
      if (!pastePanel.dataset.mounted) { mountPaste(pastePanel); pastePanel.dataset.mounted = "1"; }
      return;
    }
    deck.hidden = false;
    deck.innerHTML = '<p class="search-hint">Loading…</p>';
    let cards;
    // Two guards for slow sources (Franchises fires up to 15 live TMDb calls):
    // an in-flight promise so a double-click can't launch a second run, and a
    // post-await tab check so a source that resolves late can't paint its
    // cards under a different, already-selected tab.
    try {
      if (state.cache[tab]) {
        cards = state.cache[tab];
      } else {
        state.inflight = state.inflight || {};
        if (!state.inflight[tab]) state.inflight[tab] = SOURCES[tab]();
        cards = await state.inflight[tab];
        delete state.inflight[tab];
        state.cache[tab] = cards;
      }
    } catch (e) {
      if (state.inflight) delete state.inflight[tab];
      if (state.activeTab !== tab) return;
      deck.innerHTML = `<p class="search-hint">Could not load this source: ${escapeHtml(e.message || String(e))}</p>`;
      return;
    }
    if (state.activeTab !== tab) return;   // the user moved on while we waited
    const hide = OWN_TABS.has(tab) ? state.sessionHandled : state.handled;
    renderDeck(cards.filter(c => !hide.has(key(c.tmdb_id, c.kind))));
  }

  /* ---- Sources ---- */
  // Discovery p_seen queue — zero live calls; ranked offline in export_discovery.
  async function loadSuggested() {
    // Prefer the slim, pre-ranked suggested.json (~20 KB, unseen-only); fall
    // back to the full discovery.json for older deploys that don't ship it.
    let works = [];
    try {
      const r = await fetch("suggested.json");
      if (!r.ok) throw new Error("no slim file");
      works = (await r.json()).works || [];
    } catch (_) {
      try {
        const r = await fetch("discovery.json");
        works = ((await r.json()).works || []).filter(w => w.status === "unseen");
      } catch (_2) { return []; }
    }
    return works
      .filter(w => !state.knownKeys.has(key(w.tmdb_id, w.kind)))
      .sort((a, b) => (b.p_seen || 0) - (a.p_seen || 0))
      .slice(0, 80)
      .map(w => ({
        tmdb_id: w.tmdb_id, kind: w.kind, name: w.name, year: w.year,
        sub: `likely-seen ${Number(w.p_seen || 0).toFixed(1)}` +
          (w.p_seen_via ? ` · via ${w.p_seen_via}` : "") +
          (w.vote_average ? ` · TMDb ${Number(w.vote_average).toFixed(1)}` : ""),
      }));
  }

  // Auteur completion — the filmography of creators you already follow (>=3
  // seen titles in a strong role). One live combined_credits call per creator.
  async function loadCreator() {
    const seen = state.titles.filter(t => t.seen);
    const byPerson = new Map();
    for (const t of seen) {
      const strong = new Set();
      for (const p of (t.people || [])) if (STRONG_ROLES.has(p.role)) strong.add(p.id);
      for (const id of strong) {
        const e = byPerson.get(id) || { id, name: null, role: null, count: 0 };
        e.count++;
        const p = (t.people || []).find(x => x.id === id && STRONG_ROLES.has(x.role));
        if (p) { e.name = p.name; e.role = p.role; }
        byPerson.set(id, e);
      }
    }
    const auteurs = [...byPerson.values()].filter(e => e.count >= 3)
      .sort((a, b) => b.count - a.count).slice(0, 8);

    const cards = [];
    // Deduped across ALL auteurs, not per-auteur: a title two followed
    // creators share (the Coens, a writer/director pair) used to render twice,
    // and rating one left the twin on screen writing a redundant upsert.
    const emitted = new Set();
    for (const a of auteurs) {
      let credits;
      try { credits = await window.fetchCombinedCredits(a.id); }
      catch (_) { continue; }
      const all = [...(credits.cast || []), ...(credits.crew || [])];
      const byId = new Map();
      for (const c of all) {
        const kind = c.media_type === "tv" ? "tv" : c.media_type === "movie" ? "movie" : null;
        if (!kind) continue;
        if ((c.vote_count || 0) < 200) continue;
        const k = key(c.id, kind);
        if (state.knownKeys.has(k) || byId.has(k) || emitted.has(k)) continue;
        byId.set(k, {
          tmdb_id: c.id, kind, name: c.name || c.title || "?",
          year: Number((c.first_air_date || c.release_date || "").slice(0, 4)) || null,
          sub: `${a.name} (${a.role} you follow) · TMDb ${(c.vote_average || 0).toFixed(1)}`,
          _pop: c.popularity || 0,
        });
      }
      const picked = [...byId.values()].sort((x, y) => y._pop - x._pop).slice(0, 15);
      for (const c of picked) emitted.add(key(c.tmdb_id, c.kind));
      cards.push(...picked);
    }
    return cards;
  }

  // "Rate seen" — your own watched titles that never got a real reaction
  // ('ok' shrugs and 'started'). Re-rating these harvests the graded and
  // negative signal the taste profile is starved of (the multiplier scale runs
  // on 2 of its 6 values today). Most-recent-ish first by tmdb_id as a proxy.
  async function loadRate() {
    return state.titles
      .filter(t => t.seen && (t.status === "ok" || t.status === "started"))
      .sort((a, b) => (b.tmdb_id || 0) - (a.tmdb_id || 0))
      .slice(0, 80)
      .map(t => ({
        tmdb_id: t.tmdb_id, kind: t.kind, name: t.name, year: t.year,
        sub: `you marked this “${t.status === "started" ? "Started" : "Seen"}” — how was it?`,
      }));
  }

  // Franchise completion — for each franchise you've partly seen, TMDb's
  // collection members that aren't in your brain yet. The highest-precision
  // "seen the rest?" source: franchise membership is near-certain behaviour.
  // One live /collection call per partly-seen franchise.
  async function loadFranchise() {
    const byCollection = new Map();
    for (const t of state.titles) {
      if (t.seen && t.kind === "movie" && t.collection_id) {
        const e = byCollection.get(t.collection_id) ||
          { id: t.collection_id, name: t.collection_name, seen: 0 };
        e.seen++;
        byCollection.set(t.collection_id, e);
      }
    }
    // Strongest signal first (most already seen); cap live calls.
    const collections = [...byCollection.values()]
      .sort((a, b) => b.seen - a.seen).slice(0, 15);

    const cards = [];
    for (const col of collections) {
      let data;
      try { data = await window.fetchCollection(col.id); }
      catch (_) { continue; }
      const parts = data.parts || [];
      for (const p of parts) {
        const k = key(p.id, "movie");
        if (state.knownKeys.has(k)) continue;   // already in brain (seen or candidate)
        cards.push({
          tmdb_id: p.id, kind: "movie", name: p.title || p.name || "?",
          year: Number((p.release_date || "").slice(0, 4)) || null,
          sub: `${col.name} — you've seen ${col.seen} of ${parts.length}`,
          _pop: p.popularity || 0,
        });
      }
    }
    return cards.sort((a, b) => b._pop - a._pop);
  }

  /* ---- Quick add + Paste: two ways to populate fast ---- */
  function mountPaste(panel) {
    panel.innerHTML =
      '<h3 class="paste-h">Quick add</h3>' +
      '<p class="search-hint">Type a title and tap a rating — no need to leave this page.</p>' +
      '<input id="quick-search" class="paste-input" autocomplete="off" ' +
      'placeholder="e.g. The Matrix">' +
      '<div id="quick-results"></div>' +
      '<h3 class="paste-h">Paste a list</h3>' +
      '<p class="search-hint">One title per line. Bare titles are marked seen (titles ' +
      'you already rated are left alone); add a rating with <code>Title | loved</code>, ' +
      'or a year: <code>Dune (2021)</code>.</p>' +
      '<textarea id="paste-input" rows="8" class="paste-input" ' +
      'placeholder="The Matrix&#10;Oppenheimer | loved&#10;Heat - liked&#10;Dune (2021)"></textarea>' +
      '<div><button id="paste-go" class="auth-btn">Add these</button></div>' +
      '<p id="paste-log" class="search-hint"></p>';
    const goBtn = panel.querySelector("#paste-go");
    goBtn.addEventListener("click", async () => {
      // Guard re-entry: a second click used to start a second loop over the
      // same entries — two interleaved pacers, duplicate TMDb calls, and a
      // progress line flickering between two counters.
      if (goBtn.disabled) return;
      goBtn.disabled = true;
      const original = goBtn.textContent;
      goBtn.textContent = "Adding…";
      try {
        await runPaste(panel.querySelector("#paste-input").value,
                       panel.querySelector("#paste-log"));
      } finally {
        goBtn.disabled = false;
        goBtn.textContent = original;
      }
    });

    const qs = panel.querySelector("#quick-search");
    const qr = panel.querySelector("#quick-results");
    let timer = null;
    qs.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => quickSearch(qs.value, qr), 300);  // debounce
    });
    qr.addEventListener("click", onDeckClick);  // reuse the deck's rate/skip handler
  }

  // Monotonic token: only the newest quick-search may paint. Debouncing alone
  // coalesces keystrokes but doesn't order the requests that DO fire — a slow
  // "the" could land after "the matrix" and overwrite it.
  let quickSearchSeq = 0;

  async function quickSearch(q, container) {
    q = (q || "").trim();
    const mySeq = ++quickSearchSeq;
    if (q.length < 2) { container.innerHTML = ""; return; }
    let results = [];
    try { results = (await window.searchTmdb(q)).results || []; } catch (_) {}
    if (mySeq !== quickSearchSeq) return;   // a newer search superseded us
    container.innerHTML = "";
    if (!results.length) { container.innerHTML = '<p class="search-hint">No matches.</p>'; return; }
    for (const r of results.slice(0, 6)) {
      const already = state.knownKeys.has(key(r.tmdb_id, r.kind));
      const card = confirmCardEl({
        tmdb_id: r.tmdb_id, kind: r.kind, name: r.name, year: r.year,
        sub: already ? "already in your brain — re-rate" : "",
      });
      container.appendChild(card);
    }
  }

  async function runPaste(text, log) {
    if (!state.loggedIn) { alert("Log in (top right) to add titles."); return; }
    const entries = window.parsePaste(text);
    if (!entries.length) { log.textContent = "Nothing to add."; return; }
    // The decide-and-write core lives in paste.js (resolvePaste, unit-tested):
    // seen-clobber guard, person-expansion filter, provenance. This is glue.
    const counts = await window.resolvePaste(entries, {
      search: q => window.searchTmdb(q),
      knownKeys: state.knownKeys,
      seenKeys: state.seenKeys,
      queueAdd: (id, kind, name) => StatusStore.queueAdd(id, kind, name),
      setStatus: (id, kind, status, source) => StatusStore.setStatus(id, kind, status, source),
      importSource: window.importSource,
      onWrite: hit => {
        const k = key(hit.tmdb_id, hit.kind);
        state.handled.add(k); state.sessionHandled.add(k);
      },
      onProgress: (done, total, c) => {
        log.textContent = `${done}/${total} · ${c.added} added · ${c.updated} updated · ` +
          `${c.skipped} already rated · ${c.unmatched} unmatched · ${c.failed} failed`;
      },
      pace: () => new Promise(r => setTimeout(r, 260)),  // ~4 req/s
    });
    log.textContent = `Done: ${counts.added} added, ${counts.updated} updated, ` +
      `${counts.skipped} already rated (skipped), ${counts.unmatched} unmatched, ` +
      `${counts.failed} failed. Run “Reconcile now” to bake them in.`;
  }

  // Generic loader for a prebuilt json source (neighbors.json / probes.json).
  async function loadJsonSource(file, label, pick) {
    let payload;
    try {
      const r = await fetch(file);
      if (!r.ok) throw new Error("not built yet");
      payload = await r.json();
    } catch (_) {
      throw new Error(`${label} isn't built yet — run its build script and commit the JSON.`);
    }
    return pick(payload)
      .filter(w => !state.knownKeys.has(key(w.tmdb_id, w.kind)))
      .map(w => ({
        tmdb_id: w.tmdb_id, kind: w.kind, name: w.name, year: w.year,
        sub: w.reason || w.sub || "",
      }));
  }

  /* ---- Deck render + actions ---- */
  // One confirm card with status + skip buttons. Shared by the deck and the
  // quick-add search so both render identically and the same click handler
  // (onDeckClick) rates them.
  function confirmCardEl(c) {
    const fmtYear = window.formatYear || (y => (y ? ` (${y})` : ""));
    const card = document.createElement("article");
    card.className = "search-result confirm-card";
    card.dataset.name = c.name;
    card.innerHTML =
      `<h3>${escapeHtml(c.name)}${fmtYear(c.year)}<span class="kind">${escapeHtml(window.titleCase(c.kind))}</span></h3>` +
      (c.sub ? `<div class="confirm-sub">${escapeHtml(c.sub)}</div>` : "") +
      `<div class="status-actions" data-tmdb="${c.tmdb_id}" data-kind="${escapeHtml(c.kind)}" data-name="${escapeHtml(c.name)}">` +
      `<span class="status-actions-label">Seen it?</span>` +
      STATUS_CHOICES.map(([s, label]) =>
        `<button class="status-btn status-${s}" data-status="${s}">${label}</button>`).join("") +
      `<button class="status-btn skip-btn" data-skip="1">Haven't seen</button>` +
      `</div>`;
    return card;
  }

  function renderDeck(cards) {
    const deck = document.getElementById("confirm-deck");
    const count = document.getElementById("confirm-count");
    if (!cards.length) {
      count.textContent = "";
      deck.innerHTML = '<p class="search-hint">Nothing left to confirm here — try another tab.</p>';
      return;
    }
    count.textContent = `${cards.length} to review`;
    deck.innerHTML = "";
    for (const c of cards) {
      deck.appendChild(confirmCardEl(c));
    }
  }

  function onDeckClick(e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    const wrap = btn.closest(".status-actions");
    if (!wrap) return;
    const tmdbId = Number(wrap.dataset.tmdb);
    const kind = wrap.dataset.kind;
    const name = wrap.dataset.name;
    if (btn.dataset.skip) skip(tmdbId, kind, wrap);
    else confirmSeen(tmdbId, kind, name, btn.dataset.status, wrap);
  }

  // The decisions themselves live in web/confirm-actions.js (ordering,
  // rollback, reporting); this supplies the DOM half. `wrap` is captured so
  // the right card disappears even if the deck re-renders underneath.
  function actionDeps(wrap) {
    return {
      isLoggedIn: () => state.loggedIn,
      submit: ops => (writes
        ? writes.submit(ops)
        : Promise.resolve({ ok: false, permanent: true, error: new Error("not connected") })),
      markHandled: k => { markHandled(k); dropCard(wrap); },
      unmarkHandled: k => { state.handled.delete(k); state.sessionHandled.delete(k); },
      restore: () => showTab(state.activeTab),   // cards are cached — cheap re-render
      notify: msg => alert(msg),
    };
  }

  function confirmSeen(tmdbId, kind, name, status, wrap) {
    return ConfirmActions.confirmSeen(actionDeps(wrap), { tmdbId, kind, name, status });
  }

  function skip(tmdbId, kind, wrap) {
    return ConfirmActions.skipTitle(actionDeps(wrap), { tmdbId, kind });
  }

  function markHandled(k) {
    state.handled.add(k);
    state.sessionHandled.add(k);
  }

  function dropCard(wrap) {
    const card = wrap.closest(".confirm-card");
    if (card) card.remove();
    const count = document.getElementById("confirm-count");
    const remaining = document.querySelectorAll("#confirm-deck .confirm-card").length;
    count.textContent = remaining ? `${remaining} to review` : "";
    if (!remaining) {
      document.getElementById("confirm-deck").innerHTML =
        '<p class="search-hint">Nothing left to confirm here — try another tab.</p>';
    }
  }

  if (document.getElementById("confirm-deck")) init();
})();
