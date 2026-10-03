# Local First / Cloud Run 運用

## 現行方針

利用量は1日100アクセス未満、月額目標は税込5,000円未満。GCPを継続し、自前施設検索と車・徒歩の経路検索を維持する。遅延を許容し、常時起動・Cloud SQL・ロードバランサーを避ける。

| サービス | CPU / RAM | 最小 / 最大 | データ |
|---|---|---|---|
| geo-home-mcp | 1 / 1GiB | 0 / 1 | 起動時にGCSからSQLiteを取得 |
| geo-osrm-car | 1 / 4GiB | 0 / 1 | GCSを読み取り専用マウント |
| geo-osrm-foot | 1 / 4GiB | 0 / 1 | 同上 |
| geo-osm-update | 8 / 32GiB | ジョブ1タスク | 一時メモリ上で順番に生成 |

3つのHTTPサービスはリクエスト課金。OSRMは公開IAM bindingを持たず、MCPのランタイムSAだけに呼び出しを許可する。MCP本体も非公開で、API Gatewayの専用SAに呼び出しを許可する。クライアント向けの入口はGatewayの `/mcp`。専用Google APIキーを `X-API-Key` ヘッダーで送る。公開ヘルスチェックは提供せず、稼働確認は認証付きのMCP接続で行う。

Terraformのstartup probeはコンテナへ直接アクセスする内部チェックとして `/healthz` を利用する。Gatewayには `/health` と `/healthz` を公開しない。

## データ

非公開バケット `<project>-snapshots` の `releases/<id>/` 配下にSQLiteと2グラフを保存する。リリースのファイルは上書きしない。初期変換はPostGISの1 SELECTから1,195,538件を抽出し、SQLiteは約246MiB。関東PBFを利用し、Coverageだけ東京・神奈川へ制限する。

SQLiteはRTreeで周辺候補を絞り、球面距離で半径内を確定し距離順に返す。名称は日本語対応のtrigram FTS、3文字未満は部分一致。OSM営業時間は文字列のまま返す。

## 更新

`ops/cloud-run/update.py` をCloud Run Jobとして、必要なときだけ手動実行する。2026-10-01にCloud Schedulerの `geo-osm-weekly` を停止し、Terraformも `enable_weekly_update = false` に変更した。更新ジョブ自体は残す。

```sh
gcloud run jobs execute geo-osm-update \
  --project=geo-home-mcp-505104 \
  --region=asia-northeast1 \
  --wait
```

既存の重複実行防止により、通常はISO週ごとに1回だけ更新できる。同じ週に再実行する場合は、他の更新実行が終了していることを確認し、該当する `updates/<ISO-week>.json` マーカーを削除してから実行する。

1. ISO週ごとのGCSオブジェクトを排他的に作り、同週の重複実行を防ぐ。
2. 関東PBFを取得し、SQLiteを生成・整合性検証する。
3. car/footを順番に生成し、各グラフで川崎→東京の経路を検証する。
4. 不変リリースへ全ファイルをアップロードする。
5. 2つのOSRMリビジョンが起動した後、MCPのSQLite参照を更新する。
6. `current.json` を更新する。通常の例外では更新したリビジョンを前のテンプレートへ戻す。

ジョブは4時間上限、再試行0。タイムアウト/強制終了時は自動ロールバックが実行されない場合があるので、サービスが参照するリリースを確認する。公開切替はサービス単位でatomicであり、3サービスをまたぐ単一トランザクションではない。

失敗した週は自動で再課金を繰り返さない。原因を修正してから `updates/<ISO-week>.json` の失敗マーカーを削除し、手動再実行する。公開データには触れない。Cloud Schedulerからの自動実行は停止している。

更新ジョブは公開成功後、8日以上前のリリースから現用・直前リリースを除いて削除する。手動削除でも現在のサービスとロールバック先が参照していないことを確認する。日数だけのGCS lifecycle削除は、更新失敗が続いた場合に現用データを消すため設定しない。

## 費用の算定

TokyoはCloud Run Tier 1。リクエスト課金はCPU秒×$0.000024 + GiB秒×$0.0000025。JobはCPU秒×$0.000018 + GiB秒×$0.000002。無料枠は請求アカウント全体で共有されるので、予算の保証としては扱わない。

8CPU/32GiBジョブは約$0.7488/時間。参考として月5回の手動更新が毎回4時間上限まで動けば5回/月で$14.976（1ドル150円・消費税10%換算で約2,471円）。HTTPサービスの起動・処理時間、GCS保管/操作、Artifact Registry、ビルド、ネットワーク、DNS/Schedulerを別途加える。

MCPとOSRMをそれぞれ1CPU、合計5GiBで50秒利用する例では、3,100回/月で約$9.38（無料枠前、約1,547円）。全リクエストがコールドスタートするとは限らないが、初回読み込みも課金対象。GCS FUSEのファイル操作数・起動時間は実測する。月5,000円は設計目標であり、課金のハード上限ではない。

公式: https://cloud.google.com/run/pricing

## 移行

既存プロジェクト `geo-home-mcp-505104`、東京 `asia-northeast1` を維持する。アプリ操作は `takeshy.work@gmail.com`。

DNSは別プロジェクト `takeshy-work` の既存zone。`../takeshy.work/terraform` が管理し、アカウントは `takesy.morito@gmail.com`。ドメインは `geo.mcp.takeshy.work`。Cloud Runへ切り替えるまで既存VMのAレコードを維持する。

Cloud Runで施設検索・車と徒歩の経路・認証・2ツールの公開を確認済み。VM・データSSD・固定IPと旧デモ用バケットは削除済み。Terraform state用バケットは維持する。独自ドメインのHTTPS・認証付き検索も確認済み。旧接続先は `https://geo.mcp.takeshy.work/mcp`。現在のクライアントはAPI Gatewayへ接続する。MCPのrun.app URLは直接アクセスを防ぐため無効化する。車・徒歩OSRMのrun.app URLはMCPからのIAM認証付き呼び出しに利用する。

以前のCompute Engine構成は `docker-compose.yml`、`ops/schema.sql`、`scripts/update-osm.sh` に残る。移行中の復旧用であり、最終構成として常時稼働させない。

## 自転車経路の削除（2026-10-01）

自転車経路をMCPの入力・外部フォールバック・週次生成・Terraform・旧Compose構成から削除した。`geo-osrm-bike` と専用の呼び出し/更新権限をTerraformで削除し、GCSの各リリースに残る `osrm/bike/` 52ファイル（約7.35GiB）も削除した。

ビルド `f88ff11d-d61e-420b-b543-d22a366d6b49` を本番反映。公開MCPの経路モードは `driving` / `walking` のみで、`cycling` は拒否される。東京駅周辺のカフェ12件、川崎→東京の車22.3km/26分と徒歩19.6km/237分をすべて `source=local` で確認した。週次更新は反映後に再開。以下の2026-09-16記録は削除前の履歴として残す。

## 検証記録（2026-09-16）

- 東京駅周辺のカフェ12件、名称検索5件、営業時間取得を自前SQLiteで確認。
- 川崎→東京: 車22.3km/26分、徒歩19.6km/237分、自転車20.2km/95分。すべて `source=local`。
- 起動済み検索は約0.05〜0.34秒。車のコールドスタート込み約41秒。
- 未認証のMCPは401、削除した `/map` と `/api/demo` は404、ツール一覧は2件。
- Nominatimと公開OSRMはCloud RunからHTTP 200。Overpassは接続タイムアウトがあり、未対応地域の周辺検索は上流の可用性に依存する。エラーを「施設0件」として扱わない。
- TypeScriptテスト27件成功、PostGIS統合テスト1件はSQLite構成ではスキップ。更新完了待ちとリリース削除保護のPythonテスト3件成功。
- 初回の周期更新（`geo-osm-update-44jk5`）が成功。car/foot/bikeを生成して各グラフで川崎→東京を検証し、`releases/20260916T123616Z-9831160c` を公開。`current.json` を更新し、直前の `20260916-initial` はロールバック用に保持。
- 切替後に4サービスが `Ready`、ライブの自前検索と3モード経路が新リリースを参照。`updates/2026-W38.json` は `complete`。週次更新を有効化（`0 3 * * 0` Asia/Tokyo、次回2026-09-20 03:00 JST）。

料金試算は `python3 scripts/estimate-cloud-run.py`。1ドル150円・消費税10%、その他月$3の仮枠で、更新4時間×5回なら月約4,500円、更新1時間×5回なら約2,700円。実費の上限保証ではない。

## デプロイ

`npm run deploy` はMCP・OSRM・更新ジョブのイメージを同じビルドIDで作り、Terraform計画を適用する。デプロイ後のタグはignoredの `terraform/deployed.auto.tfvars.json` に保存する。更新ジョブだけを変更する場合は `cloudbuild-update.yaml` でビルドして `update_image_tag` を更新する。

更新後のリリースはGCS `current.json` からTerraformが読み取るため、後日のTerraform適用で古いデータへ戻らない。イメージ変更とデータ更新は重ねて実行しない。手動更新の実行中はJobが終わってからデプロイする。

独自ドメインはGoogleの所有権確認済みアカウントで作成し、Terraformへimport済み。再作成時だけ所有権確認が必要。DNS管理アカウントへの一時権限は撤去済みで、Terraformは既存mappingを維持する。

## API Gatewayと不正アクセス（2026-10-01）

MCPは最小インスタンス数0、リクエスト課金。クライアントの入口はAPI Gatewayの `https://<hostname>.gateway.dev/mcp`。`terraform -chdir=terraform output -raw gateway_url` で接続先を確認する。専用Google APIキーは `terraform -chdir=terraform output -raw gateway_api_key` で確認し、クライアントの `X-API-Key` ヘッダーに設定する。キーはURLや追跡対象の設定ファイルに埋め込まない。

Gatewayは `/mcp` のGET/POST/DELETEのみ許可し、Google APIキーを検証してから本体を呼ぶ。`/.env`、`/.git/config`、`/health` など未登録のパス、キーなし、不正キーは本体へ転送しない。MCP本体は専用キーも照合する。Gatewayが付けるGoogle IDトークンとクライアントのキーは別の認証である。

本体の `allUsers` 呼び出し権限を削除し、`geo-home-gateway` サービスアカウントに `roles/run.invoker` を付与する。独自ドメイン `geo.mcp.takeshy.work` はGatewayからのIAM認証付き接続にのみ使用する。通常のクライアントから旧ドメインへ直接アクセスしてもCloud Runの入口で拒否される。`run.app` の2つの標準URLも無効のまま維持する。

標準URLの無効化は `gcloud run services update geo-home-mcp --project=geo-home-mcp-505104 --region=asia-northeast1 --no-default-url` で設定する。現在のTerraform Google provider v6.50.0は `default_uri_disabled` に対応していないため、`scripts/deploy.sh` もデプロイ後にこの設定を維持する。

Gatewayは標準のHTTPプロキシとして既存のMCPを転送する。プレビューのREST→MCP変換機能は使わない。MCPはステートレスのJSON応答を利用し、バックエンド待機上限は300秒に設定する。Gatewayに独自ドメインを付ける追加ロードバランサーは作成しない。

本番検証は次の手順で行う。キーは端末の履歴や出力へ表示しない。

```sh
export GEO_MCP_GATEWAY_URL="$(terraform -chdir=terraform output -raw gateway_url)"
export MCP_GATEWAY_API_KEY="$(terraform -chdir=terraform output -raw gateway_api_key)"
node scripts/check-gateway.mjs
```

`allow_direct_mcp_access` は通常 `false`。移行検証の一時的な用途以外で有効化しない。GatewayのキーはこのAPIのmanaged serviceだけに制限する。地図更新は引き続き手動で行う。

2026-10-01の実環境で `https://geo-mcp-37047ftd.an.gateway.dev/mcp` からMCP初期化・ツール一覧・施設検索・車と徒歩の経路検索を確認済み。公開IAM権限の削除後も全チェックが成功した。旧独自ドメインと2つのrun.app URLへの直接アクセスは403で拒否される。キーなし・不正キー・未登録パス・未登録メソッドはGatewayで拒否される。地図更新SchedulerはPAUSEDのまま。
