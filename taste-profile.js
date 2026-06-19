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

  function buildProfile(titles) {
    const seen = titles.filter(t => t.seen);
    const peopleIndex = indexPeople(seen);

    // Plain person -> seen titles view for the scorer (its hot path).
    const seenByPerson = new Map();
    for (const [id, entry] of peopleIndex) {
      seenByPerson.set(id, entry.titles.map(x => x.title));
    }

    const seenTones = new Set();
    const seenGenres = new Set();
    const seenNarratives = new Set();
    for (const t of seen) {
      for (const tag of (t.tone_tags || [])) seenTones.add(tag);
      for (const g of (t.genres || [])) seenGenres.add(g);
      for (const n of (t.narratives || [])) seenNarratives.add(n);
    }

    return { seenByPerson, peopleIndex, seenTones, seenGenres, seenNarratives };
  }

  global.buildProfile = buildProfile;
  global.indexPeople = indexPeople;
  global.distinctTitles = distinctTitles;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildProfile, indexPeople, distinctTitles };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
