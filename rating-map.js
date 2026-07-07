/* Canonical rating -> status mapping + provenance rule. Mirror of
 * brain/rating_map.py. Turns any external rating scale into one of the six
 * statuses, and decides which imported titles may calibrate the taste profile.
 *
 * Global for classic <script> pages; CommonJS export for `node --test`.
 */
(function (global) {
  "use strict";

  const STATUS_DEFAULT = "ok";
  // Ratingless "watched" sources — a title imported this way defaults to 'ok'
  // and must not calibrate taste. The `*-watched` tags are written by the CSV
  // importer for UNRATED rows; the same platform WITH a rating uses its plain
  // tag and stays taste-bearing. Mirror of brain/rating_map.py PASSIVE_SOURCES.
  const PASSIVE_SOURCES = new Set([
    "netflix", "letterboxd-watched", "imdb-watched", "trakt-watched",
  ]);

  // The provenance tag to record for an imported row: unrated rows are passive
  // (a bulk "watched" mark), rated rows carry the plain platform tag.
  function importSource(format, rating) {
    return rating == null ? `${format}-watched` : format;
  }

  // 0-10 (IMDb / TMDb / Trakt): >=9 loved, 7-8 liked, 5-6 ok, 3-4 disliked, <3 hated.
  // A missing rating is a passive "watched" mark -> ok.
  function statusFromTen(rating) {
    if (rating == null) return STATUS_DEFAULT;
    const r = Number(rating);
    if (r >= 9) return "loved";
    if (r >= 7) return "liked";
    if (r >= 5) return "ok";
    if (r >= 3) return "disliked";
    return "hated";
  }

  // Letterboxd 0.5-5.0 stars, doubled onto the 10-pt scale.
  function statusFromFive(rating) {
    if (rating == null) return STATUS_DEFAULT;
    return statusFromTen(Number(rating) * 2);
  }

  // Letterboxd stars -> the brain's optional 1-10 personal rating.
  function personalRatingFromFive(rating) {
    if (rating == null) return null;
    return Math.round(Number(rating) * 2);
  }

  // Whether a seen title may calibrate the taste profile. Everything is
  // taste-bearing except a passive 'ok' watch from a ratingless source.
  function isTasteBearing(status, source) {
    return !(
      (status || STATUS_DEFAULT) === STATUS_DEFAULT && PASSIVE_SOURCES.has(source)
    );
  }

  const API = {
    statusFromTen, statusFromFive, personalRatingFromFive, isTasteBearing,
    importSource, PASSIVE_SOURCES,
  };
  global.RatingMap = API;
  global.statusFromTen = statusFromTen;
  global.statusFromFive = statusFromFive;
  global.isTasteBearing = isTasteBearing;
  global.importSource = importSource;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
