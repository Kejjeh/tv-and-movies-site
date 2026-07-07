/* Ported from brain/scoring.py — keep in lockstep with the Python.
   The weights and role weights come from data.json so the source of
   truth stays in one place. */

const TONES = ["cerebral", "dystopian", "paranoid", "antihero", "animation-dark", "surreal"];

// Fallback only — the real values are shipped in data.json (single source of
// truth in brain/scoring.py) and read in load().
const STATUS_MULTIPLIER_FALLBACK = {
  loved:    4.0,
  liked:    1.5,
  ok:       1.0,
  started:  0.7,
  disliked: -0.3,
  hated:    -0.6,
};

// Fallback only — real values ship in data.json (brain/scoring.py).
const STATUS_AFFINITY_FALLBACK = {
  loved: 1.0, liked: 0.75, ok: 0.5, started: 0.4, disliked: 0.2, hated: 0.0,
};

let DATA = null;
let WEIGHTS = null;
let ROLE_WEIGHTS = null;
let STATUS_MULTIPLIER = null;
let STATUS_AFFINITY = null;

// Status editing (Supabase). RAW_TITLES is the shipped data.json titles;
// DATA.titles = applyStatuses(RAW_TITLES, STATUS_MAP) so edits re-merge cleanly.
let RAW_TITLES = [];
let STATUS_MAP = new Map();
let loggedIn = false;
// Buttons offered per card. "ok" reads as "seen" (watched, no strong reaction).
const STATUS_CHOICES = [
  ["loved", "loved"], ["liked", "liked"], ["ok", "seen"],
  ["started", "started"], ["disliked", "disliked"], ["hated", "hated"],
];

// Bundle the scoring parameters for scorer.js (see web/scorer.js).
function scoringParams() {
  return {
    weights: WEIGHTS,
    role_weights: ROLE_WEIGHTS,
    status_multipliers: STATUS_MULTIPLIER,
    narratives: DATA.narratives,
  };
}

const state = {
  mood: new Set(),
  themes: new Set(),
  themesExpanded: false,
  narratives: new Set(),
  minRating: 7.5,
  topN: 10,
  kind: "all",
  mode: "recs",       // "recs" | "anti" — anti flips sort to ascending (blind spots)
  lane: null,         // null | cluster_id
  laneMembers: null,  // Set of {tmdb_id, kind} keys belonging to selected lane (seen titles)
  lanePeople: null,   // Set of person ids covered by the selected lane
};

const THEMES_INITIAL = 30;

async function load() {
  const r = await fetch("data.json");
  DATA = await r.json();
  WEIGHTS = DATA.weights;
  ROLE_WEIGHTS = DATA.role_weights;
  STATUS_MULTIPLIER = DATA.status_multipliers || STATUS_MULTIPLIER_FALLBACK;
  STATUS_AFFINITY = DATA.status_affinity || STATUS_AFFINITY_FALLBACK;
  RAW_TITLES = DATA.titles;
  await initStatuses();   // merge stored statuses over the shipped titles
  buildLaneChips();
  buildMoodChips();
  buildThemeChips();
  buildNarrativeChips();
  buildKindChips();
  buildModeChips();
  bindControls();
  setSubtitle();
  setUpdated();
  document.getElementById("results").addEventListener("click", onStatusClick);
  document.getElementById("continue").addEventListener("click", onStatusClick);
  render();
}

/* ====== Status editing (Supabase) ====== */

async function initStatuses() {
  if (!window.StatusStore || !window.SUPABASE_URL) return;
  try {
    const sb = StatusStore.init(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    // Re-merge + refresh the auth bar whenever login state changes
    // (e.g. when the magic-link redirect lands).
    sb.auth.onAuthStateChange(() => { refreshAuthUI(); reloadStatuses(); });
    STATUS_MAP = await StatusStore.loadStatuses();
    DATA.titles = StatusStore.applyStatuses(RAW_TITLES, STATUS_MAP);
  } catch (e) {
    console.warn("status load failed:", e);
  }
  await refreshAuthUI();
}

async function reloadStatuses() {
  try {
    STATUS_MAP = await StatusStore.loadStatuses();
    DATA.titles = StatusStore.applyStatuses(RAW_TITLES, STATUS_MAP);
    render();
  } catch (_) {}
}

async function refreshAuthUI() {
  const el = document.getElementById("auth");
  if (!el || !window.StatusStore) return;
  let user = null;
  try { user = await StatusStore.currentUser(); } catch (_) {}
  loggedIn = !!user;
  if (loggedIn) {
    el.innerHTML = `<span class="auth-who">${escapeHtml(user.email)}</span>` +
      `<button class="auth-btn" id="logout">log out</button>`;
    document.getElementById("logout").onclick = async () => {
      await StatusStore.signOut();
      loggedIn = false;
      refreshAuthUI();
    };
  } else {
    el.innerHTML = `<button class="auth-btn" id="login">log in to edit</button>`;
    document.getElementById("login").onclick = async () => {
      const email = prompt("Email for a one-time login link:");
      if (!email) return;
      try {
        await StatusStore.signIn(email.trim());
        alert("Check your email for the login link, then come back.");
      } catch (e) {
        alert("Could not send login link: " + (e.message || e));
      }
    };
  }
}

async function markStatus(tmdbId, kind, status) {
  if (!loggedIn) {
    alert("Log in (top right) to save your ratings.");
    return;
  }
  STATUS_MAP.set(StatusStore.statusKey(tmdbId, kind), status);
  DATA.titles = StatusStore.applyStatuses(RAW_TITLES, STATUS_MAP);
  render();  // optimistic — the marked title leaves the candidate list
  try {
    await StatusStore.setStatus(tmdbId, kind, status);
  } catch (e) {
    alert("Save failed: " + (e.message || e));
  }
}

function onStatusClick(e) {
  const btn = e.target.closest(".status-btn");
  if (!btn) return;
  const wrap = btn.closest(".status-actions");
  markStatus(Number(wrap.dataset.tmdb), wrap.dataset.kind, btn.dataset.status);
}

function buildNarrativeChips() {
  const c = document.getElementById("narrative-chips");
  c.innerHTML = "";
  const all = DATA.narratives || [];
  // Sort by count desc but show all (it's a fixed-vocabulary list of ~40)
  const sorted = [...all].sort((a, b) => b.count - a.count);
  for (const n of sorted) {
    const b = document.createElement("button");
    b.className = "chip narrative-chip";
    if (state.narratives.has(n.id)) b.classList.add("active");
    b.innerHTML = `${escapeHtml(n.label)} <span class="narrative-size">${n.count}</span>`;
    b.title = n.description || "";
    b.onclick = () => {
      if (state.narratives.has(n.id)) {
        state.narratives.delete(n.id);
        b.classList.remove("active");
      } else {
        state.narratives.add(n.id);
        b.classList.add("active");
      }
      render();
    };
    c.appendChild(b);
  }
}

function buildThemeChips() {
  const c = document.getElementById("theme-chips");
  c.innerHTML = "";
  const all = DATA.themes || [];
  const visible = state.themesExpanded ? all : all.slice(0, THEMES_INITIAL);
  for (const th of visible) {
    const b = document.createElement("button");
    b.className = "chip theme-chip";
    if (state.themes.has(th.name)) b.classList.add("active");
    b.innerHTML = `${escapeHtml(th.name)} <span class="theme-size">${th.count}</span>`;
    b.onclick = () => {
      if (state.themes.has(th.name)) {
        state.themes.delete(th.name);
        b.classList.remove("active");
      } else {
        state.themes.add(th.name);
        b.classList.add("active");
      }
      render();
    };
    c.appendChild(b);
  }
  const toggle = document.getElementById("theme-toggle");
  if (toggle && all.length > THEMES_INITIAL) {
    toggle.textContent = state.themesExpanded
      ? "show top"
      : `show all (${all.length})`;
    toggle.style.cursor = "pointer";
    toggle.onclick = () => {
      state.themesExpanded = !state.themesExpanded;
      buildThemeChips();
    };
  }
}

function buildLaneChips() {
  const c = document.getElementById("lane-chips");
  c.innerHTML = "";
  // "all" first
  const all = document.createElement("button");
  all.className = "chip active";
  all.textContent = "all";
  all.onclick = () => selectLane(null, all);
  c.appendChild(all);

  // Sort clusters by size desc (data.json already orders them this way, but be defensive)
  const sorted = [...(DATA.clusters || [])].sort((a, b) => b.size - a.size);
  // Show only the top 12 lanes — beyond that it gets noisy
  for (const cl of sorted.slice(0, 12)) {
    const b = document.createElement("button");
    b.className = "chip lane-chip";
    const label = (cl.label || `cluster ${cl.cluster_id}`).split(/\s+/).slice(-2).join(" ");
    b.innerHTML = `${label} <span class="lane-size">${cl.size}</span>`;
    b.title = `${cl.label} · ${cl.size} titles · ${cl.dominant_tone}`;
    b.dataset.cid = String(cl.cluster_id);
    b.onclick = () => selectLane(cl.cluster_id, b);
    c.appendChild(b);
  }
}

function selectLane(cid, chip) {
  // Toggle
  if (state.lane === cid) {
    state.lane = null;
    state.laneMembers = null;
    state.lanePeople = null;
    document.querySelectorAll("#lane-chips .chip").forEach(x => x.classList.remove("active"));
    document.querySelector('#lane-chips .chip').classList.add("active"); // "all"
  } else {
    state.lane = cid;
    document.querySelectorAll("#lane-chips .chip").forEach(x => x.classList.remove("active"));
    chip.classList.add("active");
    if (cid === null) {
      state.laneMembers = null;
      state.lanePeople = null;
    } else {
      // Precompute member keys + people from this lane's seen titles
      state.laneMembers = new Set();
      state.lanePeople = new Set();
      for (const t of DATA.titles) {
        if (!t.seen) continue;
        if (t.cluster_id !== cid) continue;
        state.laneMembers.add(`${t.tmdb_id}|${t.kind}`);
        for (const p of t.people) state.lanePeople.add(p.id);
      }
    }
  }
  render();
}

function setSubtitle() {
  const seen = DATA.titles.filter(t => t.seen).length;
  const loved = DATA.titles.filter(t => t.loved).length;
  const cands = DATA.titles.filter(t => !t.seen).length;
  const base = `${seen} seen · ${loved} loved · ${cands} candidates`;
  const suffix = state.mode === "anti"
    ? " · showing candidates least like your seen-set"
    : "";
  document.getElementById("subtitle").textContent = base + suffix;
}

function setUpdated() {
  if (!DATA.generated_at) return;
  const d = new Date(DATA.generated_at);
  document.getElementById("updated").textContent =
    `data refreshed ${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function buildMoodChips() {
  const c = document.getElementById("mood-chips");
  for (const tone of TONES) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = tone;
    b.onclick = () => {
      if (state.mood.has(tone)) { state.mood.delete(tone); b.classList.remove("active"); }
      else { state.mood.add(tone); b.classList.add("active"); }
      render();
    };
    c.appendChild(b);
  }
}

function buildKindChips() {
  document.querySelectorAll("#kind-chips .chip").forEach(b => {
    b.onclick = () => {
      state.kind = b.dataset.kind;
      document.querySelectorAll("#kind-chips .chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      render();
    };
  });
}

function buildModeChips() {
  const c = document.getElementById("mode-chips");
  if (!c) return;
  c.innerHTML = "";
  const modes = [
    { id: "recs", label: "recs" },
    { id: "anti", label: "blind spots" },
  ];
  for (const m of modes) {
    const b = document.createElement("button");
    b.className = "chip";
    if (state.mode === m.id) b.classList.add("active");
    b.textContent = m.label;
    b.onclick = () => {
      if (state.mode === m.id) return;
      state.mode = m.id;
      document.querySelectorAll("#mode-chips .chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      setSubtitle();
      render();
    };
    c.appendChild(b);
  }
}

/* Anti-reasons: explain why a candidate scored LOW. Mirrors WEIGHTS so the
   parenthetical penalty equals the missing contribution (weight * (1 - dim)). */
function buildAntiReasons(rec) {
  const b = rec.breakdown;
  const reasons = [];
  const moodSelected = state.mood.size > 0;

  if (b.people_overlap === 0) {
    reasons.push(`(-${WEIGHTS.people_overlap.toFixed(3)}) No shared cast or crew with your seen set`);
  } else if (b.people_overlap < 0.15) {
    const miss = WEIGHTS.people_overlap * (1 - b.people_overlap);
    reasons.push(`(-${miss.toFixed(3)}) Barely any cast/crew overlap with your seen set`);
  }

  if (b.tone_match === 0) {
    reasons.push(`(-${WEIGHTS.tone_match.toFixed(3)}) None of its tones match yours`);
  } else if (b.tone_match < 0.25) {
    const miss = WEIGHTS.tone_match * (1 - b.tone_match);
    reasons.push(`(-${miss.toFixed(3)}) Most of its tones are absent from your seen set`);
  }

  if (b.genre_fit === 0) {
    reasons.push(`(-${WEIGHTS.genre_fit.toFixed(3)}) No shared genres`);
  } else if (b.genre_fit < 0.34) {
    const miss = WEIGHTS.genre_fit * (1 - b.genre_fit);
    reasons.push(`(-${miss.toFixed(3)}) Genres rarely overlap with what you watch`);
  }

  if (moodSelected && b.mood_match < 0.5) {
    const miss = WEIGHTS.mood_match * (1 - b.mood_match);
    reasons.push(`(-${miss.toFixed(3)}) Doesn't match the selected mood`);
  }

  if (b.narrative_match === 0) {
    reasons.push(`(-${WEIGHTS.narrative_match.toFixed(3)}) No shared narrative archetypes`);
  } else if (b.narrative_match < 0.25) {
    const miss = WEIGHTS.narrative_match * (1 - b.narrative_match);
    reasons.push(`(-${miss.toFixed(3)}) Narrative archetypes barely overlap with your set`);
  }

  // Editorial closer based on which dimension is most missing
  const dims = [
    ["people overlap", b.people_overlap, WEIGHTS.people_overlap],
    ["tone", b.tone_match, WEIGHTS.tone_match],
    ["narrative", b.narrative_match, WEIGHTS.narrative_match],
    ["genre", b.genre_fit, WEIGHTS.genre_fit],
  ];
  dims.sort((a, x) => (x[2] * (1 - x[1])) - (a[2] * (1 - a[1])));
  const worst = dims[0][0];
  const imdb = rec.title.imdb_rating;
  if (imdb !== null && imdb !== undefined && imdb < state.minRating + 0.5) {
    reasons.push(`Below your average rating bar — and weak ${worst} signal makes it a blind spot`);
  } else {
    reasons.push(`A blind spot: weakest signal is ${worst}, outside your usual lane`);
  }

  return reasons.slice(0, 4);
}

function bindControls() {
  const r = document.getElementById("rating");
  r.oninput = () => {
    state.minRating = parseFloat(r.value);
    document.getElementById("rating-val").textContent = state.minRating.toFixed(1);
    render();
  };
  const t = document.getElementById("topn");
  t.oninput = () => {
    state.topN = parseInt(t.value, 10);
    document.getElementById("topn-val").textContent = state.topN;
    render();
  };
}

/* scoreCandidate is provided by scorer.js (loaded first) — the single JS
   scorer, pinned to brain/scoring.py by tests/fixtures/scoring_parity.json.
   We call it with scoringParams() so the constants come from data.json. */

// "Continue watching" — seen titles left at status 'started'. Resuming
// something you're mid-way through is very often the real "what tonight"
// answer, so surface it above the recommendations. The status buttons let you
// bump it (loved/ok/abandoned) — doing so re-renders and drops it from here.
function renderContinue() {
  const el = document.getElementById("continue");
  if (!el || !DATA) return;
  const started = DATA.titles
    .filter(t => t.seen && t.status === "started")
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (started.length === 0) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML =
    `<h2 class="continue-title">Continue watching <span class="continue-count">${started.length}</span></h2>` +
    `<div class="continue-row">` +
    started.map(t => {
      const year = t.year ? ` (${t.year})` : "";
      const kindBadge = t.kind === "movie" ? '<span class="kind">movie</span>' : "";
      return `<article class="continue-card">` +
        `<h4>${escapeHtml(t.name)}${year}${kindBadge}</h4>` +
        `<div class="status-actions" data-tmdb="${t.tmdb_id}" data-kind="${escapeHtml(t.kind)}">` +
        `<span class="status-actions-label">Update:</span>` +
        STATUS_CHOICES.map(([s, label]) =>
          `<button class="status-btn status-${s}" data-status="${s}">${label}</button>`).join("") +
        `</div></article>`;
    }).join("") +
    `</div>`;
}

function render() {
  if (!DATA) return;
  renderContinue();
  const seen = DATA.titles.filter(t => t.seen);
  let cands = DATA.titles.filter(t => !t.seen);
  if (state.kind !== "all") cands = cands.filter(t => t.kind === state.kind);
  cands = cands.filter(t => t.imdb_rating === null || t.imdb_rating >= state.minRating);

  // Lane filter: candidate must share at least 1 person with the selected lane's seen titles
  if (state.lane !== null && state.lanePeople) {
    cands = cands.filter(c => c.people.some(p => state.lanePeople.has(p.id)));
  }

  // Theme filter: candidate must carry at least one selected theme
  if (state.themes.size > 0) {
    cands = cands.filter(c =>
      (c.themes || []).some(t => state.themes.has(t))
    );
  }

  // Narrative filter: candidate must carry at least one selected archetype
  if (state.narratives.size > 0) {
    cands = cands.filter(c =>
      (c.narratives || []).some(n => state.narratives.has(n))
    );
  }

  const mood = [...state.mood];
  const params = scoringParams();
  const profile = buildProfile(seen, STATUS_AFFINITY);  // derive the seen-graph once, not per candidate
  const recs = cands.map(c => scoreCandidate(c, profile, mood, params));
  recs.sort((a, b) => b.score - a.score);
  if (state.mode === "anti") {
    recs.reverse();
  }
  const top = recs.slice(0, state.topN);

  const container = document.getElementById("results");
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = '<p class="empty">No candidates match these filters.</p>';
    return;
  }
  const isAnti = state.mode === "anti";
  top.forEach((rec, i) => {
    const card = document.createElement("article");
    card.className = isAnti ? "rec anti" : "rec";
    const year = rec.title.year ? ` (${rec.title.year})` : "";
    const imdb = rec.title.imdb_rating
      ? `<span class="imdb">IMDb ${rec.title.imdb_rating}</span> · `
      : "";
    const kindBadge = rec.title.kind === "movie" ? '<span class="kind">movie</span>' : "";
    const statusBadge = rec.title.status && rec.title.status !== "ok"
      ? `<span class="status-badge status-${rec.title.status}">${rec.title.status}</span>`
      : "";
    const antiBadge = isAnti ? '<span class="anti-badge">blind spot</span>' : "";
    const reasonsList = isAnti ? buildAntiReasons(rec) : rec.reasons;
    const themes = (rec.title.themes || []);
    const themesHtml = themes.length === 0 ? "" : `
      <div class="rec-themes">
        ${themes.map(t => {
          const active = state.themes.has(t) ? " active" : "";
          return `<span class="rec-theme${active}">${escapeHtml(t)}</span>`;
        }).join("")}
      </div>`;
    // Narratives — look up labels in DATA.narratives
    const narrIds = rec.title.narratives || [];
    const narrLookup = new Map((DATA.narratives || []).map(n => [n.id, n]));
    const narrEntries = narrIds.map(id => narrLookup.get(id)).filter(Boolean);
    const narrHtml = narrEntries.length === 0 ? "" : `
      <div class="rec-narratives">
        ${narrEntries.map(n => {
          const active = state.narratives.has(n.id) ? " active" : "";
          return `<span class="rec-narrative${active}" title="${escapeHtml(n.description || '')}">${escapeHtml(n.label)}</span>`;
        }).join("")}
      </div>`;
    card.innerHTML = `
      <h3><span class="rank">${i + 1}.</span>${escapeHtml(rec.title.name)}${year}${kindBadge}${statusBadge}${antiBadge}</h3>
      <div class="meta">${imdb}score ${rec.score.toFixed(3)}</div>
      <div class="bar"><div class="bar-fill" style="width:${(rec.score * 100).toFixed(1)}%"></div></div>
      <div class="breakdown">
        tone ${rec.breakdown.tone_match.toFixed(2)} ·
        people ${rec.breakdown.people_overlap.toFixed(2)} ·
        narrative ${rec.breakdown.narrative_match.toFixed(2)} ·
        genre ${rec.breakdown.genre_fit.toFixed(2)} ·
        mood ${rec.breakdown.mood_match.toFixed(2)}
      </div>
      ${narrHtml}
      ${themesHtml}
      <ul class="reasons">
        ${reasonsList.slice(0, 6).map(r => `<li>${escapeHtml(r)}</li>`).join("")}
      </ul>
      <div class="status-actions" data-tmdb="${rec.title.tmdb_id}" data-kind="${rec.title.kind}">
        <span class="status-actions-label">I've seen this:</span>
        ${STATUS_CHOICES.map(([s, label]) =>
          `<button class="status-btn status-${s}" data-status="${s}">${label}</button>`).join("")}
      </div>
    `;
    container.appendChild(card);
  });
}

/* escapeHtml is provided by ui.js (loaded first). */

load();
