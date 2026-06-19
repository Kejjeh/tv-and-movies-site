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
  renderCritique();
  renderAuteurs();
  renderFilmography();
  renderHeatmap();
  bindHeatmapControls();
  renderContrarian();
}

/* Map narrative id -> human label. Falls back to the raw id. */
function narrativeLabel(id) {
  if (!DATA || !DATA.narratives) return id;
  const found = DATA.narratives.find(n => n.id === id);
  return found ? found.label : id;
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
  const seen = DATA.titles.filter(t => t.seen);

  // Person index over loved titles, restricted to creative (non-actor) roles.
  // indexPeople is the shared primitive from taste-profile.js; entries carry a
  // role->count map and one {title, role} record per credited appearance.
  const lovedCrew = loved.map(t => ({
    ...t, people: t.people.filter(p => NON_ACTOR_ROLES.has(p.role)),
  }));
  const map = indexPeople(lovedCrew);

  // Tally narratives across SEEN-appearance titles per person.
  // Keyed by personId -> Map(narrativeId -> count).
  const narrByPerson = new Map();
  for (const t of seen) {
    const ns = t.narratives || [];
    if (ns.length === 0) continue;
    const credited = new Set();
    for (const p of t.people) {
      if (!NON_ACTOR_ROLES.has(p.role)) continue;
      if (credited.has(p.id)) continue;
      credited.add(p.id);
      let bucket = narrByPerson.get(p.id);
      if (!bucket) { bucket = new Map(); narrByPerson.set(p.id, bucket); }
      for (const n of ns) bucket.set(n, (bucket.get(n) || 0) + 1);
    }
  }

  // Collapse each person's multi-role credits to the distinct loved titles
  // they appear in, then rank by that count.
  const ranked = [...map.values()]
    .map(a => ({ id: a.id, name: a.name, roles: a.roles, titles: distinctTitles(a) }))
    .sort((a, b) => b.titles.length - a.titles.length || a.name.localeCompare(b.name))
    .slice(0, 25);

  const grid = document.getElementById("auteurs-grid");
  grid.innerHTML = "";
  for (const a of ranked) {
    const recent = a.titles.slice()
      .sort((x, y) => (y.year || 0) - (x.year || 0))
      .slice(0, 5);
    const roleBadges = [...a.roles.keys()].sort()
      .map(r => `<span class="role-badge">${escapeHtml(r)}</span>`)
      .join("");
    const chips = recent
      .map(t => `<span class="title-chip">${escapeHtml(t.name)}${t.year ? ` (${t.year})` : ""}</span>`)
      .join("");

    // Top 3 narratives across seen-appearance titles.
    const bucket = narrByPerson.get(a.id);
    let narrBlock = "";
    if (bucket && bucket.size > 0) {
      const top3 = [...bucket.entries()]
        .sort((x, y) => y[1] - x[1] || narrativeLabel(x[0]).localeCompare(narrativeLabel(y[0])))
        .slice(0, 3);
      const narrChips = top3
        .map(([id, n]) => `<span class="narr-chip">${escapeHtml(narrativeLabel(id))} &times; ${n}</span>`)
        .join("");
      narrBlock = `<p class="auteur-narr-label">Dominant narratives</p>
        <div class="narr-chips">${narrChips}</div>`;
    }

    const card = document.createElement("article");
    card.className = "auteur-card";
    card.innerHTML = `
      <h3 class="auteur-name">${escapeHtml(a.name)}</h3>
      <div class="auteur-roles">${roleBadges}</div>
      <p class="auteur-count">Appears in <strong>${a.titles.length}</strong> of your loved titles</p>
      ${narrBlock}
      <p class="auteur-narr-label">Loved titles</p>
      <div class="title-chips">${chips}</div>
    `;
    grid.appendChild(card);
  }
}

/* ====== Section 0: Critique of Your Taste ====== */
function renderCritique() {
  const grid = document.getElementById("critique-grid");
  if (!grid) return;

  const titles = DATA.titles;
  const seen = titles.filter(t => t.seen);
  const loved = titles.filter(t => t.loved);
  const lovedCount = loved.length || 1; // avoid div-by-zero

  const cards = [];

  // 1. Lane skew — tone counts across SEEN.
  {
    const counts = new Map();
    for (const t of seen) for (const tag of (t.tone_tags || [])) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topTone, topN] = sorted[0];
      const [botTone, botN] = sorted[sorted.length - 1];
      const second = sorted[1];
      const ratio = (topN / Math.max(1, second[1])).toFixed(1);
      cards.push(critiqueCard(
        "Lane skew",
        `Your <strong>${escapeHtml(topTone)}</strong> lane (${topN}) is ${ratio}&times; your <strong>${escapeHtml(second[0])}</strong> lane (${second[1]}). Smallest lane: <strong>${escapeHtml(botTone)}</strong> (${botN}).`
      ));
    }
  }

  // 2. Era skew — loved titles per era.
  {
    const eras = [
      { label: "pre-1990", min: 0,    max: 1989 },
      { label: "1990s",    min: 1990, max: 1999 },
      { label: "2000s",    min: 2000, max: 2009 },
      { label: "2010s",    min: 2010, max: 2019 },
      { label: "2020s",    min: 2020, max: 2099 },
    ];
    const counts = eras.map(e => ({
      ...e,
      n: loved.filter(t => t.year != null && t.year >= e.min && t.year <= e.max).length
    }));
    const sorted = [...counts].sort((a, b) => b.n - a.n);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    const breakdown = counts.map(c => `${c.label} ${c.n}`).join(" &middot; ");
    cards.push(critiqueCard(
      "Era skew",
      `<strong>${escapeHtml(top.label)}</strong> dominates (${top.n} loved). Rarest era: <strong>${escapeHtml(bottom.label)}</strong> (${bottom.n}).<br><span class="critique-meta">${breakdown}</span>`
    ));
  }

  // 3. Movies vs TV in loved.
  {
    const movies = loved.filter(t => t.kind === "movie").length;
    const tv = loved.filter(t => t.kind === "tv").length;
    cards.push(critiqueCard(
      "Movies vs TV",
      `Of your <strong>${lovedCount}</strong> loved, <strong>${movies}</strong> are movies and <strong>${tv}</strong> are TV.`
    ));
  }

  // 4. Auteur dependency.
  {
    const map = new Map();
    for (const t of loved) {
      for (const p of t.people) {
        if (!NON_ACTOR_ROLES.has(p.role)) continue;
        let e = map.get(p.id);
        if (!e) { e = { id: p.id, name: p.name, titles: new Set() }; map.set(p.id, e); }
        e.titles.add(t.tmdb_id);
      }
    }
    const top10 = [...map.values()].sort((a, b) => b.titles.size - a.titles.size).slice(0, 10);
    const union = new Set();
    for (const r of top10) for (const id of r.titles) union.add(id);
    const pct = Math.round(100 * union.size / lovedCount);
    cards.push(critiqueCard(
      "Auteur dependency",
      `<strong>${pct}%</strong> of your loved set (${union.size} of ${lovedCount}) is credited to one of the top 10 hidden auteurs in your network.`
    ));
  }

  // 5. Most-tagged narrative in loved.
  {
    const counts = new Map();
    for (const t of loved) for (const n of (t.narratives || [])) {
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      const [id, n] = sorted[0];
      cards.push(critiqueCard(
        "Most-loved narrative",
        `Your most-loved narrative archetype is <strong>&ldquo;${escapeHtml(narrativeLabel(id))}&rdquo;</strong> (${n} titles).`
      ));
    }
  }

  // 6. Critical favorite vs contrarian floor.
  {
    const withRating = loved.filter(t => t.imdb_rating != null);
    if (withRating.length > 0) {
      const high = withRating.slice().sort((a, b) => b.imdb_rating - a.imdb_rating)[0];
      const low = withRating.slice().sort((a, b) => a.imdb_rating - b.imdb_rating)[0];
      cards.push(critiqueCard(
        "Critical floor and ceiling",
        `Highest-rated love: <strong>${escapeHtml(high.name)}</strong> (${high.imdb_rating.toFixed(1)}). Lowest-rated love: <strong>${escapeHtml(low.name)}</strong> (${low.imdb_rating.toFixed(1)}) &mdash; your most contrarian pick.`
      ));
    }
  }

  // 7. Cluster concentration — top 3 loved clusters (excludes noise -1).
  {
    const labelOf = new Map((DATA.clusters || []).map(c => [c.cluster_id, c.label]));
    const counts = new Map();
    for (const t of loved) {
      const cid = t.cluster_id;
      if (cid == null || !labelOf.has(cid)) continue;
      counts.set(cid, (counts.get(cid) || 0) + 1);
    }
    const top3 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top3.length >= 1) {
      const parts = top3.map(([cid, n]) => `<strong>${escapeHtml(labelOf.get(cid))}</strong> (${n})`);
      cards.push(critiqueCard(
        "Cluster concentration",
        `Top Louvain clusters by loved members: ${parts.join(", ")}.`
      ));
    }
  }

  // 8. Kind imbalance per tone in loved.
  {
    const toneKind = new Map();
    for (const t of loved) {
      for (const tag of (t.tone_tags || [])) {
        let k = toneKind.get(tag);
        if (!k) { k = { movie: 0, tv: 0 }; toneKind.set(tag, k); }
        if (t.kind === "movie") k.movie += 1;
        else if (t.kind === "tv") k.tv += 1;
      }
    }
    // Pick the most TV-skewed and most movie-skewed tones (require >= 5 titles).
    const ratios = [...toneKind.entries()]
      .map(([tone, k]) => ({ tone, k, total: k.movie + k.tv, tvPct: k.movie + k.tv ? k.tv / (k.movie + k.tv) : 0 }))
      .filter(x => x.total >= 5);
    if (ratios.length >= 2) {
      const tvLean = ratios.slice().sort((a, b) => b.tvPct - a.tvPct)[0];
      const movieLean = ratios.slice().sort((a, b) => a.tvPct - b.tvPct)[0];
      cards.push(critiqueCard(
        "Kind imbalance per tone",
        `<strong>${escapeHtml(tvLean.tone)}</strong> is ${Math.round(tvLean.tvPct * 100)}% TV-loved. <strong>${escapeHtml(movieLean.tone)}</strong> is ${Math.round((1 - movieLean.tvPct) * 100)}% movie-loved.`
      ));
    }
  }

  // 9. Time travel index.
  {
    const tt = loved.filter(t => {
      const ns = t.narratives || [];
      const th = t.themes || [];
      return ns.includes("time-as-prison") || ns.includes("time-as-redemption") || th.includes("time travel");
    }).length;
    const pct = (100 * tt / lovedCount).toFixed(1);
    cards.push(critiqueCard(
      "Time-travel index",
      `You loved <strong>${tt}</strong> time-travel adjacent titles. That&rsquo;s <strong>${pct}%</strong> of your loved set.`
    ));
  }

  // 10. Freudian closer.
  {
    const freud = new Set(["ego-dissolution", "return-of-the-repressed", "the-double", "memory-as-weapon"]);
    const n = loved.filter(t => (t.narratives || []).some(x => freud.has(x))).length;
    const pct = (100 * n / lovedCount).toFixed(1);
    cards.push(critiqueCard(
      "Structure of the self",
      `Your taste skews psychoanalytic: <strong>${n}</strong> loved titles (${pct}%) wrestle with identity, memory, or the divided self.`
    ));
  }

  grid.innerHTML = cards.join("");
}

function critiqueCard(title, bodyHtml) {
  return `<article class="critique-card">
    <h3 class="critique-title">${escapeHtml(title)}</h3>
    <p class="critique-body">${bodyHtml}</p>
  </article>`;
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
/* escapeHtml is provided by ui.js (loaded first). */

init();
