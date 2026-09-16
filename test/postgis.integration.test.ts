import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { LocalPlaceProvider } from "../src/local-places.js";
// Use a disposable database: creates PostGIS extensions and a transaction-local table.
test("PostGIS spatial order, Japanese name/category search, hours and atomic table replacement", { skip: !process.env.TEST_POSTGIS_URL }, async () => {
  const db = new pg.Client({ connectionString: process.env.TEST_POSTGIS_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("CREATE SCHEMA geo_test");
    await db.query("SET LOCAL search_path = geo_test, public");
    await db.query(await readFile(new URL("../ops/schema.sql", import.meta.url), "utf8"));
    await db.query(`INSERT INTO places(osm_type,osm_id,name,name_ja,amenity,shop,opening_hours,lat,lng,geom) VALUES
      ('node',1,'Near pharmacy','近い薬局','pharmacy',null,'Mo-Fr 09:00-18:00',35.681,139.767,ST_SetSRID(ST_Point(139.767,35.681),4326)),
      ('way',2,'Far pharmacy','遠い薬局',null,'chemist',null,35.682,139.768,ST_SetSRID(ST_Point(139.768,35.682),4326)),
      ('node',3,'Osaka pharmacy',null,'pharmacy',null,null,34.69,135.5,ST_SetSRID(ST_Point(135.5,34.69),4326))`);
    const provider = new LocalPlaceProvider(db);
    const nearby = await provider.search({ query: "薬局", lat: 35.681, lng: 139.767, radius: 500 });
    assert.deepEqual(nearby.map(p => p.name), ["近い薬局", "遠い薬局"]);
    assert.equal(nearby[0]?.distanceMetres, 0);
    assert.equal(nearby[0]?.openingHours, "Mo-Fr 09:00-18:00");
    assert.equal((await provider.search({ query: "近い薬局" }))[0]?.name, "近い薬局");
    assert.equal((await provider.search({ query: "%' OR true --" })).length, 0);
    await db.query("CREATE TABLE places_next (LIKE places INCLUDING ALL)");
    await db.query("ALTER TABLE places RENAME TO places_previous");
    await db.query("ALTER TABLE places_next RENAME TO places");
    await db.query("DROP TABLE places_previous");
    assert.equal((await provider.search({ query: "薬局" })).length, 0);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
