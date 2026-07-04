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
          voteAverage: (o.vote_average != null) ? o.vote_average : null,
          genreIds: o.genre_ids || [],
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

  // Client-side narrowing of universe results by the filters TMDb metadata can
  // honour: year range, rating range (vote average), and genre ids. Results
  // missing a value drop out when the matching filter is set.
  function postFilterUniverse(results, f) {
    f = f || {};
    return results.filter(r => {
      if ((f.yearMin != null || f.yearMax != null) && r.year == null) return false;
      if (f.yearMin != null && r.year < f.yearMin) return false;
      if (f.yearMax != null && r.year > f.yearMax) return false;
      if ((f.ratingMin != null || f.ratingMax != null) && r.voteAverage == null) return false;
      if (f.ratingMin != null && r.voteAverage < f.ratingMin) return false;
      if (f.ratingMax != null && r.voteAverage > f.ratingMax) return false;
      if (f.genreIds && f.genreIds.length &&
          !f.genreIds.some(id => (r.genreIds || []).includes(id))) return false;
      return true;
    });
  }

  // Choose the TMDb endpoint. opts: { kind: "movie"|"tv", year }.
  //   text + kind  -> /search/{kind} (year-filtered)
  //   text, no kind -> /search/multi
  //   no text + kind -> /discover/{kind} (browse by year/popularity)
  //   no text, no kind -> null (nothing to search)
  // Returns { url, typed } where typed is the kind to normalize as, or null.
  function tmdbSearchUrl(query, key, opts) {
    opts = opts || {};
    const q = (query || "").trim();
    const kind = (opts.kind === "movie" || opts.kind === "tv") ? opts.kind : null;
    const base = "https://api.themoviedb.org/3";
    const apiKey = `&api_key=${encodeURIComponent(key)}`;
    const pageBit = opts.page ? `&page=${encodeURIComponent(opts.page)}` : "";
    const yearParam = kind === "movie" ? "primary_release_year" : "first_air_date_year";
    const yearBit = (kind && opts.year) ? `&${yearParam}=${encodeURIComponent(opts.year)}` : "";

    if (q && kind) {
      return { url: `${base}/search/${kind}?include_adult=false${apiKey}&query=${encodeURIComponent(q)}${yearBit}${pageBit}`, typed: kind };
    }
    if (q) {
      return { url: `${base}/search/multi?include_adult=false${apiKey}&query=${encodeURIComponent(q)}${pageBit}`, typed: null };
    }
    if (kind) {
      const d = opts.disc || {};
      const dateGte = kind === "movie" ? "release_date.gte" : "first_air_date.gte";
      const dateLte = kind === "movie" ? "release_date.lte" : "first_air_date.lte";
      const sort = d.sortBy || "popularity.desc";
      let bits = "";
      if (d.genreId != null) bits += `&with_genres=${encodeURIComponent(d.genreId)}`;
      if (d.keywordId != null) bits += `&with_keywords=${encodeURIComponent(d.keywordId)}`;
      if (d.ratingMin != null) bits += `&vote_average.gte=${encodeURIComponent(d.ratingMin)}`;
      if (d.ratingMax != null) bits += `&vote_average.lte=${encodeURIComponent(d.ratingMax)}`;
      if (d.voteCountMin != null) bits += `&vote_count.gte=${encodeURIComponent(d.voteCountMin)}`;
      if (d.yearMin != null) bits += `&${dateGte}=${encodeURIComponent(d.yearMin)}-01-01`;
      if (d.yearMax != null) bits += `&${dateLte}=${encodeURIComponent(d.yearMax)}-12-31`;
      return { url: `${base}/discover/${kind}?include_adult=false&sort_by=${encodeURIComponent(sort)}${apiKey}${bits}${pageBit}`, typed: kind };
    }
    return null;
  }

  // ---- Browser fetch ----------------------------------------------------
  // Returns { results, page, totalPages } (results normalized + post-filtered).
  async function searchTmdb(query, knownKeys, opts) {
    const key = global.TMDB_API_KEY;
    if (!key) throw new Error("TMDB_API_KEY not configured");
    opts = opts || {};
    const choice = tmdbSearchUrl(query, key, opts);
    if (!choice) return { results: [], page: 0, totalPages: 0 };
    const resp = await fetch(choice.url);
    if (!resp.ok) throw new Error(`TMDb ${resp.status}`);
    const json = await resp.json();
    const normalized = choice.typed
      ? normalizeTyped(json, choice.typed, knownKeys)
      : normalizeMulti(json, knownKeys);
    return {
      results: postFilterUniverse(normalized, opts.filters),
      page: json.page || 1,
      totalPages: json.total_pages || 1,
    };
  }

  // TMDb genre lists differ for movie vs tv; fetch both once and cache as
  // per-kind name->id maps.
  let genreMaps = null;  // { movie: Map(nameLower->id), tv: Map(...) }
  async function loadGenreMaps() {
    if (genreMaps) return genreMaps;
    const key = global.TMDB_API_KEY;
    const maps = { movie: new Map(), tv: new Map() };
    for (const kind of ["movie", "tv"]) {
      try {
        const r = await fetch(`https://api.themoviedb.org/3/genre/${kind}/list?api_key=${encodeURIComponent(key)}`);
        const j = await r.json();
        for (const g of (j.genres || [])) maps[kind].set(g.name.toLowerCase(), g.id);
      } catch (_) { /* leave partial */ }
    }
    genreMaps = maps;
    return maps;
  }

  // All ids a genre name maps to across both kinds (for client-side filtering).
  async function genreIdsFor(name) {
    if (!name) return [];
    const m = await loadGenreMaps();
    const k = name.toLowerCase();
    return [m.movie.get(k), m.tv.get(k)].filter(id => id != null);
  }

  // The id for a genre name within one kind (for server-side /discover).
  async function genreIdFor(name, kind) {
    if (!name || (kind !== "movie" && kind !== "tv")) return null;
    const m = await loadGenreMaps();
    return m[kind].get(name.toLowerCase()) ?? null;
  }

  // Resolve a theme name to a TMDb keyword id (keywords are shared across
  // movie/tv), via /search/keyword. Cached; null if TMDb has no such keyword.
  const keywordIdCache = new Map();
  async function keywordIdFor(name) {
    if (!name) return null;
    const k = name.toLowerCase();
    if (keywordIdCache.has(k)) return keywordIdCache.get(k);
    const key = global.TMDB_API_KEY;
    let id = null;
    try {
      const r = await fetch(`https://api.themoviedb.org/3/search/keyword?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(name)}`);
      const j = await r.json();
      const exact = (j.results || []).find(x => (x.name || "").toLowerCase() === k);
      id = exact ? exact.id : ((j.results && j.results[0]) ? j.results[0].id : null);
    } catch (_) { /* leave null */ }
    keywordIdCache.set(k, id);
    return id;
  }

  // ---- Extra browser helpers (import + auteur-completion) -------------

  // Resolve an IMDb id (ttXXXXXXX) to a TMDb {tmdb_id, kind, name, year} via
  // /find. Exact — no fuzzy title matching. Returns null if nothing matches.
  async function findByImdbId(imdbId) {
    const key = global.TMDB_API_KEY;
    if (!key) throw new Error("TMDB_API_KEY not configured");
    const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}` +
      `?external_source=imdb_id&api_key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`TMDb ${r.status}`);
    const j = await r.json();
    const m = (j.movie_results || [])[0];
    if (m) return { tmdb_id: m.id, kind: "movie", name: m.title || "", year: yearOf(m) };
    const tv = (j.tv_results || [])[0];
    if (tv) return { tmdb_id: tv.id, kind: "tv", name: tv.name || "", year: yearOf(tv) };
    return null;
  }

  // Fuzzy-resolve a movie by name (+ optional year) to a TMDb id — first hit.
  async function searchOneMovie(name, year) {
    const key = global.TMDB_API_KEY;
    if (!key) throw new Error("TMDB_API_KEY not configured");
    const yr = year ? `&primary_release_year=${encodeURIComponent(year)}` : "";
    const url = `https://api.themoviedb.org/3/search/movie?include_adult=false` +
      `&api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(name)}${yr}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`TMDb ${r.status}`);
    const j = await r.json();
    const m = (j.results || [])[0];
    return m ? { tmdb_id: m.id, kind: "movie", name: m.title || name, year: yearOf(m) } : null;
  }

  // A person's whole filmography ({cast, crew}) — the auteur-completion source.
  async function fetchCombinedCredits(personId) {
    const key = global.TMDB_API_KEY;
    if (!key) throw new Error("TMDB_API_KEY not configured");
    const url = `https://api.themoviedb.org/3/person/${encodeURIComponent(personId)}` +
      `/combined_credits?api_key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`TMDb ${r.status}`);
    return r.json();
  }

  global.normalizeMulti = normalizeMulti;
  global.normalizeTyped = normalizeTyped;
  global.postFilterUniverse = postFilterUniverse;
  global.tmdbSearchUrl = tmdbSearchUrl;
  global.searchTmdb = searchTmdb;
  global.genreIdsFor = genreIdsFor;
  global.genreIdFor = genreIdFor;
  global.keywordIdFor = keywordIdFor;
  global.findByImdbId = findByImdbId;
  global.searchOneMovie = searchOneMovie;
  global.fetchCombinedCredits = fetchCombinedCredits;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      normalizeMulti, normalizeTyped, postFilterUniverse, tmdbSearchUrl, searchTmdb,
      findByImdbId, searchOneMovie, fetchCombinedCredits,
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
