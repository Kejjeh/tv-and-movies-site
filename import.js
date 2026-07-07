/* Client-side watch-history import (IMDb ratings export, Letterboxd export).
 *
 * The pure parsing/mapping (parseCsv, detectFormat, imdbRows, letterboxdRows)
 * is unit-tested under node; the browser half resolves each row to a TMDb id,
 * maps its rating to a status via rating-map.js, and writes to Supabase
 * (queue + statuses) through StatusStore. 100% true-positive: an IMDb export
 * carries the exact imdb_id, so /find resolves it without fuzzy matching.
 *
 * Global for classic <script> pages; CommonJS export for `node --test`.
 */
(function (global) {
  "use strict";

  // Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
  // newlines inside quotes, and "" escapes. Returns an array of row objects
  // keyed by the header row.
  function parseCsv(text) {
    const rows = [];
    let field = "", record = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else { field += c; }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        record.push(field); field = "";
      } else if (c === "\r") {
        /* ignore — handled by \n */
      } else if (c === "\n") {
        record.push(field); rows.push(record); record = []; field = "";
      } else {
        field += c;
      }
    }
    if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record); }
    if (rows.length === 0) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1)
      .filter(r => r.some(x => (x || "").trim() !== ""))
      .map(r => {
        const o = {};
        headers.forEach((h, idx) => { o[h] = (r[idx] != null ? r[idx] : "").trim(); });
        return o;
      });
  }

  // Which export is this? IMDb rows carry a `Const` (ttXXXXXXX); Letterboxd
  // rows carry a `Letterboxd URI` or a Name+Year pair.
  function detectFormat(records) {
    if (!records.length) return null;
    const keys = Object.keys(records[0]).map(k => k.toLowerCase());
    if (keys.includes("const")) return "imdb";
    if (keys.includes("letterboxd uri") || (keys.includes("name") && keys.includes("year"))) {
      return "letterboxd";
    }
    return null;
  }

  function _titleTypeToKind(t) {
    const s = (t || "").toLowerCase();
    if (s.includes("series") || s.includes("mini")) return "tv";
    if (s === "movie" || s.includes("tvmovie") || s.includes("video")) return "movie";
    return null;  // episodes / games / unknown — let /find decide, else skip
  }

  // Normalize IMDb export rows to {imdbId, rating, kind, name}. Rating is the
  // user's 1-10 "Your Rating" (null on a plain watchlist/list export).
  function imdbRows(records) {
    const out = [];
    for (const r of records) {
      const imdbId = (r.Const || r.const || "").trim();
      if (!/^tt\d+/.test(imdbId)) continue;
      const rawRating = r["Your Rating"];
      const rating = (rawRating != null && rawRating !== "") ? Number(rawRating) : null;
      out.push({
        imdbId,
        rating: Number.isFinite(rating) ? rating : null,
        kind: _titleTypeToKind(r["Title Type"]),
        name: r.Title || r["Original Title"] || imdbId,
      });
    }
    return out;
  }

  // Normalize Letterboxd export rows to {name, year, rating}. Letterboxd is
  // film-only; Rating is 0.5-5.0 stars (absent in watched.csv, present in
  // ratings.csv).
  function letterboxdRows(records) {
    const out = [];
    for (const r of records) {
      const name = (r.Name || r.name || "").trim();
      if (!name) continue;
      const year = r.Year ? Number(r.Year) : null;
      const rawRating = r.Rating;
      const rating = (rawRating != null && rawRating !== "") ? Number(rawRating) : null;
      out.push({
        name,
        year: Number.isFinite(year) ? year : null,
        rating: Number.isFinite(rating) ? rating : null,
      });
    }
    return out;
  }

  const API = { parseCsv, detectFormat, imdbRows, letterboxdRows };

  /* ====== Browser wiring ====== */
  if (global.document) {
    const sleep = ms => new Promise(res => setTimeout(res, ms));

    // Mount the importer into `root`. opts: { knownKeys:Set, isLoggedIn:fn,
    // onImported:fn(key,status) }. Resolves each parsed row to TMDb, maps the
    // rating to a status, and writes queue + status to Supabase.
    API.init = function initImport(root, opts) {
      opts = opts || {};
      const knownKeys = opts.knownKeys || new Set();
      // Titles already marked seen — we don't overwrite their existing status
      // (which may be a hand-curated rating). Everything else, including titles
      // already tracked as unseen CANDIDATES, still gets its imported status.
      const seenKeys = opts.seenKeys || new Set();
      const isLoggedIn = opts.isLoggedIn || (() => false);
      root.innerHTML =
        `<p class="import-help">Drop an <strong>IMDb ratings export</strong> ` +
        `(<code>ratings.csv</code>, most accurate — carries exact IDs) or a ` +
        `<strong>Letterboxd</strong> <code>ratings.csv</code>/<code>watched.csv</code>. ` +
        `Your rating maps to a status; unrated rows land as “seen”.</p>` +
        `<input type="file" id="import-file" accept=".csv,text/csv">` +
        `<div id="import-log" class="import-log"></div>`;
      const logEl = root.querySelector("#import-log");
      const log = msg => { logEl.textContent = msg; };

      root.querySelector("#import-file").addEventListener("change", async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!isLoggedIn()) { log("Log in (top right) before importing."); return; }
        const text = await file.text();
        const records = parseCsv(text);
        const fmt = detectFormat(records);
        if (!fmt) { log("Unrecognized CSV — need an IMDb or Letterboxd export."); return; }

        const rows = fmt === "imdb" ? imdbRows(records) : letterboxdRows(records);
        let done = 0, added = 0, skipped = 0, unmatched = 0;
        for (const row of rows) {
          done++;
          try {
            let hit = null, status = null;
            if (fmt === "imdb") {
              hit = await global.findByImdbId(row.imdbId);
              status = global.statusFromTen(row.rating);
            } else {
              hit = await global.searchOneMovie(row.name, row.year);
              status = global.statusFromFive(row.rating);
            }
            // Unrated rows carry a passive `<fmt>-watched` provenance so they
            // count as seen but don't calibrate the taste profile.
            const source = global.importSource(fmt, row.rating);
            if (!hit) { unmatched++; }
            else {
              const key = `${hit.tmdb_id}|${hit.kind}`;
              if (seenKeys.has(key)) {
                // Already seen with a status we trust — don't clobber it.
                skipped++;
              } else {
                // Only queue titles brain.db doesn't track yet; but ALWAYS
                // write the status, so a title already tracked as an unseen
                // candidate finally gets its rating (the old code silently
                // dropped exactly these).
                if (!knownKeys.has(key)) {
                  await global.StatusStore.queueAdd(hit.tmdb_id, hit.kind, hit.name);
                  knownKeys.add(key);
                }
                await global.StatusStore.setStatus(hit.tmdb_id, hit.kind, status, source);
                seenKeys.add(key);
                added++;
                if (opts.onImported) opts.onImported(key, status);
              }
            }
          } catch (err) {
            unmatched++;
          }
          if (done % 5 === 0 || done === rows.length) {
            log(`${done}/${rows.length} · ${added} rated · ${skipped} already seen · ${unmatched} unmatched`);
          }
          await sleep(260);  // ~4 req/sec, under TMDb's ceiling
        }
        log(`Done: ${added} rated, ${skipped} already seen, ${unmatched} unmatched. ` +
          `Run “Reconcile now” to bake them in.`);
      });
    };
  }

  global.Import = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
