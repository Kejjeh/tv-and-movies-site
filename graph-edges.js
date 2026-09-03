/* Shared-people edges between seen titles — the pure half of graph.js's
 * buildEdges, split out so it can be unit-tested under `node --test`.
 *
 * Mirrors scripts/build/clusters.py's person_title_roles: a person credited
 * under several roles on ONE title is a single collaboration. Recording each
 * (title, role) separately used to emit a title->itself edge and let one
 * person satisfy the "min shared people" slider several times over.
 *
 * Global for classic <script> pages; CommonJS export for tests.
 */
(function (global) {
  "use strict";

  // Higher wins when one person holds several roles on the same title, so the
  // representative role can't depend on people-list order.
  const ROLE_PRIORITY = {
    creator: 5, showrunner: 4, writer: 3, director: 2, producer: 1,
  };

  // person id -> {name, byTitle: Map(titleId -> role)} for the active roles.
  function creditsByPerson(titles, activeRoles) {
    const persons = new Map();
    for (const t of titles) {
      for (const p of t.people || []) {
        if (!activeRoles.has(p.role)) continue;
        if (!persons.has(p.id)) persons.set(p.id, { name: p.name, byTitle: new Map() });
        const byTitle = persons.get(p.id).byTitle;
        const current = byTitle.get(t.tmdb_id);
        if (current === undefined ||
            (ROLE_PRIORITY[p.role] || 0) > (ROLE_PRIORITY[current] || 0)) {
          byTitle.set(t.tmdb_id, p.role);
        }
      }
    }
    return persons;
  }

  // "loId|hiId" -> {people: [{id, name, role}], weight}
  function titlePairs(titles, activeRoles, roleWeights) {
    const persons = creditsByPerson(titles, activeRoles);
    const pairs = new Map();
    for (const [pid, info] of persons) {
      const entries = [...info.byTitle.entries()];   // one per TITLE
      if (entries.length < 2) continue;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [aId, aRole] = entries[i];
          const [bId, bRole] = entries[j];
          const lo = Math.min(aId, bId), hi = Math.max(aId, bId);
          const key = `${lo}|${hi}`;
          if (!pairs.has(key)) pairs.set(key, { people: [], weight: 0 });
          const entry = pairs.get(key);
          // The weaker credit governs: a producer-on-A / writer-on-B link is
          // only as strong as its weakest end, and min() is symmetric.
          const w = Math.min(
            roleWeights[aRole] != null ? roleWeights[aRole] : 1.0,
            roleWeights[bRole] != null ? roleWeights[bRole] : 1.0,
          );
          const role = (ROLE_PRIORITY[aRole] || 0) >= (ROLE_PRIORITY[bRole] || 0)
            ? aRole : bRole;
          entry.people.push({ id: pid, name: info.name, role });
          entry.weight += w;
        }
      }
    }
    return pairs;
  }

  const API = { titlePairs, creditsByPerson, ROLE_PRIORITY };
  global.GraphEdges = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
