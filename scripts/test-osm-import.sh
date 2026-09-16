#!/usr/bin/env bash
set -euo pipefail
GEO_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GEO_REPO_ROOT"
install -m 644 test/fixtures/places.osm /data/osm/places-test.osm
docker compose exec -T postgres createdb -U geo geo_import_test </dev/null
trap 'docker compose exec -T postgres dropdb -U geo geo_import_test </dev/null' EXIT
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U geo -d geo_import_test < ops/schema.sql
docker compose build osm-import > /tmp/geo-import-build.log 2>&1
docker compose run --rm --entrypoint python -v "$GEO_REPO_ROOT/test:/tests:ro" osm-import /tests/importer_test.py
docker compose run --rm -e PGDATABASE=geo_import_test osm-import /data/osm/places-test.osm
# Exercise a second full replacement to check identity/index dependencies.
docker compose run --rm -e PGDATABASE=geo_import_test osm-import /data/osm/places-test.osm
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U geo -d geo_import_test <<'SQL'
SELECT osm_type,osm_id,name,name_ja,opening_hours FROM places ORDER BY osm_type,osm_id;
DO $$ BEGIN
 IF (SELECT count(*) FROM places) <> 3 THEN RAISE EXCEPTION 'Expected node, way, relation'; END IF;
 IF NOT EXISTS (SELECT 1 FROM places WHERE osm_type='way' AND opening_hours='Mo-Fr 09:00-18:00') THEN RAISE EXCEPTION 'Missing hours'; END IF;
END $$;
SQL
