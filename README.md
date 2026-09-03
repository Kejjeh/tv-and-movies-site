# Static UI

Vanilla HTML / CSS / JS. No build step, no bundler. Reads `data.json` (generated
by `scripts/export_to_json.py`) and runs the **five-dimension** scorer
client-side — `web/scorer.js`, a mirror of `brain/scoring.py` pinned to identical
numbers by a parity fixture (see `docs/adr/0002`). Scoring constants ship inside
`data.json`, so the JS never re-declares them — including the `weights` block,
which carries the learned weights (`data/learned_weights.json`) when they exist
and the hand weights otherwise.

## Pages

- `index.html` / `app.js` — recommendations + blind-spots
- `search.html` / `search.js` — catalogue + whole-TMDb-universe search
- `graph.html` / `graph.js` — seen-graph explorer
- `insights.html` / `insights.js` — taste analytics
- `discovery.html` / `discovery.js` — filmography-web explorer
- `confirm.html` / `confirm.js` — "Have you seen this?" confirm queue: nine
  tabs (Suggested, By creator, Franchises, Because you watched, Discover,
  Canon, Rate seen, Paste a list, Import a file) over one shared card
  renderer — see `docs/adr/0005`

Shared modules: `scorer.js`, `taste-profile.js`, `rating-map.js`, `status-store.js`,
`tmdb-search.js`, `import.js`, `paste.js`, `graph-edges.js`, `ui.js`, plus the
service worker `sw.js` (registered by `ui.js`). Data bundles: `data.json`,
`discovery.json` (+ slim `suggested.json`), `neighbors.json`, `probes.json`,
`lists.json`, `filmographies.json`.

`manifest.json` + `icon-192.png` / `icon-512.png` + `sw.js` make the site an
installable PWA. `vendor/` holds the pinned copies of supabase-js and
vis-network — the pages load them same-origin, with **no CDN at runtime** (see
`vendor/README.md`); it ships with everything else and must not be stripped from
the deploy. Every page references its shared assets at one identical `?v=`
version (currently `v=14`); `tests/js/cache-bust.test.js` fails the build if they
drift apart.

## Local preview

```
python scripts/export_to_json.py     # rebuild data.json
cd web && python -m http.server 8770  # open http://localhost:8770
```

(Or `.claude/launch.json`'s `web` config, which serves the same directory on
8770.)

(Opening `index.html` via `file://` won't work — `fetch` blocks local file URLs.)

Once a page has been loaded on `localhost:8770`, `sw.js` is registered for that
origin and stays registered. It is network-first, so a running dev server always
wins — but if the server is stopped or restarting, requests fall back to the
service worker's cache and you get the *previous* build back instead of a
connection error, which reads as "my edit didn't apply". If a change seems to
vanish, check the server is up, then unregister the worker under DevTools →
Application → Service Workers.

## Deployment

`.github/workflows/deploy-site.yml` publishes `web/` **verbatim** to
`Kejjeh/tv-and-movies-site` (GitHub Pages) on any push touching `web/**`. It does
**not** regenerate `data.json` — the committed bundle is what ships (the nightly
`reconcile.yml` is what refreshes it, and republishes `web/` itself afterwards).
One-time infra setup, secrets, and token rotation live in `../SETUP.md`.
