# Local First / Cloud Run 運用

## 現行方針

利用量は1日100アクセス未満、月額目標は税込5,000円未満。GCPを継続し、自前施設検索と車・徒歩・自転車の経路検索を維持する。遅延を許容し、常時起動・Cloud SQL・ロードバランサーを避ける。

| サービス | CPU / RAM | 最小 / 最大 | データ |
|---|---|---|---|
| geo-home-mcp | 1 / 1GiB | 0 / 1 | 起動時にGCSからSQLiteを取得 |
| geo-osrm-car | 1 / 4GiB | 0 / 1 | GCSを読み取り専用マウント |
| geo-osrm-foot | 1 / 4GiB | 0 / 1 | 同上 |
| geo-osrm-bike | 1 / 4GiB | 0 / 1 | 同上 |
| geo-osm-update | 8 / 32GiB | ジョブ1タスク | 一時メモリ上で順番に生成 |

4つのHTTPサービスはリクエスト課金。OSRMは公開IAM bindingを持たず、MCPのランタイムSAだけに呼び出しを許可する。外部公開はMCPのBearer認証付き `/mcp`。ヘルスチェック `/healthz` は稼働確認だけを返す。

## データ

非公開バケット `<project>-snapshots` の `releases/<id>/` 配下にSQLiteと3グラフを保存する。リリースのファイルは上書きしない。初期変換はPostGISの1 SELECTから1,195,538件を抽出し、SQLiteは約246MiB。関東PBFを利用し、Coverageだけ東京・神奈川へ制限する。

SQLiteはRTreeで周辺候補を絞り、球面距離で半径内を確定し距離順に返す。名称は日本語対応のtrigram FTS、3文字未満は部分一致。OSM営業時間は文字列のまま返す。

## 更新

`ops/cloud-run/update.py` をCloud Run Jobとして動かす。

1. ISO週ごとのGCSオブジェクトを排他的に作り、同週の重複実行を防ぐ。
2. 関東PBFを取得し、SQLiteを生成・整合性検証する。
3. car/foot/bikeを順番に生成し、各グラフで川崎→東京の経路を検証する。
4. 不変リリースへ全ファイルをアップロードする。
5. 3つのOSRMリビジョンが起動した後、MCPのSQLite参照を更新する。
6. `current.json` を更新する。通常の例外では更新したリビジョンを前のテンプレートへ戻す。

ジョブは4時間上限、再試行0。タイムアウト/強制終了時は自動ロールバックが実行されない場合があるので、サービスが参照するリリースを確認する。公開切替はサービス単位でatomicであり、4サービスをまたぐ単一トランザクションではない。

失敗した週は自動で再課金を繰り返さない。原因を修正してから `updates/<ISO-week>.json` の失敗マーカーを削除し、手動再実行する。公開データには触れない。Cloud Schedulerは初回の全更新成功を受けて2026-09-16に有効化済み（日曜3時 JST、次回2026-09-20）。

更新ジョブは公開成功後、8日以上前のリリースから現用・直前リリースを除いて削除する。手動削除でも現在のサービスとロールバック先が参照していないことを確認する。日数だけのGCS lifecycle削除は、更新失敗が続いた場合に現用データを消すため設定しない。

## 費用の算定

TokyoはCloud Run Tier 1。リクエスト課金はCPU秒×$0.000024 + GiB秒×$0.0000025。JobはCPU秒×$0.000018 + GiB秒×$0.000002。無料枠は請求アカウント全体で共有されるので、予算の保証としては扱わない。

8CPU/32GiBジョブは約$0.7488/時間。週次が毎回4時間上限まで動けば5回/月で$14.976（1ドル150円・消費税10%換算で約2,471円）。HTTPサービスの起動・処理時間、GCS保管/操作、Artifact Registry、ビルド、ネットワーク、DNS/Schedulerを別途加える。

MCPとOSRMをそれぞれ1CPU、合計5GiBで50秒利用する例では、3,100回/月で約$9.38（無料枠前、約1,547円）。全リクエストがコールドスタートするとは限らないが、初回読み込みも課金対象。GCS FUSEのファイル操作数・起動時間は実測する。月5,000円は設計目標であり、課金のハード上限ではない。

公式: https://cloud.google.com/run/pricing

## 移行

既存プロジェクト `geo-home-mcp-505104`、東京 `asia-northeast1` を維持する。アプリ操作は `takeshy.work@gmail.com`。

DNSは別プロジェクト `takeshy-work` の既存zone。`../takeshy.work/terraform` が管理し、アカウントは `takesy.morito@gmail.com`。ドメインは `geo.mcp.takeshy.work`。Cloud Runへ切り替えるまで既存VMのAレコードを維持する。

Cloud Runで施設検索・3モード経路・認証・2ツールの公開を確認済み。VM・データSSD・固定IPと旧デモ用バケットは削除済み。Terraform state用バケットは維持する。独自ドメインのHTTPS・認証付き検索も確認済み。接続先は `https://geo.mcp.takeshy.work/mcp`。既存のrun.app URLも引き続き利用できる。

以前のCompute Engine構成は `docker-compose.yml`、`ops/schema.sql`、`scripts/update-osm.sh` に残る。移行中の復旧用であり、最終構成として常時稼働させない。

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

週次更新後のリリースはGCS `current.json` からTerraformが読み取るため、後日のTerraform適用で古いデータへ戻らない。イメージ変更とデータ更新は重ねて実行しない。必要なら週次スケジュールを一時停止し、実行中のJobが終わってからデプロイする。

独自ドメインはGoogleの所有権確認済みアカウントで作成し、Terraformへimport済み。再作成時だけ所有権確認が必要。DNS管理アカウントへの一時権限は撤去済みで、Terraformは既存mappingを維持する。
