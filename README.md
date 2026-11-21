# Portfolio X-ray

Break ETFs into the stocks, sectors and countries you actually own. It handles Canadian covered-call and fund-of-funds ETFs
(Harvest, Hamilton, Evolve, Purpose, BMO, Global X…) by looking through each layer. Extracted from Market Desk's Lookthru
(Portfolio tab) so it runs on its own.

```bash
git clone https://github.com/jiahualihuanahuan/portfolio-x-ray.git
cd portfolio-x-ray
docker compose up -d --build
```

Open `http://<this-machine>:8097` (change with `HOST_PORT=…`; the default avoids 8096, which Jellyfin uses). The container still listens on 8096 internally. Positions, targets and settings are stored in this browser only (localStorage).

## Settings (.env)

Every setting is optional. Copy the template and edit it:

```bash
cp .env.example .env    # .env is gitignored; never commit it
docker compose up -d --build
```

`.env.example` lists every variable the app reads, with a one-line comment each (Ollama, FX, rebalance
default, ports, data/cache paths, background fetch timing, ETF-notes script). docker-compose loads `.env`
through `env_file` with `required: false` (Docker Compose 2.24+), so the app starts without it.
Put your own LAN addresses only in `.env`.

## Tabs

1. **ETF breakdown** — pick one ETF and an amount in C$ (default C$10,000). Shows only that fund's
   holdings, unrolled through every fund-of-funds layer to single stocks with the same look-through engine
   (leverage shows as negative cash). Includes KPIs, Forward P/E, sector/country mix, an
   **Ask about this ETF** panel (local Ollama, below) and, folded away, the one-layer Fund details
   (direct holdings, total-return chart, valuation).
2. **Full portfolio** — add many tickers with share counts (or paste a list). Everything is broken down to
   individual stocks; sub-tabs for Look-through, Positions and Nested tree.
3. **Target & rebalance** — set targets in C$ per ticker and/or per sector.
   - Deviation is relative: `|actual − target| ÷ target`. A row is flagged when it is **more than** the
     alert band (default 10%, editable in the tab; server default `REBALANCE_THRESHOLD_PCT`). A target of 0
     with any holding is always flagged.
   - **Ticker** targets compare with the value of the position held directly in that ticker (Full portfolio
     tab). If the ticker is only held inside ETFs, its look-through exposure is shown for reference.
   - **Sector** targets compare with look-through sector exposure (all ETFs unrolled).
   - Only flagged rows get a suggested trade, sized to return that row exactly to target.
     *Sell & buy*: sell overweight, buy underweight; the footer shows total sells, buys and the net new cash
     needed (or cash freed). *Buy-only*: buys for underweight rows with new cash, never sells; overweight
     rows stay as they are and the footer shows the cash needed.
   - Ticker and sector targets are two separate views. If both apply to the same money, both are shown and
     neither takes priority.
   - Holdings, targets, band and mode are shared across tabs and saved in this browser.

## Currency: everything in CAD

All amounts are in Canadian dollars (shown as C$). USD-priced securities are converted with the live Yahoo
`USDCAD=X` rate (`FX_PAIR`), refreshed every 5 minutes and saved to `/data/lookthru/fx-usdcad.json`
(`FX_CACHE_FILE`). The header shows the rate, whether it is live, cached or manual, and when it was
fetched (Toronto time). If Yahoo is unreachable the last saved rate is used. If there is no saved rate either,
the app shows an error instead of guessing a rate. Set `FX_USDCAD_OVERRIDE=1.37` to use a fixed rate
instead; the header then labels it "manual". The Positions table shows the CAD price with the original
USD quote beneath it.

## Ask about this ETF (local Ollama)

The ETF breakdown tab can answer questions such as "what does BMAX do?" using a local
[Ollama](https://ollama.com) model. The server (`POST /api/ask`) sends Ollama `/api/chat` (streaming) a
system prompt built from that ETF's look-through: name, provider, as-of date and source, top holdings with
weights, sector mix, cash/leverage, the funds it holds and any partial-coverage caveats. The model is told
to answer only from that data and to say when it doesn't know. `<think>` blocks (qwen) are removed.

```bash
# .env
OLLAMA_URL=http://host.docker.internal:11434   # Ollama on the Docker host, or http://<your-ollama-host>:11434
OLLAMA_MODEL=qwen3.5:9b
```

`docker-compose.yml` maps `host.docker.internal` to the host (`extra_hosts: host-gateway`). If Ollama runs on
the Docker host itself, start it with `OLLAMA_HOST=0.0.0.0` so the container can reach it. If `OLLAMA_URL` is
unset, unreachable or the model is missing, the panel says so; the rest of the app is unaffected.

Data: a pre-scraped holdings file if you provide one, then the issuers' public holdings pages and Yahoo Finance (unofficial).
No API keys, no accounts. Not investment advice.

## Settings (.env)

Every setting is optional. Copy the template and edit it; `.env` is gitignored and never committed:

```bash
cp .env.example .env
```

`docker compose` reads `.env` for the `${...}` defaults and loads it into the container through an optional `env_file`
(Docker Compose 2.24+), so the app also starts without it. `.env.example` lists every variable the app reads, with a
one-line comment each: port, Ollama, the USD→CAD source and manual override, the default rebalance band, data/cache
paths, background jobs and the Brompton fetch delay.

## Tabs

1. **ETF breakdown** — pick one fund (search box with autocomplete) and an amount in C$ (default C$10,000). Shows only
   that fund's underlying holdings, unrolled through every fund-of-funds layer by the same look-through engine as the
   portfolio (Brompton BMAX via bromptongroup.com, index caches, leverage as negative cash). Includes the Forward P/E,
   sector and country mix, an **Ask about this ETF** panel (local Ollama, below) and, folded away, the old Fund Lookup
   details: the fund's own one-layer holdings with drill-down, total-return chart and valuation card.
2. **Full portfolio** — add many tickers with share counts (or paste a Wealthsimple CSV). Everything is broken down to
   single stocks: KPIs incl. look-through Forward P/E, charts, Look-through / Positions / Nested tree. This is the
   previous main view.
3. **Target & rebalance** — set targets in C$ by **ticker** and/or by **sector** and get an alert when anything drifts.
   - Ticker targets compare with the value of the position you hold directly in that ticker (Full portfolio tab).
     Sector targets compare with look-through sector exposure (all ETFs unrolled).
   - Deviation is relative: `|actual − target| / target`. A row is flagged when it is **more than** the band
     (default 10%, editable in the tab; server default `REBALANCE_THRESHOLD_PCT`). A target of 0 flags any holding.
   - Only flagged rows get a trade, sized to bring that row back to exactly its target. **Sell & buy** mode sells
     overweight and buys underweight rows and shows the net new cash needed (or freed). **Buy-only** mode only buys
     underweight rows with new cash and never sells; overweight rows are shown but left alone.
   - If a ticker target and a sector target both touch the same holding, both views are shown separately; there is
     no priority rule. Ticker trades show an approximate share count at the current C$ price.

Holdings, the picked ETF, targets, band and mode are shared across tabs and saved in this browser (localStorage).

## Currency: everything in CAD

All amounts — prices, values, targets and trades — are in Canadian dollars (shown as `C$`). Targets you type are CAD.
USD-priced securities are converted at the live Yahoo `USDCAD=X` rate (`FX_PAIR`; falls back to `CAD=X`), cached for
5 minutes in memory and on disk at `/data/lookthru/fx-usdcad.json` (`FX_CACHE_FILE`). The header shows the rate, whether
it is live, cached or manual, and when it was fetched (Toronto time). Set `FX_USDCAD_OVERRIDE=1.37` to force a manual rate.
If Yahoo is unreachable and no cached rate exists, the app shows an error instead of assuming 1:1 or a fixed rate
(books that hold only CAD listings still work).

## Ask about this ETF (local Ollama)

The ETF breakdown tab has a Q&A panel ("what does BMAX do?"). The server calls Ollama `/api/chat` with streaming and a
system prompt built from the fund's look-through: top holdings with weights, sector mix, cash/leverage, child funds,
as-of date, source, coverage and provider. The model is told to answer only from that data and to say when it doesn't
know. `<think>` blocks (qwen) are stripped. Nothing leaves your network except the Ollama call you configure.

```bash
# .env
OLLAMA_URL=http://host.docker.internal:11434   # Ollama on the Docker host, or http://<your-ollama-host>:11434
OLLAMA_MODEL=qwen3.5:9b
```

`docker-compose.yml` maps `host.docker.internal` to the host gateway. If Ollama runs on the host, start it with
`OLLAMA_HOST=0.0.0.0` so the container can reach it. If `OLLAMA_URL` is unset, unreachable, slow (`OLLAMA_TIMEOUT_MS`)
or missing the model, the panel shows a clear message instead of failing.

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

The ETF breakdown ticker box can autocomplete tickers from `/data/lookthru/tickers.json` (override with
`LOOKTHRU_TICKERS_FILE`; it defaults next to the holdings file). If that file is missing, it falls
back to the fund keys in holdings.json. Price history for the total-return chart is cached in
`/data/lookthru/prices.sqlite` (`PRICES_DB_FILE`), filled on demand and by a background prefetch
at startup and around 6 PM America/Toronto. Disable the job with `PRICES_PREFETCH=0`. Run it once
with `npm run prefetch`.


## Brompton funds (BMAX and its children)

Brompton publishes each ETF's quarterly top 25 holdings by name on bromptongroup.com. The app fetches
BMAX, BFIN, TLF, BGIE, BDIV, BLOV, EDGF, HIG, SPLT, BPRF and BAAA from there in the background at
startup and re-checks daily (entries are kept 7 days; tune with `PROVIDER_REFRESH_HOURS` and `PROVIDER_CACHE_TTL_HOURS`). It honours the site's 10 s crawl delay (`PROVIDER_FETCH_DELAY_MS` can only raise it), so a full
pass takes about two minutes. Results are cached in `/data/lookthru/provider-holdings/` (override with
`LOOKTHRU_PROVIDER_DIR`), never in git. Company names are matched to tickers from the catalog, the
holdings file, then a cached Yahoo search (`name-tickers.json` in the same folder).

BMAX's page lists weights as % of portfolio. The app reads its borrowing from the linked Portfolio Summary PDF
(`pdftotext`, included in the Docker image) and books it as negative cash, so the weights become % of NAV
and still add up to 100%. Preferred shares and CLO tranches show as named fixed-income lines (`FI`).
Any part of a fund the issuer doesn't name shows as OTHER, and the look-through prints a partial-coverage
warning with the percentage. Turn the background fetch off with `PROVIDER_HOLDINGS_PREFETCH=0`. To force
a refresh, delete the cache folder and restart the container.

## ETF notes (homelab)

Draft one paragraph per fund from the local holdings file, the SQLite price cache, optional
SearXNG snippets, and a local Ollama model. Output is `/data/lookthru/etf-notes.md` (grouped
by provider, with source URLs under each paragraph) plus `etf-notes.json`. Neither file is
committed. Nothing is posted.

Settings (set them in `.env`; the script defaults are localhost):

- `OLLAMA_URL` — your Ollama, e.g. `http://<your-ollama-host>:11434` (compose default `http://host.docker.internal:11434`)
- `OLLAMA_MODEL=qwen3.5:9b`
- `SEARCH_URL` — your SearXNG, e.g. `http://<your-searxng-host>:8099` (not port 8080, which is Market Desk)
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
