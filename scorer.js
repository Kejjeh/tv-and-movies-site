/* The JS scorer — mirror of brain/scoring.py score_candidate.
 *
 * Pinned to the Python implementation by tests/fixtures/scoring_parity.json
 * (see tests/js/scorer.test.js + tests/test_scoring_parity.py). The scoring
 * parameters are passed in via `params` (weights / role_weights /
 * status_multipliers) so there is a single source of truth — data.json — and
 * the fixture can freeze identical numbers for both languages.
 *
 * Exposed as a global for classic <script> pages and as a CommonJS export for
 * `node --test`.
 */
(function (global) {
  "use strict";

  function roleWeight(roleWeights, role) {
    return (roleWeights[role] != null) ? roleWeights[role] : 1.0;
  }

  const NEUTRAL_AFFINITY = 0.5;

  // Mean affinity over the candidate's tags the seen-set has an opinion on;
  // neutral when none are judged. Mirror of brain.scoring._affinity_score.
  function affinityScore(candTags, amap) {
    let sum = 0, n = 0;
    for (const tag of (candTags || [])) {
      if (amap.has(tag)) { sum += amap.get(tag); n++; }
    }
    return n === 0 ? NEUTRAL_AFFINITY : sum / n;
  }

  // `profile` is a prebuilt taste profile (see web/taste-profile.js) — the
  // seen-graph derived once, not rebuilt per candidate.
  function scoreCandidate(cand, profile, mood, params) {
    mood = mood || [];
    const weights = params.weights;
    const roleWeights = params.role_weights;
    const statusMult = params.status_multipliers;
    const narratives = params.narratives || [];

    const personToSeen = profile.seenByPerson;
    const seenTones = profile.seenTones;
    const seenGenres = profile.seenGenres;

    // people_overlap: each candidate person picks up the status multiplier of
    // the strongest-reacted seen title they appear in (largest absolute value).
    let totalW = 0, matchedW = 0;
    for (const p of cand.people) {
      const w = roleWeight(roleWeights, p.role);
      totalW += w;
      const sources = personToSeen.get(p.id);
      if (sources && sources.length > 0) {
        let best = 0;
        for (const t of sources) {
          const m = (statusMult[t.status || "ok"] != null) ? statusMult[t.status || "ok"] : 1.0;
          if (Math.abs(m) > Math.abs(best)) best = m;
        }
        matchedW += w * best;
      }
    }
    const peopleOverlap = totalW > 0 ? Math.max(0, Math.min(1.0, matchedW / totalW)) : 0;

    // tone / genre / narrative: preference affinity, not set-membership fraction.
    const toneMatch = affinityScore(cand.tone_tags, profile.toneAffinity);
    const genreFit = affinityScore(cand.genres, profile.genreAffinity);
    const candNarratives = cand.narratives || [];
    const narrativeMatch = affinityScore(candNarratives, profile.narrativeAffinity);
    // Still surfaced in reason strings (presentation only).
    const seenNarratives = profile.seenNarratives;
    const sharedTones = cand.tone_tags.filter(t => seenTones.has(t));
    const sharedGenres = cand.genres.filter(g => seenGenres.has(g));
    const sharedNarratives = candNarratives.filter(n => seenNarratives.has(n));

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
      narrative_match: narrativeMatch,
    };
    const score =
      weights.tone_match * toneMatch +
      weights.people_overlap * peopleOverlap +
      weights.genre_fit * genreFit +
      weights.mood_match * moodMatch +
      weights.narrative_match * narrativeMatch;

    // reasons, sorted by contribution (presentation only — not part of parity).
    const pairs = [];
    const totalPeopleW = cand.people.reduce((s, p) => s + roleWeight(roleWeights, p.role), 0);
    for (const p of cand.people) {
      const sources = personToSeen.get(p.id);
      if (!sources || sources.length === 0) continue;
      const contrib = totalPeopleW > 0
        ? roleWeight(roleWeights, p.role) / totalPeopleW * weights.people_overlap : 0;
      // Annotate each shared title with the status that drives its pull.
      const names = sources
        .map(t => (t.status && t.status !== "ok") ? `${t.name} (${t.status})` : t.name)
        .join(", ");
      pairs.push([contrib, `Shares ${p.name} (${p.role}) with ${names}`]);
    }
    if (sharedTones.length > 0) {
      const c = sharedTones.length / cand.tone_tags.length * weights.tone_match;
      pairs.push([c, `Tone match: ${[...sharedTones].sort().join(", ")}`]);
    }
    if (sharedGenres.length > 0) {
      const c = sharedGenres.length / cand.genres.length * weights.genre_fit;
      pairs.push([c, `Shared genres: ${[...sharedGenres].sort().join(", ")}`]);
    }
    if (moodMatched.length > 0) {
      const c = moodMatched.length / mood.length * weights.mood_match;
      pairs.push([c, `Mood match: ${[...moodMatched].sort().join(", ")}`]);
    }
    if (sharedNarratives.length > 0) {
      const c = sharedNarratives.length / candNarratives.length * weights.narrative_match;
      const labels = sharedNarratives.slice().sort().map(id => {
        const f = narratives.find(n => n.id === id);
        return f ? f.label : id;
      });
      const shown = labels.slice(0, 3).join(", ");
      const more = labels.length > 3 ? ` (+${labels.length - 3} more)` : "";
      pairs.push([c, `Narrative match: ${shown}${more}`]);
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const reasons = pairs.map(([c, t]) => `(+${c.toFixed(3)}) ${t}`);

    return { title: cand, score, breakdown, reasons };
  }

  global.scoreCandidate = scoreCandidate;
  global.Scorer = { scoreCandidate };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { scoreCandidate };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
