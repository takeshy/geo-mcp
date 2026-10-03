import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettlementIndex, reverseGeocode } from "../src/reverse-geocode.js";

function fixture(rows: Array<[number, string, number, number, string?, string?]>, legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), "geo-reverse-"));
  const path = join(dir, "settlements.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE settlements(id INTEGER PRIMARY KEY, name TEXT, country_code TEXT, admin1_code TEXT, lat REAL, lng REAL);
    CREATE VIRTUAL TABLE settlement_spatial USING rtree(id,min_x,max_x,min_y,max_y,min_z,max_z);`);
  if (!legacy) db.exec("ALTER TABLE settlements ADD COLUMN name_ja TEXT; ALTER TABLE settlements ADD COLUMN name_en TEXT;");
  for (const [id, name, lat, lng, japaneseName, englishName] of rows) {
    db.prepare("INSERT INTO settlements(id,name,country_code,admin1_code,lat,lng) VALUES(?,?, 'XX', '01', ?,?)").run(id, name, lat, lng);
    if (japaneseName && !legacy) db.prepare("UPDATE settlements SET name_ja=? WHERE id=?").run(japaneseName, id);
    if (englishName && !legacy) db.prepare("UPDATE settlements SET name_en=? WHERE id=?").run(englishName, id);
    const phi = lat * Math.PI / 180, theta = lng * Math.PI / 180;
    const x = Math.cos(phi) * Math.cos(theta), y = Math.cos(phi) * Math.sin(theta), z = Math.sin(phi);
    db.prepare("INSERT INTO settlement_spatial VALUES(?,?,?,?,?,?,?)").run(id,x,x,y,y,z,z);
  }
  db.close();
  const index = new SettlementIndex(path);
  return { index, path, close() { index.close(); rmSync(dir, { recursive: true, force: true }); } };
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

test("Japanese alternate names are preferred while country codes remain structured", () => {
  const f = fixture([[1, "Mamedochō", 35, 139, "大豆戸町"], [2, "Other", 35.1, 139, "別の町"]]);
  try {
    const result = reverseGeocode({lat:35,lng:139,language:"ja"}, f.index);
    assert.match(result.text, /^大豆戸町付近です。/);
    assert.doesNotMatch(result.text, /XX|Mamedochō/);
    assert.equal((result.data.place as {name:string}).name, "大豆戸町");
    assert.equal((result.data.place as {countryCode:string}).countryCode, "XX");
    assert.equal(result.links[1]!.label, "大豆戸町");
  } finally { f.close(); }
});

test("missing Japanese names and legacy indexes fall back to the original name", () => {
  for (const legacy of [false, true]) {
    const f = fixture([[1, "Original", 35, 139]], legacy);
    try {
      const result = reverseGeocode({lat:35,lng:139}, f.index);
      assert.match(result.text, /^Original付近です。/);
      assert.doesNotMatch(result.text, /XX/);
      assert.equal((result.data.place as {countryCode:string}).countryCode, "XX");
    } finally { f.close(); }
  }
});

test("English is the default and each requested language falls back independently", () => {
  const f = fixture([[1, "Original", 35, 139, "日本語名", "English name"],
                     [2, "Fallback", 36, 139, "日本語だけ"]]);
  try {
    for (const language of [undefined, "en", "ja"] as const) {
      const result = reverseGeocode({lat:35,lng:139,language}, f.index);
      const expected = language === "ja" ? "日本語名" : "English name";
      assert.equal((result.data.place as {name:string}).name, expected);
      assert.ok(result.text.startsWith(`${expected}付近です。`));
      assert.equal(result.links[1]!.label, expected);
      assert.deepEqual(result.data.center, {lat:35,lng:139});
    }
    assert.equal((reverseGeocode({lat:36,lng:139}, f.index).data.place as {name:string}).name, "Fallback");
  } finally { f.close(); }
});

test("administrative codes add localized city and ward without changing the nearest place", () => {
  const f = fixture([[10862226, "Mamedochō", 35.51406, 139.62366, "大豆戸町", "Mamedocho"]]);
  const db = new DatabaseSync(f.path);
  db.exec(`ALTER TABLE settlements ADD COLUMN admin2_code TEXT;
    ALTER TABLE settlements ADD COLUMN admin3_code TEXT;
    ALTER TABLE settlements ADD COLUMN admin4_code TEXT;
    UPDATE settlements SET country_code='JP', admin1_code='19', admin2_code='1848350', admin3_code='14109', admin4_code='';
    CREATE TABLE administrative_areas(id INTEGER PRIMARY KEY, level INTEGER, country_code TEXT,
      admin1_code TEXT, admin2_code TEXT, admin3_code TEXT, admin4_code TEXT, name TEXT, name_ja TEXT, name_en TEXT);
    INSERT INTO administrative_areas VALUES(1848350,2,'JP','19','1848350','','','Yokohama Shi','横浜市','Yokohama');
    INSERT INTO administrative_areas VALUES(1859047,3,'JP','19','1848350','14109','','Kōhoku-ku','横浜市港北区',NULL);
    INSERT INTO administrative_areas VALUES(99,3,'XX','19','1848350','14109','','Wrong country',NULL,NULL);`);
  db.close();
  try {
    const ja = reverseGeocode({lat:35.51406,lng:139.62366,language:"ja"}, f.index);
    assert.ok(ja.text.startsWith("横浜市港北区大豆戸町付近です。"));
    assert.equal((ja.data.place as {name:string}).name, "大豆戸町");
    assert.equal((ja.data.place as {geonameId:number}).geonameId, 10862226);
    assert.equal((ja.data.place as {administrativeAreas:unknown[]}).administrativeAreas.length, 2);
    const en = reverseGeocode({lat:35.51406,lng:139.62366}, f.index);
    assert.ok(en.text.startsWith("Yokohama, Kōhoku-ku, Mamedocho付近です。"));
  } finally { f.close(); }
});
