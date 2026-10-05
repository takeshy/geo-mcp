# Geo MCP

English | [日本語](README_ja.md)

Place search using self-hosted OpenStreetMap data and reverse geocoding using GeoNames. Production runs on a shared 4 GiB Compute Engine VM with routing and API Gateway disabled.

## Tools

- `reverse_geocode`: Returns the nearest town or village worldwide and its straight-line distance from the supplied latitude and longitude. Uses only a self-hosted GeoNames index, with no external API calls.
- `place_search`: Searches by place name, category, or proximity. Returns results sorted by distance, along with opening hours and addresses.
- `route`: Returns distance and travel time for driving (`driving`) and walking (`walking`). Optional for the legacy configuration; not exposed in production.

The examples below show inputs and outputs when using self-hosted data. Place names, coordinates, distances, and travel times are illustrative. Responses show the MCP `structuredContent` field (`content` also includes explanatory text and reference links).

### reverse_geocode

Input: `{"lat":35.6812,"lng":139.7671,"language":"ja"}`. `language` accepts `ja` (Japanese) or `en` (English), and defaults to `en`. This setting applies to place names; explanatory text remains in Japanese.

Searches for the nearest populated place in GeoNames and returns a “near [place name]” description and the distance to its registered coordinates. There is no minimum population threshold, so small towns and villages are included. Historical settlements, abandoned settlements, and district-level records are excluded. The GeoNames alternate name in the requested language takes priority; otherwise, the original `name` is used (for example, `大豆戸町付近です。`). Display text omits the country code, while `structuredContent.place.countryCode` is retained.

`structuredContent` includes `found`, `approximate: true`, `method: "nearest_settlement"`, `source: "local"`, and `provider: "geonames"`. When a place is found, `place` includes `name`, `countryCode`, `admin1Code` (state or prefecture code), `lat`, `lng`, `geonameId`, and `distanceMetres`. `place.administrativeAreas` includes the corresponding administrative areas’ `level` (1–4), `geonameId`, and `name` in the requested language. City, ward, and other administrative names (ADM2–4) are added to the display when available (for example, `横浜市港北区大豆戸町付近です。`). Missing levels are omitted. If no registered place is found within 100 km, the response contains `found: false`. Missing or corrupt data produces an error, distinct from an empty search result.

The search does not check administrative or national boundaries, so it may return a place in a neighboring municipality or country. Complete coverage and accuracy of settlement data are not guaranteed.

#### Preparing place-name data

The index built from data downloaded on 2026-10-03, before adding Japanese and English names, contains 4,998,967 records and is approximately 601 MiB. Searches read the required portions of the index from disk rather than loading all records into memory.

Build the index once using Python 3.11 or later. Downloads are required only during preparation; runtime network access and API keys are not needed.

```sh
mkdir -p data/geonames
curl -fL https://download.geonames.org/export/dump/allCountries.zip -o data/geonames/allCountries.zip
curl -fL https://download.geonames.org/export/dump/alternateNamesV2.zip -o data/geonames/alternateNamesV2.zip
python3 scripts/import-geonames.py data/geonames/allCountries.zip --alternate-names data/geonames/alternateNamesV2.zip
```

During import, at most one Japanese and one English name per settlement are stored in `settlements.name_ja` and `settlements.name_en`. Administrative area names (ADM1–4), including Japanese and English variants, are stored in `administrative_areas` and matched using each settlement’s administrative codes. Historical and empty names are excluded. Selection prioritizes preferred names, non-colloquial names, non-abbreviated names, and then alternateNameId. Existing indexes remain readable, but must be rebuilt from both ZIP files to use Japanese, English, and administrative area names.

The generated `data/geonames/settlements.sqlite` is not tracked by Git. It must also be created before building the Docker image; only the SQLite file is bundled in the image. For local execution, its path can be overridden with `LOCAL_SETTLEMENTS_SQLITE`. To update the data, repeat the steps above and restart the server. The index’s `metadata` table records the source, license, generation time, and SHA-256 hashes of the input ZIP files. This tool is also available with `EXTERNAL_FALLBACK_ENABLED=false`.

Data: [GeoNames](https://www.geonames.org/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Settlements are extracted from the distributed data and converted into a search index. [Distribution format and sources](https://download.geonames.org/export/dump/readme.txt).

### place_search

Input:

```json
{"query":"カフェ","lat":35.681,"lng":139.767,"radius":1200}
```

Example response:

```json
{
  "query": "カフェ",
  "mode": "nearby",
  "center": { "lat": 35.681, "lng": 139.767 },
  "radiusMetres": 1200,
  "places": [
    {
      "name": "サンプルカフェ",
      "lat": 35.682,
      "lng": 139.768,
      "distanceMetres": 143,
      "kind": "cafe",
      "openingHours": "Mo-Su 08:00-20:00",
      "address": "東京都千代田区丸の内"
    }
  ],
  "source": "local",
  "provider": "openstreetmap"
}
```

`distanceMetres` is the straight-line distance from the search location in meters. Opening hours, addresses, and similar details are returned when available in OSM. If no matching places are found, `places` is an empty array.

### route

Input:

```json
{"lat":35.531,"lng":139.697,"to":"東京駅","mode":"walking"}
```

The destination can also be specified using `toLat` / `toLng`.

Example response:

```json
{
  "to": "東京駅",
  "mode": "walking",
  "origin": { "lat": 35.531, "lng": 139.697 },
  "destination": { "name": "東京駅", "lat": 35.681, "lng": 139.767 },
  "durationMinutes": 252,
  "distanceKm": 21,
  "source": "local",
  "provider": "openstreetmap",
  "geocoding": { "source": "local", "provider": "openstreetmap" }
}
```

`durationMinutes` is the travel time in minutes, and `distanceKm` is the route distance in kilometers. `geocoding` describes the destination lookup by name and is omitted when coordinates are supplied directly.

## Local First

Coverage is configured in [config/coverage.json](config/coverage.json). The default coverage is an approximate bounding box for mainland Tokyo and Kanagawa, not an administrative boundary covering all of Tokyo’s islands or other outlying areas.

- Inside coverage: self-hosted SQLite snapshots (PostGIS is also supported) and self-hosted OSRM
- Outside coverage: Overpass / Nominatim / public OSRM
- Name lookup: Nominatim only when no match is found in self-hosted data
- Routing: self-hosted OSRM only when both endpoints are inside coverage

Results include `source`, `provider`, and, when an external service is used, `fallbackReason`. An empty local search result does not normally trigger an external request.

Set `EXTERNAL_FALLBACK_ENABLED=false` to disable runtime dependencies on public map APIs. Places and opening hours missing from OSM cannot be retrieved. Public transit, real-time traffic, and live business status are not supported.

## Legacy Cloud Run configuration

The repository and MCP are named `geo-mcp` / Geo MCP. Existing GCP resource names, container deployment settings, and installation paths retain `geo-home` / `geo-home-mcp` for compatibility.

For low-traffic workloads, the MCP server and two OSRM instances run as separate services with zero minimum instances and request-based billing. SQLite and routing data are stored as immutable releases in private GCS storage. Cloud SQL and always-on VMs are not required.

OSRM uses IAM authentication and is accessible only from the MCP server. Clients send `X-API-Key: <dedicated Google API key>` to the API Gateway MCP URL. The gateway exposes only GET/POST/DELETE on `/mcp`, validates the URL and key, and calls the MCP service with IAM authentication. Direct access to the Cloud Run service is not public. Cold starts add latency.

Retrieve the endpoint with `terraform -chdir=terraform output -raw gateway_url` and the key with `terraform -chdir=terraform output -raw gateway_api_key`. Local development also supports the existing Bearer authentication using `MCP_API_KEY`.

Map data is updated manually as needed. Weekly automatic updates are disabled. See the operations guide for instructions.

For configuration, migration, updates, and budget details, see the [operations guide](docs/local-first.md) (Japanese).

## Development

Node.js 22.17 or later is required. SQLite snapshot tests also require Python 3.11 or later.

```sh
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
```

Supply environment variables through the runtime environment (Compose reads `.env`; when running Node directly, use `--env-file`). When set, `LOCAL_PLACES_SQLITE` takes precedence over `DATABASE_URL`.

## Attribution

© OpenStreetMap contributors. [ODbL / attribution](https://www.openstreetmap.org/copyright).

## Shared VM without routing

The shared 4 GiB VM deployment sets `GEO_ROUTES_ENABLED=false`. It exposes only `place_search` and `reverse_geocode`, and runs no OSRM containers. Disabling the route tool also prevents public OSRM fallback through MCP. Omit the setting to retain the existing three-tool interface in other deployments.

Production deployment uses `scripts/deploy.sh` / `cloudbuild-vm.yaml` and the shared VM in `geminihub-486523`. Keep `enable_routes=false` and `enable_weekly_update=false` in the local Terraform configuration. Connect directly to `https://geo.mcp.takeshy.work/mcp` with the same `X-API-Key`. Keep `enable_gateway=false`; the Gateway and OSRM servers are removed. Snapshot/GeoNames data and the existing key remain in use. Shared VM operations and rollback are documented in `../kakeratta/infra/shared-vm/README.md`.
