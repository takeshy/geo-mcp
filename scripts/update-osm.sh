#!/usr/bin/env bash
set -euo pipefail
cd /opt/geo-home-mcp
exec 9>/data/osm-update.lock
flock -n 9 || exit 0
set -a
source .env
set +a
: "${OSM_PBF_URL:=https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf}"
: "${OSRM_IMAGE:=ghcr.io/project-osrm/osrm-backend:v5.27.1}"
mkdir -p /data/osm /data/osrm/releases /data/backups
if [ "$#" -eq 0 ]; then
release="releases/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "/data/osrm/$release"
curl --fail --location --retry 3 "$OSM_PBF_URL" -o /data/osm/map.osm.pbf.next
mv /data/osm/map.osm.pbf.next /data/osm/map.osm.pbf
for mode in car foot bike; do
  echo "Building OSRM $mode for $release"
  profile="$mode"
  if [ "$mode" = bike ]; then profile=bicycle; fi
  directory="/data/osrm/$release/$mode"
  mkdir -p "$directory"
  cp --reflink=auto /data/osm/map.osm.pbf "$directory/map.osm.pbf"
  docker run --rm -v "$directory:/data" "$OSRM_IMAGE" osrm-extract -p "/opt/$profile.lua" /data/map.osm.pbf
  docker run --rm -v "$directory:/data" "$OSRM_IMAGE" osrm-partition /data/map.osrm
  docker run --rm -v "$directory:/data" "$OSRM_IMAGE" osrm-customize /data/map.osrm
  test -s "$directory/map.osrm.partition"
done
elif [ "$#" -eq 2 ] && [ "$1" = --resume-release ]; then
  release="$2"
  [[ "$release" =~ ^releases/[0-9]{8}T[0-9]{6}Z$ ]] || { echo "Invalid release path" >&2; exit 1; }
  for mode in car foot bike; do
    directory="/data/osrm/$release/$mode"
    test -s "$directory/map.osrm.partition"
    test -s "$directory/map.osrm.cell_metrics"
    cmp --silent /data/osm/map.osm.pbf "$directory/map.osm.pbf"
  done
  echo "Resuming POI import and publication for $release"
else
  echo "Usage: $0 [--resume-release releases/YYYYMMDDTHHMMSSZ]" >&2
  exit 1
fi
docker compose up -d --wait postgres
docker compose exec -T postgres pg_dump -U geo -d geo -Fc > "/data/backups/places-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose run --rm --build osm-import /data/osm/map.osm.pbf --stage
# Pause requests during the multi-service switch. Each dataset is independently atomic.
previous="$(readlink /data/osrm/current || true)"
switched=false
recover() {
  if [ "$switched" = true ] && [ -n "$previous" ]; then
    ln -s "$previous" /data/osrm/rollback
    mv -Tf /data/osrm/rollback /data/osrm/current
    docker compose up -d --force-recreate osrm-car osrm-foot osrm-bike
  fi
  docker compose start geo-home-mcp
}
trap recover EXIT
docker compose stop geo-home-mcp
ln -s "$release" /data/osrm/next
mv -Tf /data/osrm/next /data/osrm/current
switched=true
docker compose up -d --force-recreate osrm-car osrm-foot osrm-bike
# Test each routing graph from the internal network before publishing POIs.
for service in osrm-car osrm-foot osrm-bike; do
  ready=false
  for attempt in $(seq 1 60); do
    if docker compose run --rm --no-deps -T geo-home-mcp node -e '
      fetch("http://"+process.argv[1]+":5000/nearest/v1/driving/139.767,35.681?number=1", {signal: AbortSignal.timeout(5000)})
        .then(async r => {if (!r.ok || (await r.json()).code !== "Ok") process.exit(1)})
        .catch(() => process.exit(1))' "$service"; then ready=true; break; fi
    sleep 2
  done
  "$ready"
done
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U geo -d geo <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '30s';
ALTER TABLE places RENAME TO places_previous;
ALTER TABLE places_next RENAME TO places;
DROP TABLE places_previous;
COMMIT;
SQL
switched=false
docker compose up -d geo-home-mcp caddy
trap - EXIT
