/* Search the local catalog (data.json titles) by title name or by a person in
 * the credits. Static-site safe — no API key, no network. The page can later
 * swap in a TMDb-proxy searcher for titles outside your set.
 *
 * Global for classic <script> pages; CommonJS export for `node --test`.
 */
(function (global) {
  "use strict";

  // filters: { query, kind, status, yearMin, yearMax, role }. All optional.
  // With no query and no narrowing filters, returns []. Otherwise returns the
  // titles passing every active filter, name-matches first then most recent.
  function searchCatalog(titles, filters) {
    filters = filters || {};
    const q = (filters.query || "").trim().toLowerCase();
    const hasNarrowing = q || filters.kind || filters.status ||
      filters.yearMin != null || filters.yearMax != null || filters.role ||
      filters.genre || filters.tone || filters.theme || filters.narrative ||
      filters.ratingMin != null || filters.ratingMax != null ||
      (filters.people && filters.people.length);
    if (!hasNarrowing) return [];

    const results = [];
    for (const t of titles) {
      if (filters.kind && t.kind !== filters.kind) continue;
      if (filters.status && (t.status || "ok") !== filters.status) continue;
      if (filters.yearMin != null && !(t.year >= filters.yearMin)) continue;
      if (filters.yearMax != null && !(t.year <= filters.yearMax)) continue;
      if (filters.role && !(t.people || []).some(p => p.role === filters.role)) continue;
      if (filters.people && filters.people.length &&
          !filters.people.every(n => (t.people || []).some(p => p.name === n))) continue;
      if (filters.genre && !(t.genres || []).includes(filters.genre)) continue;
      if (filters.tone && !(t.tone_tags || []).includes(filters.tone)) continue;
      if (filters.theme && !(t.themes || []).includes(filters.theme)) continue;
      if (filters.narrative && !(t.narratives || []).includes(filters.narrative)) continue;
      if ((filters.ratingMin != null || filters.ratingMax != null) && t.imdb_rating == null) continue;
      if (filters.ratingMin != null && t.imdb_rating < filters.ratingMin) continue;
      if (filters.ratingMax != null && t.imdb_rating > filters.ratingMax) continue;

      let nameMatch = true;
      let matchedPeople = [];
      if (q) {
        nameMatch = (t.name || "").toLowerCase().includes(q);
        matchedPeople = (t.people || [])
          .filter(p => (p.name || "").toLowerCase().includes(q))
          .map(p => p.name);
        if (!nameMatch && matchedPeople.length === 0) continue;
      } else {
        nameMatch = false;  // filter-only result, no text to "name match"
      }
      results.push({ title: t, matchedPeople, matchedByName: nameMatch });
    }
    results.sort((a, b) => {
      if (a.matchedByName !== b.matchedByName) return a.matchedByName ? -1 : 1;
      return (b.title.year || 0) - (a.title.year || 0);
    });
    return results;
  }

  global.searchCatalog = searchCatalog;

  /* ====== Page wiring (browser only) ====== */
  const STATUS_CHOICES = [
    ["loved", "Loved"], ["liked", "Liked"], ["ok", "Seen"],
    ["started", "Started"], ["disliked", "Disliked"], ["hated", "Hated"],
  ];

  function statusBadge(t) {
    if (!t.seen) return '<span class="s-badge s-unseen">Not in your set</span>';
    const s = t.status || "ok";
    return `<span class="s-badge s-${s}">${global.titleCase(s)}</span>`;
  }

  function statusActions(t) {
    return `<div class="status-actions" data-tmdb="${t.tmdb_id}" data-kind="${global.escapeHtml(t.kind)}">` +
      `<span class="status-actions-label">Rate:</span>` +
      STATUS_CHOICES.map(([s, label]) =>
        `<button class="status-btn status-${s}" data-status="${s}">${label}</button>`).join("") +
      `</div>`;
  }

  function highlight(name, q) {
    const esc = global.escapeHtml ? global.escapeHtml(name) : name;
    if (!q) return esc;
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc;
    const escPart = s => (global.escapeHtml ? global.escapeHtml(s) : s);
    return escPart(name.slice(0, i)) + "<mark>" +
      escPart(name.slice(i, i + q.length)) + "</mark>" + escPart(name.slice(i + q.length));
  }

  function renderResults(container, results, query, active) {
    container.innerHTML = "";
    if (results.length === 0) {
      container.innerHTML = active
        ? '<p class="search-hint">No titles match these filters.</p>'
        : '<p class="search-hint">Search your catalogue by title or by anyone in the credits — or pick filters on the left.</p>';
      return;
    }
    const fmtYear = global.formatYear || (y => (y ? ` (${y})` : ""));
    for (const r of results) {
      const t = r.title;
      const matched = new Set(r.matchedPeople);
      const people = (t.people || [])
        .map(p => {
          const hit = matched.has(p.name) ? " hit" : "";
          return `<span class="cred${hit}">${global.escapeHtml(p.name)} ` +
            `<em>${global.titleCase(p.role)}</em></span>`;
        }).join("");
      const card = document.createElement("article");
      card.className = "search-result";
      card.innerHTML =
        `<h3>${highlight(t.name, query)}${fmtYear(t.year)}` +
        `<span class="kind">${global.titleCase(t.kind)}</span>${statusBadge(t)}</h3>` +
        `<div class="creds">${people}</div>` +
        statusActions(t);
      container.appendChild(card);
    }
  }

  function optionEl(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function fillSelect(id, values) {
    const sel = document.getElementById(id);
    for (const v of values) sel.appendChild(optionEl(v, v));
  }

  function populateOptions(titles, narrativesMeta) {
    const statuses = new Set(), roles = new Set(), genres = new Set();
    const tones = new Set(), themes = new Set();
    const personCount = new Map();
    for (const t of titles) {
      if (t.status) statuses.add(t.status);
      for (const p of (t.people || [])) {
        roles.add(p.role);
        personCount.set(p.name, (personCount.get(p.name) || 0) + 1);
      }
      for (const g of (t.genres || [])) genres.add(g);
      for (const tg of (t.tone_tags || [])) tones.add(tg);
      for (const th of (t.themes || [])) themes.add(th);
    }
    fillSelect("filter-status", [...statuses].sort());
    fillSelect("filter-role", [...roles].sort());
    fillSelect("filter-genre", [...genres].sort());
    fillSelect("filter-tone", [...tones].sort());
    fillSelect("filter-theme", [...themes].sort());
    // People who recur (2+ titles) keep the list usable.
    const people = [...personCount.entries()].filter(([, n]) => n >= 2).map(([name]) => name).sort();
    fillSelect("filter-people", people);
    // narratives: option value = id, label = human label
    const narrSel = document.getElementById("filter-narrative");
    for (const n of (narrativesMeta || []).slice().sort((a, b) => (a.label || "").localeCompare(b.label || ""))) {
      narrSel.appendChild(optionEl(n.id, n.label || n.id));
    }
  }

  function collectFilters() {
    const num = id => {
      const v = document.getElementById(id).value;
      return v === "" ? null : Number(v);
    };
    const val = id => document.getElementById(id).value || null;
    return {
      query: document.getElementById("search-input").value,
      kind: val("filter-kind"),
      status: val("filter-status"),
      role: val("filter-role"),
      genre: val("filter-genre"),
      tone: val("filter-tone"),
      theme: val("filter-theme"),
      narrative: val("filter-narrative"),
      yearMin: num("filter-year-min"),
      yearMax: num("filter-year-max"),
      ratingMin: num("filter-rating-min"),
      ratingMax: num("filter-rating-max"),
      people: [...document.getElementById("filter-people").selectedOptions].map(o => o.value),
    };
  }

  function renderUniverse(container, results, active, hasMore) {
    container.innerHTML = "";
    if (results.length === 0) {
      container.innerHTML = active
        ? '<p class="search-hint">No matches on this page' + (hasMore ? ' — try Load more.' : '. Loosen the filters.') + '</p>'
        : '<p class="search-hint">Search the whole TMDb universe by title or person — or pick a Kind (+ filters) to browse.</p>';
      if (active && hasMore) {
        const more = document.createElement("button");
        more.id = "uni-more"; more.className = "auth-btn uni-more"; more.textContent = "Load more";
        container.appendChild(more);
      }
      return;
    }
    const fmtYear = global.formatYear || (y => (y ? ` (${y})` : ""));
    for (const r of results) {
      const badge = r.inSet
        ? '<span class="s-badge s-liked">In your set</span>'
        : '<span class="s-badge s-unseen">New</span>';
      const via = r.via && r.via.length
        ? `<div class="creds"><span class="cred hit">via ${global.escapeHtml(r.via.join(", "))}</span></div>` : "";
      const overview = r.overview
        ? `<p class="uni-overview">${global.escapeHtml(r.overview.slice(0, 240))}${r.overview.length > 240 ? "…" : ""}</p>` : "";
      const add = r.inSet ? "" :
        `<div class="status-actions"><button class="queue-btn" data-tmdb="${r.tmdb_id}" ` +
        `data-kind="${global.escapeHtml(r.kind)}" data-name="${global.escapeHtml(r.name)}">+ Add to brain</button></div>`;
      const card = document.createElement("article");
      card.className = "search-result";
      card.innerHTML =
        `<h3>${global.escapeHtml(r.name)}${fmtYear(r.year)}` +
        `<span class="kind">${global.titleCase(r.kind)}</span>${badge}</h3>${via}${overview}${add}`;
      container.appendChild(card);
    }
    if (hasMore) {
      const more = document.createElement("button");
      more.id = "uni-more";
      more.className = "auth-btn uni-more";
      more.textContent = "Load more";
      container.appendChild(more);
    }
  }

  async function initSearchPage() {
    const input = document.getElementById("search-input");
    const out = document.getElementById("search-results");
    const count = document.getElementById("search-count");
    if (!input || !out) return;
    const FILTER_IDS = ["filter-kind", "filter-status", "filter-role", "filter-genre",
      "filter-tone", "filter-theme", "filter-narrative", "filter-year-min", "filter-year-max",
      "filter-rating-min", "filter-rating-max", "filter-people"];
    let titles = [];
    try {
      const r = await fetch("data.json");
      const data = await r.json();
      titles = data.titles || [];
      populateOptions(titles, data.narratives);
    } catch (e) {
      out.innerHTML = '<p class="search-hint">Could not load the catalogue.</p>';
      return;
    }

    let mode = "catalogue";
    const knownKeys = new Set(titles.map(t => `${t.tmdb_id}|${t.kind}`));
    let debounce = null;

    // Status editing (Supabase) — RAW_TITLES is the shipped catalogue;
    // `titles` is RAW merged with your stored statuses.
    const RAW_TITLES = titles;
    let statusMap = new Map();
    let loggedIn = false;

    const runCatalogue = () => {
      const filters = collectFilters();
      const results = searchCatalog(titles, filters);
      const active = filters.query.trim() || FILTER_IDS.some(id => document.getElementById(id).value);
      count.textContent = active ? `${results.length} result${results.length === 1 ? "" : "s"}` : "";
      renderResults(out, results, filters.query, active);
    };

    // Universe pagination state.
    let uniResults = [], uniPage = 0, uniTotalPages = 0;

    const runUniverse = async (append) => {
      const q = input.value.trim();
      const kind = document.getElementById("filter-kind").value || null;
      // Need either text, or a Kind to browse (TMDb can't list "everything").
      if (!q && !kind) { count.textContent = ""; uniResults = []; renderUniverse(out, [], false); return; }
      const num = id => { const v = document.getElementById(id).value; return v === "" ? null : Number(v); };
      const genreName = document.getElementById("filter-genre").value || null;
      const filters = {
        yearMin: num("filter-year-min"), yearMax: num("filter-year-max"),
        ratingMin: num("filter-rating-min"), ratingMax: num("filter-rating-max"),
        genreIds: genreName ? await global.genreIdsFor(genreName) : [],
      };
      // Server-side /discover params (browse path) — TMDb filters before paging.
      const disc = {
        genreId: (genreName && kind) ? await global.genreIdFor(genreName, kind) : null,
        ratingMin: filters.ratingMin, ratingMax: filters.ratingMax,
        yearMin: filters.yearMin, yearMax: filters.yearMax,
      };
      const page = append ? uniPage + 1 : 1;
      count.textContent = "searching TMDb…";
      try {
        const res = await searchTmdb(q, knownKeys, { kind, page, filters, disc });
        uniResults = append ? uniResults.concat(res.results) : res.results;
        uniPage = res.page; uniTotalPages = res.totalPages;
        count.textContent = `${uniResults.length} shown${uniPage < uniTotalPages ? ` · page ${uniPage}/${uniTotalPages}` : ""}`;
        renderUniverse(out, uniResults, true, uniPage < uniTotalPages);
      } catch (e) {
        count.textContent = "";
        out.innerHTML = `<p class="search-hint">TMDb error: ${global.escapeHtml(e.message || String(e))}</p>`;
      }
    };

    const run = () => {
      if (mode === "universe") {
        clearTimeout(debounce);
        debounce = setTimeout(() => runUniverse(false), 350);  // fresh search, debounced
      } else {
        runCatalogue();
      }
    };

    async function refreshAuthUI() {
      const el = document.getElementById("auth");
      if (!el || !global.StatusStore) return;
      let user = null;
      try { user = await StatusStore.currentUser(); } catch (_) {}
      loggedIn = !!user;
      if (loggedIn) {
        el.innerHTML = `<span class="auth-who">${global.escapeHtml(user.email)}</span>` +
          `<button class="auth-btn" id="reconcile">Reconcile now</button>` +
          `<button class="auth-btn" id="logout">Log out</button>`;
        document.getElementById("logout").onclick = async () => {
          await StatusStore.signOut(); loggedIn = false; refreshAuthUI();
        };
        document.getElementById("reconcile").onclick = async (e) => {
          const b = e.target; b.disabled = true; b.textContent = "Reconciling…";
          try {
            await StatusStore.triggerReconcile();
            b.textContent = "Reconcile queued ✓";
          } catch (err) {
            b.disabled = false; b.textContent = "Reconcile now";
            alert("Could not start reconcile: " + (err.message || err));
          }
        };
      } else {
        el.innerHTML = `<button class="auth-btn" id="login">Log in to rate</button>`;
        document.getElementById("login").onclick = async () => {
          const email = prompt("Email for a one-time login link:");
          if (!email) return;
          try { await StatusStore.signIn(email.trim()); alert("Check your email for the login link."); }
          catch (e) { alert("Could not send login link: " + (e.message || e)); }
        };
      }
    }

    async function initStatuses() {
      if (!global.StatusStore || !global.SUPABASE_URL) return;
      try {
        const sb = StatusStore.init(global.SUPABASE_URL, global.SUPABASE_ANON_KEY);
        sb.auth.onAuthStateChange(() => { refreshAuthUI(); reloadStatuses(); });
        statusMap = await StatusStore.loadStatuses();
        titles = StatusStore.applyStatuses(RAW_TITLES, statusMap);
        knownKeys.clear();
        for (const t of titles) knownKeys.add(`${t.tmdb_id}|${t.kind}`);
      } catch (e) { console.warn("status load failed:", e); }
      await refreshAuthUI();
    }

    async function reloadStatuses() {
      try {
        statusMap = await StatusStore.loadStatuses();
        titles = StatusStore.applyStatuses(RAW_TITLES, statusMap);
        run();
      } catch (_) {}
    }

    async function markStatus(tmdbId, kind, status) {
      if (!loggedIn) { alert("Log in (top right) to save your ratings."); return; }
      statusMap.set(StatusStore.statusKey(tmdbId, kind), status);
      titles = StatusStore.applyStatuses(RAW_TITLES, statusMap);
      run();
      try { await StatusStore.setStatus(tmdbId, kind, status); }
      catch (e) { alert("Save failed: " + (e.message || e)); }
    }

    async function queueAdd(btn) {
      if (!loggedIn) { alert("Log in (top right) to add titles."); return; }
      btn.disabled = true;
      try {
        await StatusStore.queueAdd(Number(btn.dataset.tmdb), btn.dataset.kind, btn.dataset.name);
        btn.textContent = "Queued ✓";
      } catch (e) {
        btn.disabled = false;
        alert("Could not queue: " + (e.message || e));
      }
    }

    out.addEventListener("click", e => {
      const statusBtn = e.target.closest(".status-btn");
      if (statusBtn) {
        const wrap = statusBtn.closest(".status-actions");
        markStatus(Number(wrap.dataset.tmdb), wrap.dataset.kind, statusBtn.dataset.status);
        return;
      }
      const qBtn = e.target.closest(".queue-btn");
      if (qBtn) { queueAdd(qBtn); return; }
      if (e.target.closest("#uni-more")) runUniverse(true);
    });

    // Universe hides the catalogue-only filters (.cat-only) via CSS; only
    // Kind / Year / Genre / Rating remain, which TMDb can honour.
    function applyModeToFilters() {
      document.getElementById("search-filters").classList.toggle("universe", mode === "universe");
    }

    document.querySelectorAll("#search-mode .mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#search-mode .mode-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        mode = btn.dataset.mode;
        applyModeToFilters();
        run();
      });
    });

    [input, ...FILTER_IDS.map(id => document.getElementById(id))].forEach(el => {
      el.addEventListener("input", run);
      el.addEventListener("change", run);
    });
    document.getElementById("filter-reset").addEventListener("click", () => {
      FILTER_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el.multiple) [...el.options].forEach(o => { o.selected = false; });
        else el.value = "";
      });
      input.value = "";
      run();
    });

    await initStatuses();   // merge stored statuses, set up the auth bar
    run();
    input.focus();
  }

  if (global.document) {
    global.document.addEventListener("DOMContentLoaded", () => {
      if (global.document.getElementById("search-input")) initSearchPage();
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { searchCatalog };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
