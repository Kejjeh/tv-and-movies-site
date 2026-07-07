/* The taste profile — one derivation of the seen-graph from the title set.
 *
 * The browser used to re-walk DATA.titles in four places (the scorer rebuilt
 * its copy once per candidate). buildProfile() derives the seen-set aggregates
 * once; the scorer and every page read the result.
 *
 * Exposed as a global for classic <script> pages and as a CommonJS export for
 * `node --test`.
 */
(function (global) {
  "use strict";

  // rating-map is loaded before this file in the browser (global RatingMap) and
  // required directly under node. A passive, ratingless import counts as seen
  // but must not calibrate the profile (see web/rating-map.js).
  //
  // Fail loudly if rating-map wasn't loaded first: the old silent
  // `|| () => true` fallback quietly changed the taste-bearing semantics (every
  // passive import would calibrate) on a load-order mistake — worse than a
  // clear error.
  const RM = (typeof require !== "undefined")
    ? require("./rating-map.js")
    : global.RatingMap;
  if (!RM || typeof RM.isTasteBearing !== "function") {
    throw new Error("taste-profile.js requires rating-map.js to be loaded first");
  }
  const isTasteBearing = RM.isTasteBearing;

  // Index people across an arbitrary title list. The indexer does not filter —
  // the caller chooses the cut (seen, loved, a lane). Each entry carries a
  // role->count map and one {title, role} record per credited appearance.
  function indexPeople(titles) {
    const idx = new Map();
    for (const t of titles) {
      for (const p of t.people) {
        let entry = idx.get(p.id);
        if (!entry) {
          entry = { id: p.id, name: p.name, roles: new Map(), titles: [] };
          idx.set(p.id, entry);
        }
        entry.roles.set(p.role, (entry.roles.get(p.role) || 0) + 1);
        entry.titles.push({ title: t, role: p.role });
      }
    }
    return idx;
  }

  // The unique titles behind a person index entry. indexPeople records one
  // {title, role} per credited appearance, so a multi-role credit (e.g.
  // writer + director on one title) appears more than once; collapse to the
  // distinct titles, preserving first-seen order.
  function distinctTitles(entry) {
    const seen = new Set();
    const out = [];
    for (const { title } of entry.titles) {
      const key = `${title.tmdb_id}|${title.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(title);
    }
    return out;
  }

  // Per-status enjoyment in [0,1]; mirror of brain.scoring.STATUS_AFFINITY.
  // Used as a fallback only — the live values ship in data.json params.
  const STATUS_AFFINITY = {
    loved: 1.0, liked: 0.75, ok: 0.5, started: 0.4, disliked: 0.2, hated: 0.0,
  };
  const NEUTRAL_AFFINITY = 0.5;

  // tag -> mean enjoyment across seen titles carrying it. Mirror of
  // brain.scoring.affinity_map.
  function affinityMap(seen, attr, statusAffinity) {
    const total = new Map(), count = new Map();
    for (const t of seen) {
      const aff = statusAffinity[t.status || "ok"];
      const a = (aff == null) ? NEUTRAL_AFFINITY : aff;
      for (const tag of (t[attr] || [])) {
        total.set(tag, (total.get(tag) || 0) + a);
        count.set(tag, (count.get(tag) || 0) + 1);
      }
    }
    const out = new Map();
    for (const [tag, sum] of total) out.set(tag, sum / count.get(tag));
    return out;
  }

  function buildProfile(titles, statusAffinity) {
    const sa = statusAffinity || STATUS_AFFINITY;
    const seen = titles.filter(t => t.seen && isTasteBearing(t.status, t.source));
    const peopleIndex = indexPeople(seen);

    // Plain person -> seen titles view for the scorer (its hot path).
    const seenByPerson = new Map();
    for (const [id, entry] of peopleIndex) {
      seenByPerson.set(id, entry.titles.map(x => x.title));
    }

    // Sets kept for reason-building / other pages; affinity maps drive scoring.
    const seenTones = new Set();
    const seenGenres = new Set();
    const seenNarratives = new Set();
    for (const t of seen) {
      for (const tag of (t.tone_tags || [])) seenTones.add(tag);
      for (const g of (t.genres || [])) seenGenres.add(g);
      for (const n of (t.narratives || [])) seenNarratives.add(n);
    }

    return {
      seenByPerson, peopleIndex, seenTones, seenGenres, seenNarratives,
      toneAffinity: affinityMap(seen, "tone_tags", sa),
      genreAffinity: affinityMap(seen, "genres", sa),
      narrativeAffinity: affinityMap(seen, "narratives", sa),
    };
  }

  global.buildProfile = buildProfile;
  global.indexPeople = indexPeople;
  global.distinctTitles = distinctTitles;
  global.affinityMap = affinityMap;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildProfile, indexPeople, distinctTitles, affinityMap };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
