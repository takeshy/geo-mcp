# Geo Home MCP

地価、駅徒歩、公共交通の移動時間から居住候補地域を比較し、PMTiles対応のインタラクティブ地図を表示するStreamable HTTP MCPサーバーです。

## 含まれるもの

- Cloud Run向けMCPサーバー (`/mcp`)
- `list_layers`, `get_land_price`, `compute_commute`, `find_candidate_areas`, `compare_areas`, `build_area_map`
- MCP Appとして表示できるMapLibre地図
- GCS上のPMTilesと地価JSONの読み込み
- オープンデータから事前計算した公共交通時間（未収録の目的地は明示付きデモ推定）
- GemiHub Business Agent PluginとCodex Pluginのmanifest

## ローカル起動

```bash
npm install
npm run dev
```

- 地図: http://localhost:8080/map
- MCP: http://localhost:8080/mcp
- Health check: http://localhost:8080/health

初期状態は `data/land-prices.demo.json` を使用します。この値はUI・ツール動作確認専用です。

## 実データ

`LAND_PRICE_DATA_PATH` にローカルJSONまたは `gs://bucket/object.json` を指定します。Cloud Runのサービスアカウントには対象オブジェクトの `storage.objects.get` を付与してください。JSONの配列要素は次の形です。

```json
{
  "id": "unique-id",
  "area": "地域名",
  "station": "最寄駅",
  "municipality": "自治体",
  "lat": 35.6812,
  "lng": 139.7671,
  "pricePerSqm": 1000000,
  "previousPricePerSqm": 950000,
  "stationWalkMinutes": 8,
  "source": "国土交通省 不動産情報ライブラリ",
  "sourceUrl": "https://www.reinfolib.mlit.go.jp/",
  "observedAt": "2026-01-01",
  "commuteProfiles": [
    {
      "destination": "東京駅",
      "lat": 35.6812,
      "lng": 139.7671,
      "durationMinutes": 35,
      "transfers": 1,
      "source": "GTFS等からの事前計算",
      "observedAt": "2026-01-01"
    }
  ]
}
```

国土交通省APIの利用申請・利用条件を確認し、ETLでこの正規化形式へ変換してください。公示地価、基準地価、実取引価格は意味が異なるため、同一系列として混ぜないでください。本番では `series` などの列を追加して別レイヤー化することを推奨します。公共交通時間はGTFSなど再配布条件を確認できるオープンデータから事前計算し、出典と観測日を `commuteProfiles` に保持します。PMTilesは地価・候補地点の地図配信に使い、経路計算結果はこのJSONプロファイルから参照します。

## PMTiles

`.pmtiles` をCloud Storageへアップロードし、CORSで `Range` リクエストを許可した配信URLを `PMTILES_URL` に設定します。ベクトルタイル内のsource layer名を `PMTILES_SOURCE_LAYER` に指定してください。

同梱デモデータからPMTilesを生成してTerraform管理のGCSバケットへ配置する場合:

```bash
gcloud builds submit \
  --region=asia-northeast1 \
  --config=cloudbuild-data.yaml \
  --service-account="projects/PROJECT_ID/serviceAccounts/geo-home-build@PROJECT_ID.iam.gserviceaccount.com" \
  .
```

このビルドはGeoJSONを生成し、tippecanoe 2.29.0で `land-price` source layerのPMTilesへ変換します。

例となるCORS設定:

```json
[
  {
    "origin": ["https://YOUR_APP.example.com"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Range", "Content-Range", "Accept-Ranges"],
    "maxAgeSeconds": 3600
  }
]
```

機密性が不要な地図タイルは公開読み取り＋CDN、テナント固有データは認証付きRange proxyを推奨します。

## Google Cloudインフラ

Geo Home専用GCPプロジェクトで自己完結する構成です。

- Project: `terraform.tfvars` で指定する専用プロジェクト
- Region: `asia-northeast1`（変更可能）
- Artifact Registry: `geo-home`
- Cloud Run runtime SA: `geo-home-run`
- Cloud Build SA: `geo-home-build`
- Terraform root module: `terraform/`
- Cloud Run service: `geo-home-mcp`
- GCS bucket: `${project_id}-geo-home`（上書き可能）

Terraformが次を管理します。

- Cloud Runサービス、スケーリング、health check、公開Invoker
- GCSバケット、PMTiles用CORS、Cloud Run読み取り権限
- 地価JSONとPMTilesのCloud Run環境変数

Cloud RunのコンテナイメージだけはTerraformの `ignore_changes` 対象です。既存メインサービスと同様、Terraformがインフラ、Cloud Buildがアプリケーションイメージを管理します。

### 1. インフラを作成

GCPプロジェクトを作成して課金アカウントへ接続した後、Terraform変数を設定します。プロジェクト作成自体をTerraformへ含めないことで、組織・Folder・Billing Accountのbootstrap権限とサービス用stateを分離しています。

```hcl
project_id = "your-geo-home-project-id"
region     = "asia-northeast1"

bucket_name         = "your-geo-home-project-id-geo-home"
public_tiles        = true
cors_origins        = ["https://YOUR_GEMIBIZ_DOMAIN"]
land_price_object   = "land-prices.json"
pmtiles_object      = "land-price.pmtiles"
pmtiles_source_layer = "land-price"
```

オブジェクト名とSecret IDは、実データをまだ用意しない場合は空のままで構いません。その場合、組み込みデモデータと推定移動時間で起動します。

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# terraform/terraform.tfvars を編集
terraform -chdir=terraform init
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

初回Terraform applyではCloud Run公式helloイメージを使い、まだ存在しないGeo Homeイメージへの循環依存を避けます。

### 2. アプリケーションをデプロイ

Geo Home MCPリポジトリのルートから実行します。

```bash
./scripts/deploy.sh
```

スクリプトはこのリポジトリのTerraform outputからプロジェクト、リージョン、Artifact Registry、Cloud Build専用SAを取得してCloud Buildを実行します。Cloud Buildは作成済みCloud Runサービスのイメージだけを更新します。デプロイ後にCloud Run URLを取得し、`mcp.json` と `.mcp.json` の接続先も自動更新します。更新された2ファイルはGitへcommitしてからAgent Pluginをインストールしてください。

別環境へ出す場合だけ `GEO_PROJECT_ID`、`GEO_REGION`、`GEO_SERVICE` を上書きできます。ただしCloud Build側の `_PROJECT_ID` なども `--substitutions` で一致させてください。

## Plugin接続先の更新

デプロイ後、発行されたCloud Run URLを次の2ファイルへ設定します。

- `mcp.json`: GemiHub Business Agent Plugin用（`streamable-http`）
- `.mcp.json`: Codex Plugin用（`http`）

現在の `geo-home-mcp.example.com` は安全なplaceholderです。`scripts/deploy.sh` がデプロイ後に実URLへ更新します。GemiHub Businessでは、更新をGitHubへpushした後にrepositoryをAgent Plugin設定画面からpreview・installします。インストール時に `tools/list` が自動実行されるため、通常はそのままチャットで利用できます。警告が表示された場合だけ、**Settings > MCP Servers** の接続テストで再試行してください。

チャット内で地図カードを表示するには、`find_candidate_areas` の後に `build_area_map` を呼び出します。`build_area_map` は `_meta.ui.resourceUri` と候補を含む `structuredContent` を返し、GemiHub BusinessがPMTiles/MapLibre製のインタラクティブなMCP Appとして新しいアシスタントメッセージに表示します。修正前に保存済みの回答へカードを後付けすることはできないため、その場合は検索を再実行してください。

手動でURLだけ設定する場合:

```bash
node scripts/configure-plugin-url.mjs https://YOUR_SERVICE_URL/mcp
```

## セキュリティ

MCPクライアントから到達できるよう、TerraformはCloud Run Invokerを `allUsers` に付与します。本番で認証を必須にする場合は `google_cloud_run_v2_service_iam_member.geo_home_public` をOAuth/API Gateway構成へ置き換え、Agent Plugin側にも認証設定を追加してください。
