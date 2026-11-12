# S8B Pyodide parity のジョブ分割

- 状態: native の再現と旧 CI の調査は完了。分割後の CI は確認中
- 日付: 2026-11-12
- 担当: Devin
- 基準: `ae15e45ce32cb42008f04eb9dfcd0c114cf34e7a`
- 関連: [実験索引](README.md)、[PR #2](https://github.com/uist1idrju3i/gogo-fpga/pull/2)

## 目的と判定基準

`Pyodide gowin_pack` が60分で中止され、後続のPlaywrightを実行できない原因を調べる。native nextpnrの停止、資材の取得待ち、検査全体の時間超過を区別する。

最初の5回は原因を絞る診断として実行した。性能改善の正式比較ではない。分割を採用する基準は、全検査を二つの実行の和として保持し、各ジョブが従来どおり60分以内に成功し、後続のPlaywrightも実行されることとする。timeoutを延ばしたり、回路・ボード・反復・失敗対照を減らしたりしない。

## 旧 CI で実際に進んだ処理

旧toolchainリポジトリーのジョブログを取得した。識別番号は原記録の照合用であり、旧リポジトリーの削除後に取得できるとは扱わない。

| run / job | 結果 | HDL行列 | CPU行列・最後の結果 |
|---|---|---:|---|
| 42499376048 / 128805757750 | 成功、ジョブ全体57分46秒 | 1,366.713秒 | 1,971.014秒、全件完了 |
| 42520930101 / 128855370474 | 60分で中止 | 1,592.053秒 | darkriscv/4Kまで成功 |
| 42496708847 / 128788841175 | 60分で中止 | 1,635.051秒 | darkriscv/1Kまで成功 |
| 42622201511 / 129191851028 | 60分で中止 | 1,570.134秒 | darkriscv/4Kまで成功 |

成功runのparity stepは17:29:06から18:25:04まで、約56分を使った。darkriscvの9Kは131.917秒、20Kは110.264秒で成功している。これらは合成・下位化・native/WASI配置配線・packを含むサブテスト全体の時間であり、nativeだけの値ではない。

scheduleのrun 42622201511では、資材検証は13:35:29の同じ秒内で成功した。parity stepは13:35:29から14:34:16まで進み、HDL32組とCPUのdarkriscv/4Kまで成功した。次は行列の順序からdarkriscv/9Kで、終了処理はnative nextpnrを強制終了している。ただし中止したケースの入力artifactは残っておらず、実行途中のnative入力をバイト単位で照合したわけではない。

workflowの`pyodide-pack`は`gowin-pack.test.mjs`を一度実行する。その中でHDL行列とCPU行列を順番に処理し、各組のnative/WASI配置配線とpackを待つ。成功runでも二つの行列だけで約55.6分を要する。中止runのHDLは成功runより約3.4〜4.5分長い。途中のケースを多数完了し、異なるCPU/boardの位置で中止していることは、単一のnextpnr呼び出しが常に停止する説への反証になる。

確認した原因は、二つの重い行列を一つの60分ジョブに直列で載せ、実行時間の揺れを吸収できないこと。資材準備が主な待ち時間だったという根拠はない。過去の中止時点の内部状態まで復元したわけではなく、あらゆる入力でnextpnrが停止しないという主張もしない。

## native nextpnr のローカル再現

使った回路は`tests/fixtures/cpus/darkriscv.v`と固定版darkriscvの`rv32i`部品、ボードはTang Nano 9K。既存parityと同じZIP export/import、入力準備、WASI Yosysの`synth_gowin`、CST生成を通す。native配置配線の引数も`nextpnr-helpers.mjs`の`pnrArgs`を使う。

```sh
--seed 73421 --device GW1NR-LV9QN88PC6/I5 \
  --vopt family=GW1N-9C --vopt cst=constraints/board.cst \
  --json top.json --write native-pnr.json
```

| 条件 | 値 |
|---|---|
| ホスト | Ubuntu 22.04.5、2 CPU、メモリー7,942 MiB |
| Node.js | v24.21.0 |
| nextpnrの実表示 | Version 62e659e |
| nextpnr binary SHA-256 | `20b610bc2178136cc9645b36653aa680d6f45cc64c7d03007e7900cef277d7b9` |
| 資材 | このPRのrun 43212311703の`ci-nextpnr-43212311703`を再利用。コンパイラーの再ビルドなし |
| 入力SHA-256 | `22b9d398091a4d66834fb0dd937e88f4ef92eb1a81edcb59d3719cc9e59c9d5b` |
| 出力SHA-256 | `edfc8cd1f8ae3fe0ea76fc1421b1e5f64cab19ac3274a2fd2d7a26473311ca39`、5回とも一致 |

再実行用のscriptは新しい出力先を要求する。入力と資材は作業場所で再生成されるため、絶対パスを含むJSONのhashは別の場所では変わりうる。旧中止runのJSONと同じhashだとは扱わない。

```sh
# CI資材を既存ファイルと衝突しない場所に取得する。
gh run download 43212311703 --repo uist1idrju3i/gogo-fpga \
  --name ci-nextpnr-43212311703 --dir build/pr2-inputs
chmod +x build/pr2-inputs/native/nextpnr/nextpnr-himbaechel-gowin
S5_NATIVE_ROOT=build/pr2-inputs/native \
  node scripts/bench-cpu-native-pnr.mjs --cpu darkriscv \
  --board tangnano9k --output build/pr2-darkriscv-9k --repeats 5
```

WASI Yosysとshareは事前に`build/wasi/yosys`へ用意する。固定HDLライブラリーのsubmoduleも必要。資材の保持期限が過ぎたら、同じ固定ソースから作り直す。

5回のnative実行はすべて終了0で、中央値33.127秒、最小32.649秒、最大33.848秒だった。[生データ](S8B-pyodide-parity-shards.csv)にミリ秒値を記録した。最初の2回も同じ入力・引数・出力で、時間は32.649秒と33.127秒だった。不正なdeviceの対照は`unable to load uarch`、終了非0を返した。scriptの不正CPUと不正boardも失敗した。

## 修正

`pyodide-pack`を`hdl`と`cpu`の二つのmatrix jobにする。`fail-fast: false`、各60分は維持する。

- CPU側は既存のCPU行列を名前のprefixで選ぶ。全7候補・4ボード、容量超過とfrontend非対応の分類、下位化後の実行、native/WASI JSON、bitstream照合をそのまま実行する。
- HDL側はCPU行列だけを除外し、残りの同ファイルの検査、HDL32組、独立scoreboard、parity補助検査、形式検証を従来どおり実行する。
- prefixは子テストにも一致する形にする。同じNodeで入れ子の模擬テストを実行し、CPUの正常・容量超過・frontend非対応とHDLが、重複も欠落もなく二つに分かれることを確認した。
- 失敗artifact名はsuite別にする。共通pack資材はHDL側が一度だけuploadする。
- Playwrightの`needs.pyodide-pack.result == 'success'`は維持する。matrixの全成功が必要で、片側の失敗を無視しない。

## 分割後のCI

修正commit `c3dc11bf19942de49fc0c934d3653a6750820e09`の[PR run 43215356976](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43215356976)で、Cloudflare Pagesを除く20 checkがすべて成功した。[CI生データ](S8B-pyodide-parity-shards-ci.csv)の所要時間は各1回の値で、runner間の性能差を測るものではない。

| suite | job全体 | parityのNode計測 | parityの成功数 | 失敗・skip |
| --- | ---: | ---: | ---: | --- |
| CPU | 23分50秒 | 1,352.628秒 | 29 | 各0 |
| HDL | 28分37秒 | 1,633.355秒 | 62 | 各0 |

parityの合計91件は、旧成功runの91件と同じ。HDL側に残した形式検証84件と独立再実行7件も成功した。各jobが60分以内に終了し、後続のPlaywrightも実行された。job `131190637679`の結果は76 passed、4 skippedで、所要時間は13分13秒だった。4 skippedは、`S5_CHROMIUM_VARIANT`と`S5_ASSET_DIR`の指定時だけ動くS5計測で、通常のCIでは従来どおり除外される。この条件は変更していない。Cloudflare Pagesの失敗はowner側の別件として扱い、この変更では回避していない。

## 未確認の点

ローカルではparity全体を再実行せず、問題のnative配置配線と選択境界を確認した。旧runnerとローカルの速度は直接の性能比較にしない。実機のTang Nanoでは試していない。
