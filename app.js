/* Ported from brain/scoring.py — keep in lockstep with the Python.
   The weights and role weights come from data.json so the source of
   truth stays in one place. */

const TONES = ["cerebral", "dystopian", "paranoid", "antihero", "animation-dark", "surreal"];

let DATA = null;
let WEIGHTS = null;
let ROLE_WEIGHTS = null;

const state = {
  mood: new Set(),
  minRating: 7.5,
  topN: 10,
  kind: "all",
};

async function load() {
  const r = await fetch("data.json");
  DATA = await r.json();
  WEIGHTS = DATA.weights;
  ROLE_WEIGHTS = DATA.role_weights;
  buildMoodChips();
  buildKindChips();
  bindControls();
  setSubtitle();
  setUpdated();
  render();
}

function setSubtitle() {
  const seen = DATA.titles.filter(t => t.seen).length;
  const loved = DATA.titles.filter(t => t.loved).length;
  const cands = DATA.titles.filter(t => !t.seen).length;
  document.getElementById("subtitle").textContent =
    `${seen} seen · ${loved} loved · ${cands} candidates`;
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

function roleWeight(role) {
  return ROLE_WEIGHTS[role] ?? 1.0;
}

/* Mirrors loved_weighted_overlap + _fraction + _mood_score in brain/scoring.py */
function scoreCandidate(cand, seen, mood) {
  const personToSeen = new Map();
  const seenTones = new Set();
  const seenGenres = new Set();
  for (const t of seen) {
    for (const p of t.people) {
      if (!personToSeen.has(p.id)) personToSeen.set(p.id, []);
      personToSeen.get(p.id).push(t);
    }
    for (const tag of t.tone_tags) seenTones.add(tag);
    for (const g of t.genres) seenGenres.add(g);
  }

  // people_overlap, love-weighted
  let totalW = 0, matchedW = 0;
  for (const p of cand.people) {
    const w = roleWeight(p.role);
    totalW += w;
    const sources = personToSeen.get(p.id);
    if (sources && sources.length > 0) {
      const loveFactor = sources.some(t => t.loved) ? 2.0 : 1.0;
      matchedW += w * loveFactor;
    }
  }
  const peopleOverlap = totalW > 0 ? Math.min(1.0, matchedW / totalW) : 0;

  // tone, genre
  const sharedTones = cand.tone_tags.filter(t => seenTones.has(t));
  const toneMatch = cand.tone_tags.length > 0 ? sharedTones.length / cand.tone_tags.length : 0;
  const sharedGenres = cand.genres.filter(g => seenGenres.has(g));
  const genreFit = cand.genres.length > 0 ? sharedGenres.length / cand.genres.length : 0;

  // mood
  let moodMatch = 0.5;
  let moodMatched = [];
  if (mood.length > 0) {
    moodMatched = mood.filter(m => cand.tone_tags.includes(m));
    moodMatch = moodMatched.length / mood.length;
  }

  const breakdown = {
    tone_match: toneMatch,
    people_overlap: peopleOverlap,
    genre_fit: genreFit,
    mood_match: moodMatch,
  };
  const total =
    WEIGHTS.tone_match * toneMatch +
    WEIGHTS.people_overlap * peopleOverlap +
    WEIGHTS.genre_fit * genreFit +
    WEIGHTS.mood_match * moodMatch;

  // reasons sorted by contribution
  const pairs = [];
  const totalPeopleW = cand.people.reduce((s, p) => s + roleWeight(p.role), 0);
  for (const p of cand.people) {
    const sources = personToSeen.get(p.id);
    if (!sources || sources.length === 0) continue;
    const contrib = totalPeopleW > 0 ? roleWeight(p.role) / totalPeopleW * WEIGHTS.people_overlap : 0;
    const names = sources.map(t => t.name).join(", ");
    pairs.push([contrib, `Shares ${p.name} (${p.role}) with ${names}`]);
  }
  if (sharedTones.length > 0) {
    const c = sharedTones.length / cand.tone_tags.length * WEIGHTS.tone_match;
    pairs.push([c, `Tone match: ${[...sharedTones].sort().join(", ")}`]);
  }
  if (sharedGenres.length > 0) {
    const c = sharedGenres.length / cand.genres.length * WEIGHTS.genre_fit;
    pairs.push([c, `Shared genres: ${[...sharedGenres].sort().join(", ")}`]);
  }
  if (moodMatched.length > 0) {
    const c = moodMatched.length / mood.length * WEIGHTS.mood_match;
    pairs.push([c, `Mood match: ${[...moodMatched].sort().join(", ")}`]);
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const reasons = pairs.map(([c, t]) => `(+${c.toFixed(3)}) ${t}`);

  return { title: cand, score: total, breakdown, reasons };
}

function render() {
  if (!DATA) return;
  const seen = DATA.titles.filter(t => t.seen);
  let cands = DATA.titles.filter(t => !t.seen);
  if (state.kind !== "all") cands = cands.filter(t => t.kind === state.kind);
  cands = cands.filter(t => t.imdb_rating === null || t.imdb_rating >= state.minRating);

  const mood = [...state.mood];
  const recs = cands.map(c => scoreCandidate(c, seen, mood));
  recs.sort((a, b) => b.score - a.score);
  const top = recs.slice(0, state.topN);

  const container = document.getElementById("results");
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = '<p class="empty">No candidates match these filters.</p>';
    return;
  }
  top.forEach((rec, i) => {
    const card = document.createElement("article");
    card.className = "rec";
    const year = rec.title.year ? ` (${rec.title.year})` : "";
    const imdb = rec.title.imdb_rating
      ? `<span class="imdb">IMDb ${rec.title.imdb_rating}</span> · `
      : "";
    const kindBadge = rec.title.kind === "movie" ? '<span class="kind">movie</span>' : "";
    card.innerHTML = `
      <h3><span class="rank">${i + 1}.</span>${escapeHtml(rec.title.name)}${year}${kindBadge}</h3>
      <div class="meta">${imdb}score ${rec.score.toFixed(3)}</div>
      <div class="bar"><div class="bar-fill" style="width:${(rec.score * 100).toFixed(1)}%"></div></div>
      <div class="breakdown">
        tone ${rec.breakdown.tone_match.toFixed(2)} ·
        people ${rec.breakdown.people_overlap.toFixed(2)} ·
        genre ${rec.breakdown.genre_fit.toFixed(2)} ·
        mood ${rec.breakdown.mood_match.toFixed(2)}
      </div>
      <ul class="reasons">
        ${rec.reasons.slice(0, 6).map(r => `<li>${escapeHtml(r)}</li>`).join("")}
      </ul>
    `;
    container.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

load();
