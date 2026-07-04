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
    knownKeys: new Set(),  // everything already in brain.db
    handled: new Set(),    // keys to hide: server statuses + skips + this session's actions
    sessionHandled: new Set(), // this session's confirms/skips — survives overlay reloads
    loggedIn: false,
    activeTab: "suggested",
    cache: {},             // tab id -> rendered card list (lazy)
  };

  async function init() {
    try {
      const r = await fetch("data.json", { cache: "no-store" });
      const data = await r.json();
      state.titles = data.titles || [];
    } catch (_) { state.titles = []; }
    for (const t of state.titles) state.knownKeys.add(key(t.tmdb_id, t.kind));

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
      for (const k of statusMap.keys()) state.handled.add(k);
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
    watched: () => loadJsonSource("neighbors.json", "Because you watched", n => n.items || []),
    discover: () => loadJsonSource("probes.json", "Discover", n => n.items || []),
  };

  async function showTab(tab) {
    state.activeTab = tab;
    const deck = document.getElementById("confirm-deck");
    const importPanel = document.getElementById("import-panel");
    if (tab === "import") {
      deck.hidden = true; importPanel.hidden = false;
      if (!importPanel.dataset.mounted) {
        window.Import.init(importPanel, {
          knownKeys: state.knownKeys,
          isLoggedIn: () => state.loggedIn,
          onImported: (k) => state.handled.add(k),
        });
        importPanel.dataset.mounted = "1";
      }
      return;
    }
    importPanel.hidden = true; deck.hidden = false;
    deck.innerHTML = '<p class="search-hint">Loading…</p>';
    let cards;
    try {
      cards = state.cache[tab] || (state.cache[tab] = await SOURCES[tab]());
    } catch (e) {
      deck.innerHTML = `<p class="search-hint">Could not load this source: ${escapeHtml(e.message || String(e))}</p>`;
      return;
    }
    renderDeck(cards.filter(c => !state.handled.has(key(c.tmdb_id, c.kind))));
  }

  /* ---- Sources ---- */
  // Discovery p_seen queue — zero live calls; ranked offline in export_discovery.
  async function loadSuggested() {
    let works = [];
    try {
      const r = await fetch("discovery.json", { cache: "no-store" });
      works = (await r.json()).works || [];
    } catch (_) { return []; }
    return works
      .filter(w => (w.status === "unseen") && !state.knownKeys.has(key(w.tmdb_id, w.kind)))
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
        if (state.knownKeys.has(k) || byId.has(k)) continue;
        byId.set(k, {
          tmdb_id: c.id, kind, name: c.name || c.title || "?",
          year: Number((c.first_air_date || c.release_date || "").slice(0, 4)) || null,
          sub: `${a.name} (${a.role} you follow) · TMDb ${(c.vote_average || 0).toFixed(1)}`,
          _pop: c.popularity || 0,
        });
      }
      cards.push(...[...byId.values()].sort((x, y) => y._pop - x._pop).slice(0, 15));
    }
    return cards;
  }

  // Generic loader for a prebuilt json source (neighbors.json / probes.json).
  async function loadJsonSource(file, label, pick) {
    let payload;
    try {
      const r = await fetch(file, { cache: "no-store" });
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
  function renderDeck(cards) {
    const deck = document.getElementById("confirm-deck");
    const count = document.getElementById("confirm-count");
    if (!cards.length) {
      count.textContent = "";
      deck.innerHTML = '<p class="search-hint">Nothing left to confirm here — try another tab.</p>';
      return;
    }
    count.textContent = `${cards.length} to review`;
    const fmtYear = window.formatYear || (y => (y ? ` (${y})` : ""));
    deck.innerHTML = "";
    for (const c of cards) {
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
      deck.appendChild(card);
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

  async function confirmSeen(tmdbId, kind, name, status, wrap) {
    if (!state.loggedIn) { alert("Log in (top right) to confirm."); return; }
    dropCard(tmdbId, kind, wrap);   // optimistic
    try {
      // Queue first (so ingest adds the row) THEN status (so sync marks it seen).
      await StatusStore.queueAdd(tmdbId, kind, name);
      await StatusStore.setStatus(tmdbId, kind, status);
    } catch (e) {
      // Roll the optimistic drop back so the card returns and can be retried.
      const k = key(tmdbId, kind);
      state.handled.delete(k);
      state.sessionHandled.delete(k);
      showTab(state.activeTab);   // cards are cached — cheap re-render
      alert("Save failed: " + (e.message || e));
    }
  }

  async function skip(tmdbId, kind, wrap) {
    if (!state.loggedIn) { alert("Log in (top right) to skip."); return; }
    dropCard(tmdbId, kind, wrap);
    try { await StatusStore.markSkipped(tmdbId, kind); }
    catch (e) { /* skip is best-effort */ }
  }

  function dropCard(tmdbId, kind, wrap) {
    const k = key(tmdbId, kind);
    state.handled.add(k);
    state.sessionHandled.add(k);
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
