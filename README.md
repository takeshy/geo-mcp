# Geo MCP

自前のOpenStreetMapデータによる施設検索と、車・徒歩・自転車の経路検索。

## Tools

- `place_search`: 施設名、カテゴリ、周辺検索。距離順、営業時間、住所を返す。
- `route`: 車 (`driving`)、徒歩 (`walking`)、自転車 (`cycling`) の距離・所要時間。

以下は自前データを利用した場合の入出力例。施設名・座標・距離・所要時間などは説明用のサンプル。応答はMCPの `structuredContent` 部分を示す（`content` には説明文と参照リンクも返る）。

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

低アクセス向けにMCPと3つのOSRMを別サービスに分け、最小インスタンス数0・リクエスト課金で動かす。SQLite・経路データは非公開GCSの不変リリースに保存する。Cloud SQLや常時稼働VMは不要。

OSRMはIAM認証でMCPからのみ利用する。MCPには `Authorization: Bearer <MCP_API_KEY>` が必要。コールドスタートには待ち時間がある。

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
