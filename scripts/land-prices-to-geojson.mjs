import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const [input = "data/land-prices.demo.json", output = "generated/land-price.geojson"] = process.argv.slice(2);
const rows = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(rows)) throw new Error("Land-price input must be an array");

const featureCollection = {
  type: "FeatureCollection",
  features: rows.map((row) => ({
    type: "Feature",
    id: row.id,
    geometry: { type: "Point", coordinates: [row.lng, row.lat] },
    properties: {
      id: row.id,
      area: row.area,
      station: row.station,
      municipality: row.municipality,
      pricePerSqm: row.pricePerSqm,
      previousPricePerSqm: row.previousPricePerSqm,
      stationWalkMinutes: row.stationWalkMinutes,
      source: row.source,
      observedAt: row.observedAt,
    },
  })),
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(featureCollection));
console.log(`Wrote ${featureCollection.features.length} features to ${output}`);
