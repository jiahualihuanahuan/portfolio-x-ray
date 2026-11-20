# Portfolio X-ray

Break ETFs into the stocks, sectors and countries you actually own. It handles Canadian covered-call and fund-of-funds ETFs
(Harvest, Hamilton, Evolve, Purpose, BMO, Global X…) by looking through each layer. Extracted from Market Desk's Lookthru
(Portfolio tab) so it runs on its own.

```bash
git clone https://github.com/jiahualihuanahuan/portfolio-x-ray.git
cd portfolio-x-ray
docker compose up -d --build
```

Open `http://<this-machine>:8096` (change with `HOST_PORT=…`). Positions are stored in this browser only.

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

## Dev

`npm ci && npm run dev` (port 8080 in dev) · `npm test` · `npm run typecheck` · `npm run build`
