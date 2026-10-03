import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettlementIndex, reverseGeocode } from "../src/reverse-geocode.js";

function fixture(rows: Array<[number, string, number, number]>) {
  const dir = mkdtempSync(join(tmpdir(), "geo-reverse-"));
  const path = join(dir, "settlements.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE settlements(id INTEGER PRIMARY KEY, name TEXT, country_code TEXT, admin1_code TEXT, lat REAL, lng REAL);
    CREATE VIRTUAL TABLE settlement_spatial USING rtree(id,min_x,max_x,min_y,max_y,min_z,max_z);`);
  for (const [id, name, lat, lng] of rows) {
    db.prepare("INSERT INTO settlements VALUES(?,?, 'XX', '01', ?,?)").run(id, name, lat, lng);
    const phi = lat * Math.PI / 180, theta = lng * Math.PI / 180;
    const x = Math.cos(phi) * Math.cos(theta), y = Math.cos(phi) * Math.sin(theta), z = Math.sin(phi);
    db.prepare("INSERT INTO settlement_spatial VALUES(?,?,?,?,?,?,?)").run(id,x,x,y,y,z,z);
  }
  db.close();
  const index = new SettlementIndex(path);
  return { index, close() { index.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("offline lookup returns nearest settlement, distance and attribution", () => {
  const f = fixture([[1,"小さな村",35,139], [2,"遠い町",35.1,139]]);
  try {
    const result = reverseGeocode({ lat:35.001,lng:139 }, f.index);
    assert.equal(result.data.found, true);
    assert.equal(result.data.source, "local");
    assert.equal(result.data.approximate, true);
    assert.equal((result.data.place as {name:string}).name, "小さな村");
    assert.equal((result.data.place as {distanceMetres:number}).distanceMetres, 111);
    assert.match(result.text, /行政区域の判定ではありません/);
    assert.match(result.links[0]!.label, /CC BY 4.0/);
    assert.equal(reverseGeocode({lat:0,lng:0}, f.index).data.found, false);
  } finally { f.close(); }
});

test("search crosses the date line and handles poles", () => {
  const f = fixture([[1,"Date line village",0,-179.99], [2,"Polar village",89.99,180]]);
  try {
    assert.equal(f.index.nearest({lat:0,lng:179.99})?.geonameId,1);
    assert.equal(f.index.nearest({lat:89.99,lng:0})?.geonameId,2);
  } finally { f.close(); }
});

test("cube candidates outside the search sphere do not hide nearer places", () => {
  const f = fixture([[1,"Diagonal",0.007,0.007], [2,"Nearer",0,0.0091]]);
  try { assert.equal(f.index.nearest({lat:0,lng:0})?.geonameId,2); }
  finally { f.close(); }
});

test("invalid coordinates and missing data are errors, not no results", () => {
  const index = new SettlementIndex("/nonexistent/geonames.sqlite");
  for (const point of [{lat:NaN,lng:0},{lat:91,lng:0},{lat:0,lng:181}]) {
    assert.throws(() => reverseGeocode(point,index), /緯度・経度/);
  }
  assert.throws(() => reverseGeocode({lat:35,lng:139},index), /地名データを読み込めません/);
});
