/* Universe search against TMDb (the whole lookup-able catalogue).
 *
 * The pure normalizer (normalizeMulti) turns a /search/multi response into flat
 * title results — expanding person hits into their known-for titles and tagging
 * which titles are already in your set. The browser fetch (searchTmdb) uses the
 * public read-only v3 API key from tmdb-config.js.
 *
 * Global for classic <script> pages; CommonJS export for `node --test`.
 */
(function (global) {
  "use strict";

  function yearOf(o) {
    const date = o.release_date || o.first_air_date || "";
    return date.length >= 4 && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
  }

  // Shared accumulator: pushes one title entry per (id, kind), merging via-people.
  function accumulator(knownKeys) {
    const out = [];
    const byKey = new Map();
    return {
      out,
      push(o, kind, via) {
        const key = `${o.id}|${kind}`;
        if (byKey.has(key)) {
          if (via && !byKey.get(key).via.includes(via)) byKey.get(key).via.push(via);
          return;
        }
        const entry = {
          tmdb_id: o.id,
          name: o.title || o.name || "",
          kind,
          year: yearOf(o),
          overview: o.overview || "",
          inSet: knownKeys.has(key),
          via: via ? [via] : [],
        };
        byKey.set(key, entry);
        out.push(entry);
      },
    };
  }

  // /search/multi: movie/tv hits direct, person hits expand to known_for.
  function normalizeMulti(json, knownKeys) {
    const acc = accumulator(knownKeys || new Set());
    for (const item of (json.results || [])) {
      if (item.media_type === "movie" || item.media_type === "tv") {
        acc.push(item, item.media_type);
      } else if (item.media_type === "person") {
        for (const kf of (item.known_for || [])) {
          if (kf.media_type === "movie" || kf.media_type === "tv") {
            acc.push(kf, kf.media_type, item.name);
          }
        }
      }
    }
    return acc.out;
  }

  // /search/movie or /search/tv: results carry no media_type; the kind is known.
  function normalizeTyped(json, kind, knownKeys) {
    const acc = accumulator(knownKeys || new Set());
    for (const item of (json.results || [])) acc.push(item, kind);
    return acc.out;
  }

  // ---- Browser fetch ----------------------------------------------------
  // opts: { kind: "movie"|"tv", year } — when kind is set, use the typed
  // endpoint so TMDb filters by kind (and year) server-side; otherwise multi.
  async function searchTmdb(query, knownKeys, opts) {
    const key = global.TMDB_API_KEY;
    if (!key) throw new Error("TMDB_API_KEY not configured");
    opts = opts || {};
    const base = "https://api.themoviedb.org/3";
    let url, typed = null;
    if (opts.kind === "movie" || opts.kind === "tv") {
      typed = opts.kind;
      const yearParam = opts.kind === "movie" ? "primary_release_year" : "first_air_date_year";
      url = `${base}/search/${opts.kind}?include_adult=false` +
        `&api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}` +
        (opts.year ? `&${yearParam}=${encodeURIComponent(opts.year)}` : "");
    } else {
      url = `${base}/search/multi?include_adult=false` +
        `&api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`;
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`TMDb ${resp.status}`);
    const json = await resp.json();
    return typed ? normalizeTyped(json, typed, knownKeys) : normalizeMulti(json, knownKeys);
  }

  global.normalizeMulti = normalizeMulti;
  global.normalizeTyped = normalizeTyped;
  global.searchTmdb = searchTmdb;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { normalizeMulti, normalizeTyped, searchTmdb };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
