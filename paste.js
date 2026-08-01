/* Paste parser — turns a freeform pasted list into structured entries:
 *   {query, year, status, rated}
 * The confirm page resolves each query to TMDb and writes a status. Kept as a
 * pure function (browser global + CommonJS export) so it's unit-tested under
 * `node --test`, mirroring web/import.js.
 */
(function (global) {
  "use strict";

  // Status words accepted after a "|" or "-" separator. "seen" is the UI label
  // for the default 'ok' (see CONTEXT.md), so it maps there.
  const STATUS_WORDS = {
    loved: "loved", liked: "liked", ok: "ok", seen: "ok",
    started: "started", disliked: "disliked", hated: "hated",
  };
  const STATUS_RE = new RegExp(
    "\\s*[|-]\\s*(" + Object.keys(STATUS_WORDS).join("|") + ")\\s*$", "i"
  );

  function extractStatus(line) {
    const m = line.match(STATUS_RE);
    if (!m) return { rest: line, status: "ok", rated: false };
    return { rest: line.slice(0, m.index).trim(), status: STATUS_WORDS[m[1].toLowerCase()], rated: true };
  }

  function extractYear(query) {
    // "Title (2021)" — parens are an explicit hint, always honoured.
    const paren = query.match(/\((\d{4})\)\s*$/);
    if (paren) return { query: query.slice(0, paren.index).trim(), year: Number(paren[1]) };
    // "Title 2021" — a bare trailing 4-digit number is a year only when it's a
    // plausible release year; otherwise it's part of the title (Blade Runner 2049).
    const bare = query.match(/\s(\d{4})$/);
    if (bare) {
      const y = Number(bare[1]);
      const max = new Date().getFullYear() + 1;
      if (y >= 1900 && y <= max) return { query: query.slice(0, bare.index).trim(), year: y };
    }
    return { query, year: null };
  }

  function parseLine(line) {
    const { rest, status, rated } = extractStatus(line);
    const { query, year } = extractYear(rest);
    return { query, year, status, rated };
  }

  function parsePaste(text) {
    const entries = String(text || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(parseLine);
    // Dedupe by (lowercased query, year); a later line supersedes an earlier
    // one, so a rating added below a bare mention wins.
    const byKey = new Map();
    for (const e of entries) byKey.set(`${e.query.toLowerCase()}|${e.year}`, e);
    return [...byKey.values()];
  }

  /* resolvePaste — the decide-and-write core behind "Add these".

     Kept here (pure, dependency-injected) rather than in confirm.js so the
     guard logic is unit-tested; confirm.js only wires the real search /
     StatusStore / DOM progress line into `deps`:
       {search, knownKeys, seenKeys, queueAdd, setStatus, importSource,
        onProgress?, pace?}
     Returns {added, updated, skipped, unmatched, failed}. */
  async function resolvePaste(entries, deps) {
    const counts = { added: 0, updated: 0, skipped: 0, unmatched: 0, failed: 0 };
    let done = 0;
    for (const e of entries) {
      done++;
      try {
        const { results } = await deps.search(e.query);
        const k = hit => `${hit.tmdb_id}|${hit.kind}`;
        // Only results whose TITLE matched the query. /search/multi expands
        // matching PEOPLE into their known-for titles (direct: false) — a
        // pasted director's name must not mark their films seen. Results
        // from a source that doesn't tag direct (typed search) all pass.
        const direct = (results || []).filter(r => r.direct !== false);
        let hit = direct[0];
        if (e.year) {
          const y = direct.find(r => r.year === e.year);
          if (y) hit = y;
        }
        if (!hit) { counts.unmatched++; }
        else if (!e.rated && deps.seenKeys.has(k(hit))) {
          // Already seen with a status we trust — a bare "watched" mention
          // must not downgrade it (mirror of import.js's seenKeys guard).
          counts.skipped++;
        } else {
          // Rated entries carry 'manual' (taste-bearing); bare "seen" entries
          // a passive 'manual-watched' so a big paste can't wash the profile.
          const source = deps.importSource("manual", e.rated ? 1 : null);
          const kk = k(hit);
          const wasKnown = deps.knownKeys.has(kk);
          if (!wasKnown) await deps.queueAdd(hit.tmdb_id, hit.kind, hit.name);
          await deps.setStatus(hit.tmdb_id, hit.kind, e.status, source);
          // Book-keeping only AFTER the durable write: a failure mid-pair
          // must not leave phantom counts or a poisoned knownKeys that makes
          // a retry report "updated" for a title that never landed.
          if (wasKnown) counts.updated++;
          else { deps.knownKeys.add(kk); counts.added++; }
          // The title is seen NOW — a bare duplicate later in this run (or a
          // second paste this session) must skip, not downgrade it.
          deps.seenKeys.add(kk);
          if (deps.onWrite) deps.onWrite(hit);
        }
      } catch (_) { counts.failed++; }
      if (deps.onProgress) deps.onProgress(done, entries.length, counts);
      if (deps.pace) await deps.pace();
    }
    return counts;
  }

  global.parsePaste = parsePaste;
  global.resolvePaste = resolvePaste;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parsePaste, resolvePaste };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
