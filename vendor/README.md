# Vendored browser dependencies

These two libraries were previously loaded from CDNs (`cdn.jsdelivr.net`,
`unpkg.com`). They're now committed here so the site has **no runtime CDN
dependency** — consistent with the repo's committed-artifacts philosophy
(ADR 0001) — and so a floating tag or CDN incident can't silently ship
different/compromised JS into the pages that handle the Supabase auth session.

| File | Source | Loaded by |
|------|--------|-----------|
| `supabase-js-2.110.0.min.js` | `@supabase/supabase-js@2.110.0` (jsdelivr UMD) — was the floating `@2` tag | index / search / confirm |
| `vis-network-9.1.10.min.js` | `vis-network@9.1.10` standalone/umd (unpkg) | graph / discovery |

Same-origin, so no Subresource Integrity attributes are needed (SRI guards
cross-origin CDN loads, which no longer exist here).

## Updating

To bump a version, download the exact pinned build and repoint the `<script>`
tags:

```bash
# supabase-js (pick the version; do NOT use a floating @2)
curl -sSL -o web/vendor/supabase-js-<VER>.min.js \
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<VER>"

# vis-network (must be the standalone/umd build — it bundles its deps)
curl -sSL -o web/vendor/vis-network-<VER>.min.js \
  "https://unpkg.com/vis-network@<VER>/standalone/umd/vis-network.min.js"
```

Then update the `src=` in the HTML pages listed above and delete the old file.
Review the diff before committing — that's the whole point of vendoring.
