# S3 CI の速度改善

- 状態: 結果記録済み（採否未確定）
- 日付: 2026-10-26
- 担当: Devin
- 関連: PR #8 の build workflow

## 目的と仮説

emsdk と fixture の cache、build artifact の job 間共有、sim の 3 shard 化が、CI の結果を保ったまま wall-clock time を短縮できるか調べます。baseline は 843〜864 秒で、sim は約 614 秒、WASM build は約 128 秒、fixture 生成は約 41 秒、Chromium install は約 18 秒です。sim shard は `ae0fc01` の CI log にある per-test duration を使い、LPT で割り当てました。

## 採否の基準（結果を見る前に書く）

- warm run の wall-clock time は、5 回の baseline の中央値の 80% 以下であること。wall-clock time は workflow run の `created_at` から最後の job の完了までとします。
- すべての baseline、cold、warm run で `.wasm` の SHA-256 が `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c`、`.mjs` の SHA-256 が `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` と一致すること。
- 各 run のテスト数が sim 43（3 shard 合計）、Web 30、Playwright 15 であること。

### 2026-10-26 事前登録の追記（計測開始前）

PR #9 の `eaf83bf` で artifact 検査用の Web unit test が12件追加されたため、テスト数の基準は run の系統ごとに次のとおりとします。上記の当初記載は変更せず、この追記を適用します。

| 系統 | sim | Web unit | Playwright |
|---|---:|---:|---:|
| baseline（B） | 43 | 30 | 15 |
| speed-up（S: P/C/W） | 43（3 shard 合計） | 42 | 15 |

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `ae0fc019ae9fc69c73b635772f5124a7b01a9af7` |
| ホスト | GitHub-hosted `ubuntu-26.04` |
| Emscripten / emsdk | emsdk 6.0.13。WASM hash を全 run で照合 |
| Node.js / Chromium | Node.js 24。Playwright の Chromium を毎 run install |
| submodule | 基準は PR #8 の `ae0fc01`。新 workflow では同一 branch commit を build し、sim/E2E は artifact を使う |
| 使ったツールの版 | GitHub Actions release version と SHA は `RESEARCH.md` に記録 |
| 出力先と状態 | `build/`。baseline は従来どおり build、cold は cache 無効、warm は cache 有効 |
| 変える条件 | workflow: baseline、cache 無効の cold、cache 有効の warm |
| 変えない条件 | runner、submodule、build option、test source、期待 artifact hash |
| 繰り返し | baseline 5 回、cold 3 回、warm 5 回。concurrency group の pending run を置き換えないよう順番に dispatch |

## 手順

以下の run はこの記録を作成した時点では開始しません。順に dispatch し、各 run が完了してから次を開始します。

| 順 | variant | 回 | ref | cache |
|---:|---|---:|---|---|
| 1〜5 | baseline | 1〜5 | `devin/1792988632-ci-dependabot` (`ae0fc01`) | 旧 workflow |
| 6〜8 | cold | 1〜3 | `devin/1793006611-ci-speedup` | `workflow_dispatch` の `cache=false` |
| 9〜13 | warm | 1〜5 | `devin/1793006611-ci-speedup` | `workflow_dispatch` の `cache=true` |

wall-clock は Actions run API の作成時刻と最後に完了した job の終了時刻から計算します。各 workflow summary の hash と各 job の test count を記録し、`.csv` に生の値を追加します。

### 2026-10-26 事前登録の実施条件追記

PR #8 の merge 後、baseline branch `devin/1792988632-ci-dependabot` は削除され、PR #9 の base は `main` になりました。`origin/main` の tree は基準 commit `ae0fc01` と同一であるため、未 dispatch の baseline run は `--ref main` で実行し、`ref=main`、`sha=1856fa9` と記録します。計測時点で baseline run は未 dispatch です。merge に伴い `main` に対して起動した build run は測定対象から除外します。B1〜B5 の順序と基準 tree は変えません。

### 2026-10-26 実施時の ref 更新（PR #8/#9 merge 後）

PR #8 の merge commit は `1856fa9`、PR #9 の merge 後の `main` は `8d5ddae` です。`git diff 1856fa9 ae0fc01` と `git diff 696d51d 8d5ddae` はどちらも空でした。このため、削除済み branch の代わりに `1856fa9` 上の `devin/1793010584-ci-baseline` と、`8d5ddae` 上の `devin/1793010584-ci-speed-results` を dispatch 用に作成しました。旧 S branch での priming run も tree が同一のため有効ですが、すべての priming run は統計から除外します。merge に伴う `main` の push run も測定対象外です。

当初は baseline を `main` から dispatch する予定でしたが、後続の指示に従い、実際の B1〜B5 は dispatch 専用 branch `devin/1793010584-ci-baseline` で実行しました。CSV には各 run の ref と SHA を記録しています。

## 計測器の検証

sim shard checker は、各 shard の TAP に失敗がないこと、pass したテスト名と table が一致すること、二重 pass と未使用 entry がないことを検査します。baseline と新 workflow のテスト数および build hash が一致しない run は速度比較に使いません。

## 結果

### wall_s の計算方法

事前登録では `created_at` から最後の job 完了までを wall-clock としていました。計測時の指示に従い、実際の `wall_s` は `max(job.completed_at) - run.run_started_at` で計算し、`queue_s` は `run_started_at - created_at` として別に記録しました。今回の全 run で `queue_s=0` のため、事前登録の式で計算しても値は同じです。

### 測定値

| 系統 | 有効 run 数 | wall_s median [min, max] | sum_job_s median [min, max] |
|---|---:|---:|---:|
| B | 5 | 836 [535, 878] | 833 [531, 874] |
| C | 3 | 404 [394, 407] | 783 [773, 814] |
| W | 5 | 399 [382, 847] | 879 [737, 1357] |

- wall_s の中央値比は W/B = 399/836 = 0.477（47.7%）、C/B = 404/836 = 0.483（48.3%）です。
- sum_job_s の中央値比は W/B = 879/833 = 1.055（105.5%）、C/B = 783/833 = 0.940（94.0%）です。
- warm の wall_s 基準は baseline 中央値の80%（668.8秒）以下です。W の中央値は399秒でした。
- 13件の測定 run はすべて成功し、有効です。W の cache 無効 run はなく、replacement は不要でした。
- 全測定 run と priming run で、`.wasm` は `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c`、`.mjs` は `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` と一致しました。B は各 run で sim 43/43、Web unit 30/30、Playwright 15/15、S（P/C/W）は sim 43/43（3 shard 合計）、Web unit 42/42、Playwright 15/15 でした。

### cache

W の5 runすべてで emsdk と fixture の両 cache restore が hit しました。cache API と restore log で確認した最終状態は次のとおりです。C は `cache=false` のため restore step 自体が無効であり、miss ではありません。

| ref scope | emsdk cache | fixture cache |
|---|---:|---:|
| `refs/heads/devin/1793010584-ci-speed-results` | 493245899 B | 11245 B |
| `refs/heads/main` | 493273815 B | 11243 B |

### 異常値

- W2（run `40315252691`）の Playwright E2E job は705秒で、そのうち Chromium install が680秒でした。
- merge 後の priming run（`40307884219`）の Playwright E2E job は810秒で、Chromium install が783秒でした。
- いずれも成功し、W2 は両 cache hit を確認したため有効 run のままです。遅延の原因は特定できていません。

## 捨てた試行と経緯

失敗 run、無効 run、置換 run はありません。priming run 2件は cache の準備用として記録しましたが、事前登録どおり統計から除外しました。PR merge に伴う main の push run も測定対象から除外しています。

## 結論

事前に決めた 3 つの基準をすべて満たしたので、[#9](https://github.com/gogo-fpga/flasher/pull/9) の構成を採用します。

- **所要時間**：キャッシュありの回（W）の中央値は 399 秒でした。基準（B）の中央値 836 秒の 47.7% で、基準の 80%（668.8 秒）を下回っています。
- **SHA-256**：全 15 回で、`.wasm` と `.mjs` が一致しました。
- **テストの件数**：測った 13 回すべてで、事前に決めた件数と一致しました。

速くなった分の大半は、ジョブの分割によるものです。キャッシュはほとんど効いていません。
- キャッシュなしの回（C）でも、所要時間の中央値は 404 秒（基準の 48.3%）でした。W との差は 5 秒で、回ごとのばらつきより小さい値です。
- build のジョブの中央値は、W が 145 秒、C が 156 秒でした。差の 11 秒は、ほぼテスト用 `.fs` のキャッシュによるものです（生成に C で 27〜31 秒かかります）。
- emsdk のキャッシュは復元でき、W5 のログでは `emsdk install` が「already installed」で飛ばされていました。それでも、WASM のビルドの工程は W が 85〜114 秒、C が 78〜95 秒で、短くなっていません。この工程の時間は、ライブラリーのコンパイルが大半を占めているとみられます。ただし、工程の中の内訳は測っていません。
- runner の使用時間（全ジョブの合計）は、W が基準の 105.5%、C が 94.0% でした。ジョブを分けた分、checkout などの準備が重複します。W の値は、W2 の外れ値（Chromium のインストールに 680 秒）で上がっています。

emsdk のキャッシュ（約 493 MB）は、測れるほどの効果がありませんでした。外すかどうかは、別の PR で判断します。

## 未確認の点

GitHub-hosted runner の混雑による時間の変動と、Chromium install が遅れた原因は特定していません。今回の結果はこの計測期間の runner 状態を反映します。

## ログ

run ごとの ID、wall-clock、hash、test count は [S3-ci-speed.csv](S3-ci-speed.csv) に記録します。
