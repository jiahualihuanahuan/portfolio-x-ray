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
   - **Core–satellite model** (top of the tab): one *core* bucket of tickers with an acceptable range (e.g.
     HYOD.TO at 54–66%, midpoint 60%) and any number of *satellite* buckets (sector ETFs, Bitcoin, gold,
     miners…) with a target % each (e.g. four at 10%). A satellite can have its own relative band; otherwise
     the global band applies (10% → 9–11%), and the table says which. Percentages are of the total held in all
     buckets; holdings outside every bucket are listed but not traded.
   - Bucket rebalancing moves the **minimum** needed to bring each bucket to the **nearest edge** of its range
     (not to the target). *Sell & buy* greedily pairs the most overweight with the most underweight (if
     overweights free more than underweights need, the rest goes to buckets with the most room; if less, it
     comes from buckets with the most room above their minimum). *Buy-only* finds the smallest new cash that
     brings every bucket into range without selling, per bucket and in total.
   - Each bucket trade shows a C$ amount; with several tickers it shows a per-ticker split proportional to
     current holdings (labelled). If a multi-ticker bucket holds nothing, or has no tickers, it asks you to
     choose the ticker instead of guessing.
   - Validation errors: a ticker in more than one bucket (e.g. core and a satellite), more than one core,
     core min > max, core min + satellite targets > 100%, core max + satellite targets < 100%, or (without a
     core) satellite targets not adding up to 100%.
   - Filling buckets from your holdings: each bucket has a **From holdings** menu (Full portfolio tickers,
     largest first), the "Not in any bucket" list has an **Assign to…** menu per holding, and the Full
     portfolio **Positions** table has a **Classification** column (Unassigned / Core / each satellite by
     name). Picking a bucket moves the ticker there and out of every other bucket, so these controls never
     create duplicates; Unassigned removes it from all buckets. The comma-separated ticker box still works;
     a ticker typed into two buckets shows "Conflict" in the dropdown and the duplicate-ticker error remains
     until you pick one.
   - Holdings, targets, buckets, band and mode are shared across tabs and saved in this browser.

## Currency: everything in CAD

All amounts are in Canadian dollars (C$). Allocation, targets, deviation, core-satellite and rebalancing
all run on CAD values.

**Which holdings are USD.** A holding counts as USD when you say so or when its listing says so:
- a Currency column in a pasted broker CSV, or a US exchange (NYSE, NASDAQ, …);
- a trailing `USD` on a pasted line (`AAPL 10 USD`; `CAD` works the same way);
- a `.U` / `-U.TO` suffix (USD units of a Canadian ETF, priced from the USD listing);
- a bare ticker that only has a US listing (IBIT).

USD rows show a **USD** flag in the Positions table and in the holdings pickers.

**CDRs are CAD.** `.NE` (Cboe Canada, e.g. `AAPL.NE`) and `.UN` (e.g. `KO.UN`) are always CAD. They are
used at their listed value, never converted and never flagged. `.UN` is also used by REITs and trusts
(`REI.UN`), so the app does not map every `X.UN` to a US ticker. An underlying ticker ("CDR · KO") is
shown only for known CDRs: the quote name contains "CDR", or the ticker is in the CDR mapping file.
The bundled list is `src/lib/lookthru/cdr-map.default.json`. To add or override entries, copy it to
`/data/lookthru/cdr-map.json` (`CDR_MAP_FILE`) and edit it, e.g.
`"KO.UN": { "listing": "KO.NE", "underlying": "KO" }`. Changes are picked up within a minute.

**Which USD→CAD rate.** Each USD holding is converted at the rate for its price date. The first source
that has a rate wins:
1. `FX_USDCAD_OVERRIDE` (manual; labelled "manual").
2. `USDCAD=X` in `/data/lookthru/prices.sqlite` (`PRICES_DB_FILE`): the rate on the price date, or else
   the most recent one before it. The flag then says "rate from <date>". Live reads of `FX_PAIR` are
   written into this table, and the daily price prefetch fills it too.
3. The last saved rate in `/data/lookthru/fx-usdcad.json` (`FX_CACHE_FILE`), if it is not newer than
   the price date.

The app never guesses a rate or uses 1:1.

**Needs your confirmation.** In these cases the app flags the row instead of guessing:
- a USD-looking ticker that can't be matched to a price;
- a bare ticker that trades both in USD and in CAD (e.g. `AAPL` and `AAPL.NE`) with no suffix or
  currency given;
- a USD holding with no rate for its date.

These rows are listed under "Needs your confirmation" in Full portfolio, with buttons to pick CAD or USD
and a box to fix the ticker. Until you resolve them they are left out of every total, the allocation,
the targets and the rebalancing, and the Target & rebalance tab says so.

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
