/* Shared UI primitives for the static pages.
 *
 * The pages are classic <script> tags (no bundler), so this file exposes its
 * helpers as globals AND as CommonJS exports so they can be unit-tested under
 * `node --test`. Load it before any page script:
 *
 *     <script src="ui.js"></script>
 *     <script src="app.js"></script>
 */
(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // " (2010)" for a truthy year, "" otherwise — matches the inline template
  // literals the pages used to repeat.
  function formatYear(year) {
    return year ? ` (${year})` : "";
  }

  // Resolve a narrative id to its human label, falling back to the id itself.
  function narrativeLabel(narratives, id) {
    const found = (narratives || []).find(n => n.id === id);
    return found ? found.label : id;
  }

  // map[key] when present, otherwise the fallback colour.
  function colorFor(map, key, fallback) {
    return (map && map[key] != null) ? map[key] : fallback;
  }

  // Capitalise the first letter of each word (hyphen counts as a boundary):
  // "animation-dark" -> "Animation-Dark".
  function titleCase(s) {
    return String(s || "").replace(/\b\w/g, c => c.toUpperCase());
  }

  const UI = { escapeHtml, formatYear, narrativeLabel, colorFor, titleCase };

  // Browser globals (classic scripts).
  global.escapeHtml = escapeHtml;
  global.formatYear = formatYear;
  global.narrativeLabel = narrativeLabel;
  global.colorFor = colorFor;
  global.titleCase = titleCase;
  global.UI = UI;

  // Register the service worker (installable PWA + offline shell). Browser
  // only, best-effort — never blocks or throws into page code.
  if (global.document && global.navigator && "serviceWorker" in global.navigator) {
    global.addEventListener("load", () => {
      global.navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // Node / test harness.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = UI;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
