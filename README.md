# open-models

Open-weight LLMs, sortable, with a "what fits on my hardware?" filter.

- `scripts/build-models.js` pulls Hugging Face + OpenRouter into `data/models.json` (no dependencies).
- `.github/workflows/update.yml` runs it daily and commits if the data changed. Failures are swallowed on purpose; the last good file stays.
- `index.html` is the whole UI. Serve with GitHub Pages from `main` / root.

Run locally: `node scripts/build-models.js`, then open `index.html` through any static server.
