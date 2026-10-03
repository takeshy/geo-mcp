# Geo MCP

自前のOpenStreetMapデータによる施設検索と、車・徒歩の経路検索。

## Tools

- `reverse_geocode`: 緯度・経度から世界の最寄りの町・村と直線距離を返す。自前GeoNames索引のみを使い、外部APIには接続しない。
- `place_search`: 施設名、カテゴリ、周辺検索。距離順、営業時間、住所を返す。
- `route`: 車 (`driving`)、徒歩 (`walking`) の距離・所要時間。

以下は自前データを利用した場合の入出力例。施設名・座標・距離・所要時間などは説明用のサンプル。応答はMCPの `structuredContent` 部分を示す（`content` には説明文と参照リンクも返る）。

### reverse_geocode

入力: `{"lat":35.6812,"lng":139.7671}`

GeoNamesに登録された居住地から最寄りを検索し、「地名（国コード）付近」と登録地点までの距離を返す。人口による下限は設けず、小さな町・村も対象とする。歴史上の集落・廃村・地区単位のデータは除外する。名称は収録名で、日本語とは限らない。

`structuredContent` は `found`、`approximate: true`、`method: "nearest_settlement"`、`source: "local"`、`provider: "geonames"` を含む。見つかった場合の `place` は `name`、`countryCode`、`admin1Code`（州・県のコード）、`lat`、`lng`、`geonameId`、`distanceMetres` を含む。100km以内に登録地点がなければ `found: false`。データ未配置や破損は検索結果なしとは区別してエラーにする。

行政区域や国境の内外は判定しないため、隣の自治体・国の地名が返る場合がある。居住地の完全な網羅や正確性は保証しない。

#### 地名データの準備

2026-10-03取得データの索引は4,998,967件、約601MiB。検索索引はディスクから必要な部分を読み、全件をメモリには展開しない。

Python 3.11以降で一度だけ索引を作成する。ダウンロードは準備時だけで、実行時の通信・APIキーは不要。

```sh
mkdir -p data/geonames
curl -fL https://download.geonames.org/export/dump/allCountries.zip -o data/geonames/allCountries.zip
python3 scripts/import-geonames.py data/geonames/allCountries.zip
```

生成物 `data/geonames/settlements.sqlite` はGit管理外。Dockerイメージのビルド前にも作成が必要で、イメージにはSQLiteだけを同梱する。ローカル実行の配置先は `LOCAL_SETTLEMENTS_SQLITE` で変更できる。更新時も上記手順で作り直し、サーバーを再起動する。出典・ライセンス・生成日時・入力ZIPのSHA-256は索引の `metadata` テーブルに記録する。`EXTERNAL_FALLBACK_ENABLED=false` でもこのツールは利用可能。

データ: [GeoNames](https://www.geonames.org/)、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。配布データから居住地を抽出し検索索引に加工。[配布形式と出典](https://download.geonames.org/export/dump/readme.txt)。

### place_search

入力:

```json
{"query":"カフェ","lat":35.681,"lng":139.767,"radius":1200}
```

応答例:

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

`distanceMetres` は検索位置からの直線距離（メートル）。営業時間・住所などはOSMに登録がある場合に返る。該当施設がない場合は `places` が空配列になる。

### route

入力:

```json
{"lat":35.531,"lng":139.697,"to":"東京駅","mode":"walking"}
```

目的地は `toLat` / `toLng` でも指定可能。

応答例:

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

`durationMinutes` は所要時間（分）、`distanceKm` は経路の距離（キロメートル）。`geocoding` は目的地を名前で検索した際の情報で、座標を直接指定した場合は省略される。

## Local First

対応地域は [config/coverage.json](config/coverage.json) で設定する。初期範囲は東京本土・神奈川の近似Bounding Box。東京都の島しょ部などを網羅する行政境界ではない。

- 対応地域: 自前SQLiteスナップショット（PostGISも選択可能）と自前OSRM
- 未対応地域: Overpass / Nominatim / 公開OSRM
- 名称検索: 自前データで見つからないときだけNominatim
- 経路検索: 両端が対応地域内の場合だけ自前OSRM

結果には `source`、`provider`、外部利用時の `fallbackReason` を付ける。自前検索が0件でも通常は外部へ問い合わせない。

`EXTERNAL_FALLBACK_ENABLED=false` で公開地図APIへの実行時依存を止められる。OSMにない施設や営業時間は取得できない。公共交通、リアルタイム渋滞・営業状況には非対応。

## Cloud Run

リポジトリ・MCPの名称は `geo-mcp` / Geo MCP。既存のGCPリソース名・コンテナ運用設定・配置先パスは互換性のため `geo-home` / `geo-home-mcp` を維持する。

低アクセス向けにMCPと2つのOSRMを別サービスに分け、最小インスタンス数0・リクエスト課金で動かす。SQLite・経路データは非公開GCSの不変リリースに保存する。Cloud SQLや常時稼働VMは不要。

OSRMはIAM認証でMCPからのみ利用する。クライアントはAPI GatewayのMCP URLへ `X-API-Key: <専用Google APIキー>` を送る。Gatewayは `/mcp` のGET/POST/DELETEだけを公開し、URLとキーを検証してからIAM認証付きでMCP本体を呼ぶ。Cloud Run本体への直接アクセスは公開しない。コールドスタートには待ち時間がある。

接続先は `terraform -chdir=terraform output -raw gateway_url`、キーは `terraform -chdir=terraform output -raw gateway_api_key` で確認できる。ローカル開発では従来の `MCP_API_KEY` によるBearer認証も利用できる。

地図データは必要なときだけ手動更新する。週次の自動更新は停止している。実行方法は運用手順を参照。

構成・移行・更新・予算の詳細: [運用手順](docs/local-first.md)。

## Development

Node.js 22.17以降、SQLiteスナップショットのテストにはPython 3.11以降が必要。

```sh
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
```

環境変数は実行環境から渡す（`.env` はComposeが読み込む。Node単体では `--env-file` を使う）。`LOCAL_PLACES_SQLITE` を指定すると `DATABASE_URL` より優先する。

## Attribution

© OpenStreetMap contributors. [ODbL / attribution](https://www.openstreetmap.org/copyright).
