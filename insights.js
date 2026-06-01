/* Insights page: hidden auteurs, filmography completion, decade x tone
   heatmap, contrarian loves / acclaimed misses. Vanilla JS, no deps. */

const NON_ACTOR_ROLES = new Set(["creator", "showrunner", "writer", "director", "producer"]);
const TONES = ["cerebral", "dystopian", "paranoid", "antihero", "animation-dark", "surreal"];
const DECADES = [
  { label: "pre-1980", min: 0,    max: 1979 },
  { label: "1980s",    min: 1980, max: 1989 },
  { label: "1990s",    min: 1990, max: 1999 },
  { label: "2000s",    min: 2000, max: 2009 },
  { label: "2010s",    min: 2010, max: 2019 },
  { label: "2020s",    min: 2020, max: 2099 },
];

let DATA = null;
let FILMOGRAPHIES = null;
const heatmapState = { scope: "seen" };

async function init() {
  try {
    const resp = await fetch("data.json");
    DATA = await resp.json();
  } catch (e) {
    document.getElementById("subtitle").textContent = "Failed to load data.json";
    return;
  }
  try {
    const resp = await fetch("filmographies.json");
    if (resp.ok) FILMOGRAPHIES = await resp.json();
  } catch (e) {
    FILMOGRAPHIES = null;
  }
  setSubtitle();
  renderAuteurs();
  renderFilmography();
  renderHeatmap();
  bindHeatmapControls();
  renderContrarian();
}

function setSubtitle() {
  const seen = DATA.titles.filter(t => t.seen).length;
  const loved = DATA.titles.filter(t => t.loved).length;
  const total = DATA.titles.length;
  document.getElementById("subtitle").textContent =
    `${total} titles in your set · ${seen} seen · ${loved} loved`;
}

/* ====== Section 1: Hidden Auteurs ====== */
function renderAuteurs() {
  const loved = DATA.titles.filter(t => t.loved);
  // Map personId -> { name, roles:Set, titles:[] }
  const map = new Map();
  for (const t of loved) {
    for (const p of t.people) {
      if (!NON_ACTOR_ROLES.has(p.role)) continue;
      let entry = map.get(p.id);
      if (!entry) {
        entry = { id: p.id, name: p.name, roles: new Set(), titles: [] };
        map.set(p.id, entry);
      }
      entry.roles.add(p.role);
      entry.titles.push(t);
    }
  }
  const ranked = [...map.values()]
    .sort((a, b) => b.titles.length - a.titles.length || a.name.localeCompare(b.name))
    .slice(0, 25);

  const grid = document.getElementById("auteurs-grid");
  grid.innerHTML = "";
  for (const a of ranked) {
    const recent = [...a.titles]
      .sort((x, y) => (y.year || 0) - (x.year || 0))
      .slice(0, 5);
    const roleBadges = [...a.roles].sort()
      .map(r => `<span class="role-badge">${escapeHtml(r)}</span>`)
      .join("");
    const chips = recent
      .map(t => `<span class="title-chip">${escapeHtml(t.name)}${t.year ? ` (${t.year})` : ""}</span>`)
      .join("");
    const card = document.createElement("article");
    card.className = "auteur-card";
    card.innerHTML = `
      <h3 class="auteur-name">${escapeHtml(a.name)}</h3>
      <div class="auteur-roles">${roleBadges}</div>
      <p class="auteur-count">Appears in <strong>${a.titles.length}</strong> of your loved titles</p>
      <div class="title-chips">${chips}</div>
    `;
    grid.appendChild(card);
  }
}

/* ====== Section 2: Filmography Completion ====== */
function renderFilmography() {
  const container = document.getElementById("filmography-grid");
  container.innerHTML = "";
  if (!FILMOGRAPHIES || !FILMOGRAPHIES.people || FILMOGRAPHIES.people.length === 0) {
    container.innerHTML = `
      <div class="empty-block">
        No <code>filmographies.json</code> found.
        Run <code>python scripts/export_filmographies.py</code> to populate this section.
      </div>`;
    return;
  }

  // Build a tmdb_id -> title lookup for our set. Filmography records
  // identify titles by their TMDb id, matching the same identifier used
  // by our own catalogue.
  const ours = new Set(DATA.titles.map(t => t.tmdb_id));
  const top = [...FILMOGRAPHIES.people]
    .sort((a, b) => (b.loved_appearances || 0) - (a.loved_appearances || 0))
    .slice(0, 30);

  for (const p of top) {
    const filmography = p.filmography || [];
    const total = filmography.length;
    const inSet = filmography.filter(f => ours.has(f.tmdb_id)).length;
    const pct = total === 0 ? 0 : Math.round((inSet / total) * 100);

    const missing = filmography
      .filter(f => !ours.has(f.tmdb_id))
      .sort((x, y) => ((y.vote_count || 0) * (y.vote_average || 0)) -
                       ((x.vote_count || 0) * (x.vote_average || 0)));

    const top3 = missing.slice(0, 3);
    const rest = missing.slice(3);

    const roleBadges = (p.roles || []).map(r => `<span class="role-badge">${escapeHtml(r)}</span>`).join("");

    const fmtRow = f => {
      const yr = f.year ? `(${f.year})` : "";
      const meta = `<span class="missing-meta"><span class="imdb-y">${(f.vote_average || 0).toFixed(1)}</span>` +
                   ` · ${(f.vote_count || 0).toLocaleString()} votes${f.role ? ` · ${escapeHtml(f.role)}` : ""}</span>`;
      return `<li><span>${escapeHtml(f.name)} ${yr}</span><br>${meta}</li>`;
    };

    const card = document.createElement("article");
    card.className = "filmo-card";
    card.innerHTML = `
      <div class="filmo-head">
        <h3>${escapeHtml(p.name)}</h3>
        <span class="filmo-pct">${pct}%</span>
      </div>
      <div class="auteur-roles">${roleBadges}</div>
      <div class="filmo-progress"><div class="filmo-progress-fill" style="width:${pct}%"></div></div>
      <p class="filmo-stat">${inSet} / ${total} catalogued · ${p.loved_appearances || 0} loved appearances</p>
      ${top3.length ? `<p class="filmo-stat" style="margin-top:0.2rem">Top missing:</p>
      <ol class="missing-list">${top3.map(fmtRow).join("")}</ol>` : ""}
      ${rest.length ? `<button class="toggle-missing" type="button">Show all ${missing.length} missing</button>
      <ol class="all-missing-list">${rest.map(fmtRow).join("")}</ol>` : ""}
    `;
    const toggle = card.querySelector(".toggle-missing");
    if (toggle) {
      const list = card.querySelector(".all-missing-list");
      toggle.addEventListener("click", () => {
        const showing = list.classList.toggle("show");
        toggle.textContent = showing
          ? `Hide missing`
          : `Show all ${missing.length} missing`;
      });
    }
    container.appendChild(card);
  }
}

/* ====== Section 3: Decade x Tone Heatmap ====== */
function bindHeatmapControls() {
  document.querySelectorAll(".heatmap-controls .chip").forEach(btn => {
    btn.addEventListener("click", () => {
      heatmapState.scope = btn.dataset.scope;
      document.querySelectorAll(".heatmap-controls .chip")
        .forEach(b => b.classList.toggle("active", b === btn));
      renderHeatmap();
    });
  });
}

function decadeIndex(year) {
  if (year == null) return -1;
  for (let i = 0; i < DECADES.length; i++) {
    if (year >= DECADES[i].min && year <= DECADES[i].max) return i;
  }
  return -1;
}

function renderHeatmap() {
  const titles = DATA.titles.filter(t => {
    if (heatmapState.scope === "loved") return t.loved;
    return t.seen;
  });

  // counts[toneIdx][decadeIdx]
  const counts = TONES.map(() => DECADES.map(() => 0));
  for (const t of titles) {
    const d = decadeIndex(t.year);
    if (d < 0) continue;
    for (const tone of t.tone_tags) {
      const ti = TONES.indexOf(tone);
      if (ti < 0) continue;
      counts[ti][d] += 1;
    }
  }
  let maxCount = 0;
  for (const row of counts) for (const v of row) if (v > maxCount) maxCount = v;

  const W = 480, H = 360;
  const leftPad = 110, topPad = 28, rightPad = 8, bottomPad = 8;
  const gridW = W - leftPad - rightPad;
  const gridH = H - topPad - bottomPad;
  const cellW = gridW / DECADES.length;
  const cellH = gridH / TONES.length;

  const cells = [];
  for (let r = 0; r < TONES.length; r++) {
    for (let c = 0; c < DECADES.length; c++) {
      const v = counts[r][c];
      const intensity = maxCount > 0 ? v / maxCount : 0;
      const alpha = v === 0 ? 0.06 : 0.15 + 0.75 * intensity;
      const x = leftPad + c * cellW;
      const y = topPad + r * cellH;
      const fill = `rgba(138, 180, 248, ${alpha.toFixed(3)})`;
      const textClass = v === 0 || intensity < 0.15 ? "hm-count dim" : "hm-count";
      const titleAttr = `${TONES[r]} · ${DECADES[c].label}: ${v}`;
      cells.push(
        `<g><title>${escapeHtml(titleAttr)}</title>` +
        `<rect class="hm-cell" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="${fill}"></rect>` +
        `<text class="${textClass}" x="${(x + cellW / 2).toFixed(1)}" y="${(y + cellH / 2).toFixed(1)}">${v}</text>` +
        `</g>`
      );
    }
  }

  const decadeLabels = DECADES.map((d, c) => {
    const x = leftPad + c * cellW + cellW / 2;
    return `<text class="hm-label" x="${x.toFixed(1)}" y="${(topPad - 8).toFixed(1)}" text-anchor="middle">${escapeHtml(d.label)}</text>`;
  }).join("");

  const toneLabels = TONES.map((t, r) => {
    const y = topPad + r * cellH + cellH / 2;
    return `<text class="hm-row-label" x="${(leftPad - 8).toFixed(1)}" y="${y.toFixed(1)}" dominant-baseline="middle">${escapeHtml(t)}</text>`;
  }).join("");

  const svg = `<svg id="heatmap-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Decade by tone heatmap">
    ${decadeLabels}
    ${toneLabels}
    ${cells.join("")}
  </svg>`;
  document.getElementById("heatmap-container").innerHTML = svg;
}

/* ====== Section 4: Contrarian & Acclaimed ====== */
function renderContrarian() {
  const loves = DATA.titles
    .filter(t => t.loved && t.imdb_rating != null && t.imdb_rating <= 7.0)
    .sort((a, b) => a.imdb_rating - b.imdb_rating)
    .slice(0, 15);

  const misses = DATA.titles
    .filter(t => t.seen && !t.loved && t.imdb_rating != null && t.imdb_rating >= 8.5)
    .sort((a, b) => b.imdb_rating - a.imdb_rating)
    .slice(0, 15);

  document.getElementById("contrarian-loves").innerHTML = loves.map(renderContrarianRow).join("")
    || `<li class="c-meta">No titles match.</li>`;
  document.getElementById("acclaimed-misses").innerHTML = misses.map(renderContrarianRow).join("")
    || `<li class="c-meta">No titles match.</li>`;
}

function renderContrarianRow(t) {
  const yr = t.year ? ` (${t.year})` : "";
  const tones = (t.tone_tags || [])
    .map(tn => `<span class="tone-pill">${escapeHtml(tn)}</span>`)
    .join("");
  return `<li>
    <span class="c-title">${escapeHtml(t.name)}${yr}</span>
    <div class="c-meta"><span class="imdb-y">IMDb ${t.imdb_rating.toFixed(1)}</span> · ${escapeHtml(t.kind)}</div>
    ${tones ? `<div class="c-tones">${tones}</div>` : ""}
  </li>`;
}

/* ====== Utilities ====== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

init();
