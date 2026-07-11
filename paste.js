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

  global.parsePaste = parsePaste;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parsePaste };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
