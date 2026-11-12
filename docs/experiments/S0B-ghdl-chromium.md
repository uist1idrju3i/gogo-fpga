# S0B: GHDL WASM の Chromium / Node 測定

| 項目 | 値 |
|---|---|
| 状態 | 記録のみ（既定の Os は変更しない） |
| 測定日 | 2026-10-31 |
| 基準 commit | `62db39660d6ac9bdd1a119a33e19f029383c8bb6`（PR #33 の head） |
| 測定 commit | `ddb3880033afbe42f70bb0ad7f4d7ec2e66c13f9` |
| 凍結基準 | [S0B GHDL Chromium 測定の基準](S0B-ghdl-chromium-criteria.md)。原文のコピーは `a7a6df4`、7 fixture への訂正は測定前の `97a25db` |

## 目的と対象

S9B では GHDL の Chromium 測定を行えなかったため、T3-2 のブラウザー統合後に Os と B0 を Node と Chromium で測った。採否は行わず、既定の Os を変更しない。

対象は `tests/synth/ghdl-wasm.test.mjs` の正例7つと、4ボードの `createBlinkTemplate(board, "vhdl")` である。正例には VHDL-2019 の `VHDL-2019 named return identifier` を含め、この例だけ `standard: "2019"` と native `--std=19` を使った。S9B との比較用に、S9B の6例だけの合計も分けて集計した。

各環境・各 variant・各例について、記録しない warm-up を1回行い、その後5回測った。各回で Os と B0 の順を交互にし、`results.csv` の `order` に記録した。`run_ms` は WASM の instantiate 開始から `runGhdlSynth` が Verilog を返すまでで、`compile_ms` は variant・環境ごとに1回だけ測った。

## 環境と成果物

| 項目 | 値 |
|---|---|
| OS | Linux 7.0.0-38-generic |
| CPU | Intel Xeon CPU D-1531 @ 2.20 GHz、12 CPU |
| メモリー | 32,468,660,224 bytes |
| Node.js | v24.22.1 |
| Chromium | 156.0.8078.4 |
| Playwright | 1.64.1 |
| GHDL | 6.0.0 |
| 基準 | `62db39660d6ac9bdd1a119a33e19f029383c8bb6` |
| 測定コード | `ddb3880033afbe42f70bb0ad7f4d7ec2e66c13f9` |

Os は `build/T3-2` の PR #33 成果物を再利用し、既記録の SHA-256 と一致することを確認した。B0 は別の build root で `--variant=B0` を指定してビルドした。

| Variant | GHDL WASM bytes / SHA-256 | `libraries.tar` bytes / SHA-256 |
|---|---|---|
| Os | 2,001,408 / `5c8df2a9102f9bdd577df7e250739876cc29642f8dd7fa0c9844799b0a817c80` | 3,901,440 / `5f08af4dd4ecb42959faf2286b1dba0055ae0b6642c906e60e3688b7ecd04e07` |
| B0 | 2,066,840 / `ed8c9d4b0e7ae20c05eb6e69b0b757bd9b4032dfafe7b3ff874b6f1c1dc009cb` | 同上 |

環境情報は `build/S0B/environment.json` に保存した。測定中に他の build や test が動いていないことを `ps` で確認した。

## 手順

```sh
GHDL_WASM_BUILD_ROOT=build/S0B/B0 \
  scripts/build-ghdl-wasm.sh --variant=B0

mise exec -- node scripts/bench-s0b-ghdl.mjs --verify-negative-controls

set -o pipefail
mise exec -- node scripts/bench-s0b-ghdl.mjs --repeats=5 \
  --server-log=build/S0B/measurement-server-final.log \
  2>&1 | tee build/S0B/measurement-final2.log
```

Chromium は Playwright の headless Chromium を使い、配信した `dist/` の module Worker から `web/lib/ghdl-host.mjs` の `runGhdlSynth` を呼んだ。各回で native GHDL の Verilog hash と比較した。4ボードの例は、生成された Verilog を Chromium/WASI の build pipeline に渡し、`.fs` hash と native GHDL、native Yosys、native nextpnr、native `gowin_pack` の経路で得た期待値を比較した。Yosys、nextpnr、`gowin_pack` の時間は同じ pipeline の `timings` から記録した。

## GHDL の compile / run 時間

各 compile は環境・variant ごとに1回である。次の時間は CSV の `compile_ms` にも記録した。

| 環境 | Os compile (ms) | B0 compile (ms) |
|---|---:|---:|
| Node | 16.533 | 17.551 |
| Chromium | 7.960 | 7.855 |

各セルは run 時間の中央値 `[最小-最大] / 幅`（ms）。幅は最大から最小を引いた値で、各環境・variant・例につき5回である。

### Node

| 例 | Os | B0 |
|---|---:|---:|
| Combinational logic | 30.864 [26.930-59.674] / 32.744 | 30.548 [26.797-46.235] / 19.438 |
| `numeric_std` counter | 48.202 [40.138-54.283] / 14.145 | 49.230 [40.658-53.820] / 13.162 |
| Generic entity | 23.652 [23.512-24.638] / 1.126 | 24.279 [24.201-24.585] / 0.384 |
| FSM | 42.365 [41.620-43.183] / 1.563 | 42.581 [41.548-44.152] / 2.604 |
| Package dependency and entity instantiation | 26.266 [23.694-29.324] / 5.630 | 25.032 [23.985-28.958] / 4.973 |
| Tang Nano 20K LED blink | 40.508 [39.505-42.335] / 2.830 | 41.060 [38.998-42.896] / 3.898 |
| VHDL-2019 named return identifier | 23.433 [20.998-25.773] / 4.775 | 27.257 [24.349-29.574] / 5.225 |
| Tang Nano 1K VHDL template | 39.947 [39.358-44.699] / 5.341 | 40.347 [39.322-40.783] / 1.461 |
| Tang Nano 4K VHDL template | 39.867 [39.358-40.291] / 0.933 | 39.897 [39.623-40.949] / 1.326 |
| Tang Nano 9K VHDL template | 39.509 [39.077-40.235] / 1.158 | 39.575 [39.156-39.932] / 0.776 |
| Tang Nano 20K VHDL template | 39.563 [39.236-39.857] / 0.621 | 40.080 [39.530-40.536] / 1.006 |

### Chromium

| 例 | Os | B0 |
|---|---:|---:|
| Combinational logic | 44.850 [27.615-51.255] / 23.640 | 42.035 [36.970-45.940] / 8.970 |
| `numeric_std` counter | 47.855 [46.215-73.585] / 27.370 | 61.375 [46.415-73.085] / 26.670 |
| Generic entity | 30.890 [24.870-43.480] / 18.610 | 26.725 [25.980-28.690] / 2.710 |
| FSM | 48.470 [44.665-74.685] / 30.020 | 45.875 [42.535-56.060] / 13.525 |
| Package dependency and entity instantiation | 30.110 [22.635-42.205] / 19.570 | 25.380 [24.865-28.935] / 4.070 |
| Tang Nano 20K LED blink | 42.250 [36.520-61.225] / 24.705 | 48.995 [39.335-62.165] / 22.830 |
| VHDL-2019 named return identifier | 29.620 [18.535-37.475] / 18.940 | 27.985 [23.875-34.455] / 10.580 |
| Tang Nano 1K VHDL template | 45.160 [37.460-56.165] / 18.705 | 45.450 [38.820-63.695] / 24.875 |
| Tang Nano 4K VHDL template | 41.100 [34.915-59.155] / 24.240 | 44.295 [37.890-53.660] / 15.770 |
| Tang Nano 9K VHDL template | 42.845 [36.150-54.510] / 18.360 | 43.825 [35.555-47.625] / 12.070 |
| Tang Nano 20K VHDL template | 37.290 [35.970-45.885] / 9.915 | 48.125 [37.425-56.815] / 19.390 |

S9B の6例だけを合計した各 repeat の run 時間について、中央値 `[最小-最大] / 幅`（ms）を別に示す。S0B は T3-2 統合後の別 base と成果物を使うため、S9B の値との直接比較ではない。

| 環境 | Os | B0 |
|---|---:|---:|
| Node | 206.149 [204.083-248.499] / 44.416 | 211.939 [200.719-233.760] / 33.041 |
| Chromium | 261.820 [239.155-315.025] / 75.870 | 238.565 [224.890-283.420] / 58.530 |

## 4ボードの `.fs` と後段 timing

各 board、GHDL environment、variant につき5回の `.fs` がすべて native の期待値と一致した（80/80 runs）。各 board の SHA-256 は次のとおり。

| Board | Native `.fs` SHA-256 |
|---|---|
| Tang Nano 1K | `751a5f3d266c7172723cf043adb02d47c7bc9d5304924459e032c79fc08e46f7` |
| Tang Nano 4K | `769cf0ee2d2fa5f91b0095ff68cc80442b6954e3155b6c14e3a17d25a51a54a7` |
| Tang Nano 9K | `12f29894546d06b3e3510060d2688b820ccde7dbc5463b58459bb88bc20f9933` |
| Tang Nano 20K | `16f96233dbbc90af33256cae3bdc9a12e245e9afbc480e756af47941abf72e3c` |

次の表は Chromium/WASI の Yosys、nextpnr、`gowin_pack` の各 timing の中央値（ms）である。GHDL environment は、その行の GHDL 実行環境を表す。各5回分は CSV に記録した。

| GHDL environment | Board | Os: Yosys / nextpnr / `gowin_pack` | B0: Yosys / nextpnr / `gowin_pack` |
|---|---|---:|---:|
| Node | Tang Nano 1K | 1011.820 / 346.755 / 312.395 | 1015.025 / 378.255 / 291.785 |
| Node | Tang Nano 4K | 985.315 / 402.590 / 546.475 | 999.035 / 407.820 / 547.560 |
| Node | Tang Nano 9K | 999.530 / 508.360 / 828.745 | 963.290 / 509.735 / 833.345 |
| Node | Tang Nano 20K | 978.510 / 1053.210 / 1340.540 | 966.440 / 994.945 / 1341.405 |
| Chromium | Tang Nano 1K | 1041.410 / 353.875 / 307.855 | 956.300 / 331.865 / 294.670 |
| Chromium | Tang Nano 4K | 989.080 / 402.340 / 527.415 | 966.210 / 409.240 / 549.335 |
| Chromium | Tang Nano 9K | 1014.760 / 507.735 / 817.665 | 995.880 / 520.945 / 782.285 |
| Chromium | Tang Nano 20K | 1001.890 / 1006.045 / 1365.795 | 1021.690 / 998.715 / 1365.815 |

後段の値は Chromium/WASI pipeline の時間であり、Node GHDL の値ではない。Node GHDL / Os / Tang Nano 1K / repeat 1 の `pack_ms` は 7042.380 ms だった。同じ group の中央値は312.395 ms、rangeは6779.355 ms である。これは最初の pipeline run であり、pack worker の遅延初期化は候補だが、初期化時間を分離しておらず原因は未確認である。値は除外せず CSV に残した。

## 正しさ、負の対照、失敗した試行

最終 CSV は220行で、Node / Chromium の両方で全行が成功した。native GHDL との Verilog hash は220/220、4 board の native `.fs` hash は80/80一致した。交互順、5回、例の数も CSV から確認した。

tampered WASM は `WebAssembly.compile` で拒否され、tampered expected Verilog は不一致として検出された。現在のスクリプトでの確認ログは `build/S0B/negative-control-wasm-postmeasurement.log` と `build/S0B/negative-control-expected-postmeasurement.log` である。測定前の負の対照も成功し、各 log は `build/S0B/negative-controls.log`、`negative-control-wasm-final.log`、`negative-control-expected-final.log` にある。

| 試行 | 結果 |
|---|---|
| 最初の Chromium 起動 | `openSync is not defined` で起動時に停止し、測定値なし。`build/S0B/measurement-final.log`。不足 import を `bdd543b` で追加した。 |
| 次の測定 attempt | `expected is not defined` により Chromium の測定行110件を失敗として記録した。Node 110行は成功したが、この attempt の Chromium timing は採用していない。CSV を `build/S0B/measurement-attempt2.csv` に、当時の環境情報を `build/S0B/measurement-attempt2-environment.json` に保存した。原因を `ddb3880` で修正した。実行 log は `build/S0B/measurement-attempt2.log`。 |
| 最終測定の後処理 | 220行の成功データを `docs/experiments/S0B/results.csv` に書いた後、過去 attempt の `environment.json` が既にあったため metadata の `wx` 作成が `EEXIST` で失敗した。実行 log は `build/S0B/measurement-final2.log`。古い環境情報を保存し、最終 run の commit hash を含む環境情報を `build/S0B/environment.json` に記録した。CSV の値は変更していない。 |

## 生データとログ

| 内容 | Path / SHA-256 |
|---|---|
| 全220測定行の CSV | [S0B/results.csv](S0B/results.csv)、`4c4c72cea31308369d77f12d4f7d6c709c5ff87418e1d7b6230afc266b9cc91e` |
| 最終 server log | `build/S0B/measurement-server-final.log` |
| 最終 runner log | `build/S0B/measurement-final2.log` |
| 最終 environment | `build/S0B/environment.json` |
| 失敗 attempt | raw CSV と server log を `build/S0B/` に保存 |

## 結論

この測定結果によって既定の Os は変更しない。S0B は Os と B0 の Node / Chromium 時間を記録したものであり、採否を行わない。中央値は例や環境によって異なり、各5回の幅もあるため、ここから一般的な速度の優劣は結論しない。
