# Portfolio X-ray

Break ETFs into the stocks, sectors and countries you actually own. It handles Canadian covered-call and fund-of-funds ETFs
(Harvest, Hamilton, Evolve, Purpose, BMO, Global X…) by looking through each layer. Extracted from Market Desk's Lookthru
(Portfolio tab) so it runs on its own.

```bash
git clone https://github.com/jiahualihuanahuan/portfolio-x-ray.git
cd portfolio-x-ray
docker compose up -d --build
```

Open `http://<this-machine>:8097` (change with `HOST_PORT=…`; the default avoids 8096, which Jellyfin uses). The container still listens on 8096 internally. Positions are stored in this browser only.

Data: a pre-scraped holdings file if you provide one, then the issuers' public holdings pages and Yahoo Finance (unofficial).
No API keys, no accounts. Not investment advice.

## Pre-scraped holdings (optional)

The app first reads `/data/lookthru/holdings.json` (override with `LOOKTHRU_HOLDINGS_FILE`), then falls back to its cache
and the live issuer pages. It re-reads the file whenever it changes and works as before if the file is missing. The file
comes from `covered-call-holdings/scrape.py` (Canadian covered-call / income ETFs). It lives in the `portfolio-x-ray-data`
volume and is never committed.

```bash
docker compose exec portfolio-x-ray mkdir -p /data/lookthru
docker compose cp <path>/lookthru/holdings.json portfolio-x-ray:/data/lookthru/holdings.json
```

Format: `{"funds": {"HMAX.TO": {"asOf": "2026-10-30", "holdings": [{"symbol": "RY.TO", "name": "...", "weight": 0.245, "sector": "..."}]}}}`,
with weights as fractions (0.245 = 24.5%).

The Fund Lookup tab can autocomplete tickers from `/data/lookthru/tickers.json` (override with
`LOOKTHRU_TICKERS_FILE`; it defaults next to the holdings file). If that file is missing, it falls
back to the fund keys in holdings.json. Price history for the total-return chart is cached in
`/data/lookthru/prices.sqlite` (`PRICES_DB_FILE`), filled on demand and by a background prefetch
at startup and around 6 PM America/Toronto. Disable the job with `PRICES_PREFETCH=0`. Run it once
with `npm run prefetch`.


## ETF notes (homelab)

Draft one paragraph per fund from the local holdings file, the SQLite price cache, optional
SearXNG snippets, and a local Ollama model. Output is `/data/lookthru/etf-notes.md` (grouped
by provider, with source URLs under each paragraph) plus `etf-notes.json`. Neither file is
committed. Nothing is posted.

Defaults, used from both the container and the host on the LAN:

- `OLLAMA_URL=http://192.168.86.35:11434`
- `OLLAMA_MODEL=qwen3.5:9b`
- `SEARCH_URL=http://192.168.86.35:8099` (SearXNG — not port 8080, which is Market Desk)
- `SEARCH_ENGINE=searxng`

Set `FETCH_PAGES=1` to fetch the provider page and include up to 2,000 characters in the prompt.
If SearXNG returns 403 or HTML, enable JSON in its `settings.yml` (`search: formats: [html, json]`).
If the response looks like another app, `SEARCH_URL` is probably pointed at the wrong port.
The script warns and continues without search in either case.

The run is resumable: tickers already in `etf-notes.json` are skipped unless you pass `--force`.
Other options: `--limit N`, `--only TICKER`, `--provider NAME`.

Via Docker (service name `portfolio-x-ray`):

```bash
docker compose exec portfolio-x-ray npm run etf-notes
docker compose exec portfolio-x-ray npm run etf-notes -- --only HHIS.TO
docker compose exec portfolio-x-ray npm run etf-notes -- --force --limit 5 --provider Harvest
```

From the host, in this repo (same LAN defaults; point the data paths at your look-through volume
if it is not already at `/data/lookthru`):

```bash
LOOKTHRU_HOLDINGS_FILE=/data/lookthru/holdings.json \
PRICES_DB_FILE=/data/lookthru/prices.sqlite \
npm run etf-notes

LOOKTHRU_HOLDINGS_FILE=/data/lookthru/holdings.json \
PRICES_DB_FILE=/data/lookthru/prices.sqlite \
npm run etf-notes -- --only HHIS.TO
```

## Dev

`npm ci && npm run dev` (port 8080 in dev) · `npm test` · `npm run typecheck` · `npm run build`
