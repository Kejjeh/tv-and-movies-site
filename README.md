# Static UI

Vanilla HTML / CSS / JS. No build step, no bundler. Reads `data.json` (generated
by `scripts/export_to_json.py`) and runs the **five-dimension** scorer
client-side — `web/scorer.js`, a mirror of `brain/scoring.py` pinned to identical
numbers by a parity fixture (see `docs/adr/0002`). Scoring constants ship inside
`data.json`, so the JS never re-declares them.

## Pages

- `index.html` / `app.js` — recommendations + blind-spots
- `search.html` / `search.js` — catalogue + whole-TMDb-universe search
- `graph.html` / `graph.js` — seen-graph explorer
- `insights.html` / `insights.js` — taste analytics
- `discovery.html` / `discovery.js` — filmography-web explorer
- `confirm.html` / `confirm.js` — "Have you seen this?" confirm queue + CSV import

Shared modules: `scorer.js`, `taste-profile.js`, `rating-map.js`, `status-store.js`,
`tmdb-search.js`, `import.js`, `ui.js`. Data bundles: `data.json`,
`discovery.json` (+ slim `suggested.json`), `neighbors.json`, `probes.json`,
`filmographies.json`.

## Local preview

```
python scripts/export_to_json.py     # rebuild data.json
cd web && python -m http.server 8770  # open http://localhost:8770
```

(Opening `index.html` via `file://` won't work — `fetch` blocks local file URLs.)

## Deployment

`.github/workflows/deploy-site.yml` publishes `web/` **verbatim** to
`Kejjeh/tv-and-movies-site` (GitHub Pages) on any push touching `web/**`. It does
**not** regenerate `data.json` — the committed bundle is what ships (the nightly
`reconcile.yml` is what refreshes it). One-time infra setup, secrets, and token
rotation live in `../SETUP.md`.
