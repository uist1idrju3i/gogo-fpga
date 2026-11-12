# S5B Yosys・nextpnr の Os／LTO／Os+LTO を Chromium で比較

- 状態: 完了
- 日付: 2026-10-29
- 担当: Devin
- 関連: [S5 WASI ビルド最適化](S5-wasi-build-options.md)
- 基準 commit: `f440ab04fdbe728edf9ac124e6af6221722495ef`
- 事前登録 commit: `153472d265eed41df8739744932221365425c574`

## 目的

Yosys と nextpnr の WASI 最適化案 `Os`、`LTO`、`OsLTO` を、同一セッションで Chromium の合成・配置配線時間と圧縮後サイズを測って比較する。安定性を速度より優先し、S5 の記録を置き換えずに追加結果として残す。

## 仮説

`OsLTO` は `Os` の小さい WASM と `LTO` の実行時間上の利点を両立し、既定案 `B` と同じネットリスト、配置配線結果、`.fs` を生成する。既存の `LTO` と `Os` の結果も同一条件で測り直し、同じ基準で採否を判断する。

## 基準

基準は正式計測前に固定する。候補は `LTO`、`Os`、`OsLTO` とし、安定性条件をすべて満たさない候補は採用しない。

1. Node と Chromium の全対象ボード・全反復で、ネットリスト JSON、配置配線 JSON、`.fs` が同じボードの `B` とバイト単位で一致し、trap または失敗がないこと。
2. 次のいずれかを満たすこと。
   - Chromium の Tang Nano 20K の合成＋配置配線時間の中央値が `B` より 10% 以上速く、かつ `B` と `B2` のこのセッションでの中央値の絶対差より大きく速い。
   - Yosys と nextpnr の zstd-19 圧縮サイズの合計が `B` より 10% 以上小さく、Chromium の Tang Nano 20K の合成＋配置配線時間の中央値が `B` より 5% を超えて遅くない。
3. Yosys と nextpnr の合計 build wall time が `B` の 2 倍以下である。
4. 使用する WASM target feature が、現行安定版 Chromium、Firefox、Safari でサポートされている。
5. 各候補の Yosys と nextpnr を二度ビルドした SHA-256 がそれぞれ一致すること。S5 の成果物は、S5 CSV に記録された SHA-256 と一致した場合に限り、その二度のうち一度として再利用できる。候補の成果物で `node --test tests/synth/*.test.mjs` が 5 回連続で成功し、build peak RSS を記録すること。peak RSS が 14 GiB を超えた候補は、16 GB GitHub-hosted Ubuntu runner に収まらないものとして不合格とする。

S5B の Node 計測は `OsLTO` のみ、4 ボード×5 回とし、全出力を `B` と比較する。Chromium は `B`、`B2`、`LTO`、`Os`、`OsLTO` を4ボード×5回測る。順番は repeat を外側、board を次、variant を内側にして交互に実行する。全 Chromium 試行で合成時間、配置配線時間、合計時間、`.fs` の `B` との同一性を記録する。

採用候補は安定性条件を先に適用してから選ぶ。性能基準を満たす候補のうち Chromium Tang Nano 20K の合成＋配置配線中央値が最も短いものを選ぶ。次点が `|B-B2|` 以内なら、最適化フラグが少ない順 `B < Os < LTO < OsLTO` を優先し、なお同じなら zstd 合計サイズが小さいものを選ぶ。候補がなければ `B` を選ぶ。`LTO` が同じセッションで性能基準 2 のいずれも満たさない場合は、その事実を明記する。

## 条件

| 項目 | 固定値 |
|---|---|
| 基準 commit | `f440ab04fdbe728edf9ac124e6af6221722495ef`（`origin/main`） |
| OS／CPU | Ubuntu 26.04.1 LTS、x86_64、Intel Xeon CPU D-1531 2.20 GHz、6 core／12 thread |
| メモリー | 32 GiB RAM、swap 8 GiB |
| Node.js／npm | Node.js 24.22.1、npm 11.19.1 |
| Chromium | Playwright 1.64.1、Google Chrome for Testing 156.0.8078.4 |
| WASI SDK | 34.0、clang 23.1.0-wasi-sdk |
| Yosys／nextpnr | submodule `vendor/yosys` `28ba3cb926fe376fa05ebfc1b921747d011d4557`、`vendor/nextpnr` `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` |
| 出力先 | build 根は `build/s5b/`。CSV は `docs/experiments/S5B-os-lto-chromium.csv`。ログは `build/s5b/logs/` 以下に保存し、失敗ログも保持する。 |
| 比較 variant | `B`、`B2`、`LTO`、`Os`、`OsLTO` |
| OsLTO の最適化 | Yosys は S5 `LTO` のフラグを使い、B の最適化を `-Os` に置き換える。nextpnr は `USE_IPO=OFF`、`-Os`、明示的な `-flto` を使い、`-flto=thin` がなく、全 object が LLVM bitcode であることを検証する。SHA-256 は `B`、`LTO`、`Os` の各成果物と異なること。 |
| 繰り返し | 候補 A/A は Yosys と nextpnr を各2回。Node は `OsLTO` の4ボード×5回。各候補で Node test glob を5回連続。Chromium は5 variant×4ボード×5回、repeat→board→variant 順。 |
| 測定環境 | Chromium 計測中はマシンを他の重い処理に使わず、開始時の load average と稼働プロセスを記録する。 |
| S5 からの再利用 | 各成果物を S5 CSV の `wasm_sha256` と照合してから決める。比較対象の CSV 行、成果物 hash、build time、peak RSS を記録する。 |

S5 の `B` build time は Yosys 838.420 s、nextpnr 93.910 s、合計 932.330 s である。したがって基準 3 の上限は 1,864.660 s。S5 の基準 `B` zstd-19 合計は 15,253,172 bytes。S5 の SHA-256 は Yosys `05598a8d79b716f8711287b2e16610f8a0a7f8610ff9bdfbf6b1ce19839ff037`、nextpnr `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f`。

## 手順

1. S5 の全候補成果物の SHA-256 を S5 CSV と照合し、一致したものだけ再利用する。欠落または不一致は S5 harness でビルドする。
2. `scripts/run-s5-matrix.py` の `OsLTO` variant を使って各候補をビルドし、build wall time、peak RSS、WASM の raw size、zstd-19 size、SHA-256、コマンドとログを記録する。各 LTO／Os／OsLTO の A/A SHA-256 を確認する。OsLTO nextpnr の LTO・IPO・bitcode validator を通す。
3. OsLTO の Yosys と nextpnr WASM をそれぞれ1 byte 改変する負の対照を行い、改変成果物が元の SHA-256 ではなく、WASM validator に拒否されることを確認する。
4. LTO、Os、OsLTO の候補成果物を一つずつ `S5_WASI_ROOT` から指定して、`node --test tests/synth/*.test.mjs` を各5回連続で実行する。全出力を保存する。
5. `scripts/run-s5-matrix.py --phase node` で `B` と OsLTO を使い、4ボード×5回の Node 行列を測る。netlist JSON、PnR JSON、`.fs` の identity を記録する。
6. `scripts/run-s5-matrix.py --phase chromium` で B、B2、LTO、Os、OsLTO を交互に測る。順番は repeat→board→variant。各試行の synth、PnR、total、`.fs` identity と raw log を保存する。
7. CSV の全試行を用いて中央値、B–B2 noise、圧縮サイズ、各基準の pass/fail、および選定規則を計算する。失敗・無効試行も削除せず CSV とログに残す。

正式実行コマンドは、事前登録 commit SHA を追記した後に実行し、CSV とこの記録の「ログ」節にそのまま転記する。出力・ログのリポジトリ内パスは `$REPO_ROOT` を基準に記録し、個人環境の絶対パスはコミットしない。

## 結果

### 手順/結果: 基準 1 の Chromium 中間出力の追加確認

> 基準 1 の Chromium 中間出力の一致は、事前登録した計測ログに記録項目がなかったため、同じ成果物での追加の一致確認で確かめた

- 実施日: 2026-10-29
- 計測コード commit: `dc9769cb9f95802d66182823e3cebcbfd65f35cc`
- 試行とハッシュの補足 CSV: [S5B Chromium identity 補足記録](S5B-os-lto-chromium-identity-supplement.csv)
- 生ログ: `build/s5b/chromium-artifacts/identity-run/playwright.log`
- `S5_RECORD_INTERMEDIATE=1` を指定し、同じ OPFS 成果物 `build/top.json`、`build/top_pnr.json`、`build/top.fs` の SHA-256 を記録した。計100試行がすべて成功し、追加 run の時間は選定に使わない補足値として CSV に保存した。

| variant | netlist JSON (`top.json`) | PnR JSON (`top_pnr.json`) | bitstream (`top.fs`) |
|---|---:|---:|---:|
| B | 20/20 | 20/20 | 20/20 |
| B2 | 20/20 | 20/20 | 20/20 |
| LTO | 20/20 | 20/20 | 20/20 |
| Os | 20/20 | 20/20 | 20/20 |
| OsLTO | 20/20 | 20/20 | 20/20 |

候補ごとに4ボード×5回の全試行を、同じボードの B と比較した。Node の OsLTO 行列も4ボード×5回で、netlist JSON、PnR JSON、`.fs` がすべて B と一致した。比較器の負の対照として、B の Tang Nano 1K と4Kの PnR hash を比較すると不一致を検出した。1K は `0c5333b0a74a2457a427c179485fe1e283d2689422d399b12933952ca2a6278c`、4K は `c36b24081b34d4f2e430920a83758a0689099abe63575e1e5ee9bfb1bcaf9922` である。

### 正式計測の性能とサイズ

以下の Chromium 時間は事前登録した正式計測の中央値であり、追加 identity run の時間は含まない。B の20K中央値は合成 1,646.455 ms、PnR 1,024.965 ms、合計 2,671.420 ms。B2 はそれぞれ 1,629.765 ms、965.970 ms、2,586.175 ms で、`|B-B2|` の合計時間差は 85.245 ms だった。サイズは Yosys と nextpnr の合計、zstd は `-19` の bytes である。

| variant | 20K 合成 / PnR / 合計中央値 (ms) | B より速い割合 | WASM raw 合計 (bytes) | zstd-19 合計 (bytes) | build wall 合計 (s) | 最大 peak RSS (KiB) |
|---|---:|---:|---:|---:|---:|---:|
| LTO | 1,292.080 / 1,035.405 / 2,344.315 | 12.245% | 72,856,165 | 13,476,347 | 1,687.650 | 7,795,916 |
| Os | 1,349.360 / 1,032.140 / 2,397.160 | 10.266% | 81,305,645 | 13,268,893 | 830.400 | 909,200 |
| OsLTO | 1,079.375 / 1,055.240 / 2,122.105 | 20.563% | 62,934,115 | 11,327,113 | 1,294.710 | 5,687,276 |

### 安定性と基準の判定

| variant | Yosys A/A SHA-256 | nextpnr A/A SHA-256 | 連続 Node test | 最大 RSS | 基準 1 | 基準 2 | 基準 3 | 基準 4 | 基準 5 |
|---|---|---|---:|---:|---|---|---|---|---|
| LTO | `9fa3304768875a02e10b08c5f84c2b2125831197e47d9e66a2289d0449c8f331` | `fd4b6d1edccd2ac5558b1f9447d20fe83409ff1615aeee94a58294e440fd4b73` | 5/5 pass | 7,795,916 KiB | pass | pass | pass | pass | pass |
| Os | `96e6b8da4a8aff3e09d6ca0d641f69e3fe65fde5e92f1d7c70708180bde540de` | `27289a60442a513b0ffa65746ea0be31355377f3326d6602369f318e021a8c4b` | 5/5 pass | 909,200 KiB | pass | pass | pass | pass | pass |
| OsLTO | `b9d9723c52223bfc9a3a77ca1b78a44853dc8c23f38df44e65effcdfec9ee744` | `a7fb73ed785b9649e94810edca60fbc76aa6c0de4b40fc403406f7996720defb` | 5/5 pass | 5,687,276 KiB | pass | pass | pass | pass | pass |

LTO は S5 の Yosys と nextpnr 成果物を A1 として再利用し、S5 CSV の SHA-256 と一致することを確認した。Os は Yosys の S5 成果物を再利用した一方、nextpnr は S5 の成果物とは異なるため、S5B の A2/A3 一致で判定した。OsLTO は両ツールとも S5B 内の A/A で一致した。LTO の表の合計 build time は A2 Yosys の 1,537.670 s と nextpnr の 149.980 s を合算した値である。nextpnr 自体は 30,492,749 bytes の WASM を生成し、S5 成果物と同じ SHA-256 `fd4b6d1edccd2ac5558b1f9447d20fe83409ff1615aeee94a58294e440fd4b73` で build log も完了を記録した。一方、検証 harness は期待された B 参照成果物のパスが欠けていたため、この行を無効として記録した。A/A のハッシュ一致は生成物と S5 CSV を照合して判定し、この無効行とログも CSV と build 配下に保持した。

基準 2 は3候補すべてが速度条件とサイズ条件の両方を満たした。圧縮サイズは B の 15,253,172 bytes に対して LTO が 11.649%、Os が 13.009%、OsLTO が 25.739% 小さく、いずれも B より速いためサイズ条件も満たす。速度条件では各候補の改善幅が10%以上で、B–B2 noise の 85.245 ms を超えた。基準 3 の上限 1,864.660 s に対し、3候補の合計 build time はすべて上限内だった。基準 4 は WASI SDK 34 の標準 target feature (`bulk-memory`、`multivalue`、`mutable-globals`、`nontrapping-fptoint`、`reference-types`、`sign-ext`) を対象とし、確認した現行安定版 Chromium、Firefox、Safari でサポートされる。基準 5 の最大 peak RSS は14 GiB未満で、各候補の A/A と連続5回の Node test も通過した。

全候補が安定性条件を含む基準を満たした。凍結した選定規則を適用すると、正式 Chromium 計測で最も速い **OsLTO** を選ぶ。これは実験上の選定結果であり、既定 build script はこの変更では変更しない。既定への反映は [PR #24](https://github.com/gogo-fpga/toolchain/pull/24) で行った。

### OsLTO Node 行列の時間

Node の4ボード×5回の行列では、合成 / PnR の中央値は Tang Nano 1K が 875.207 / 357.866 ms、4K が 854.038 / 373.233 ms、9K が 849.436 / 517.541 ms、20K が 850.176 / 993.335 ms だった。各試行の時間と出力比較は S5B CSV と `build/s5b/node-runs/OsLTO/` に保存した。

### CSV とログ

- 正式計測 CSV: [S5B Chromium 計測](S5B-os-lto-chromium.csv)。失敗・無効試行を含む1,010行を保持する。
- 追加 identity run CSV: [S5B Chromium identity 補足記録](S5B-os-lto-chromium-identity-supplement.csv)。100試行の各時間は補足値であり、選定には使わない。
- 正式 Chromium 生ログ: `build/s5b/chromium-artifacts/chromium-runs/playwright.log`
- 追加 identity run 生ログ: `build/s5b/chromium-artifacts/identity-run/playwright.log`
- 候補別 Node test logs: `build/s5b/test-suite/{LTO,Os,OsLTO}/repeat-{1..5}.log`
- OsLTO Node matrix: `build/s5b/node-runs/OsLTO/`
