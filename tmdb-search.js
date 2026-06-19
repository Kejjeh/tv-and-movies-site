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

  function normalizeMulti(json, knownKeys) {
    knownKeys = knownKeys || new Set();
    const out = [];
    const byKey = new Map();

    function pushTitle(o, kind, via) {
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
    }

    for (const item of (json.results || [])) {
      if (item.media_type === "movie" || item.media_type === "tv") {
        pushTitle(item, item.media_type);
      } else if (item.media_type === "person") {
        for (const kf of (item.known_for || [])) {
          if (kf.media_type === "movie" || kf.media_type === "tv") {
            pushTitle(kf, kf.media_type, item.name);
          }
        }
      }
    }
    return out;
  }

  // ---- Browser fetch ----------------------------------------------------
  async function searchTmdb(query, knownKeys) {
    const key = global.TMDB_API_KEY;
    if (!key) throw new Error("TMDB_API_KEY not configured");
    const url = "https://api.themoviedb.org/3/search/multi?include_adult=false" +
      `&api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`TMDb ${resp.status}`);
    return normalizeMulti(await resp.json(), knownKeys);
  }

  global.normalizeMulti = normalizeMulti;
  global.searchTmdb = searchTmdb;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { normalizeMulti, searchTmdb };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
