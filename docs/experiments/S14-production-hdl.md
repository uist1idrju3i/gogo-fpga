# S14 製品用スカラー設定によるHDLの正式反復

[S14の目的・基準・CPU試行へ戻る](S14-cpu-library-matrix.md) / [実験の索引](README.md)

## 目的と判定

`EIGEN_DONT_VECTORIZE` を採用した製品用nextpnrで、HDLの8部品と4ボード、全32組のnative / WASI一致を再確認しました。結果は32組全て一致です。CPUの28組の分類や反復は、この結果に含めません。実機と画面操作は本リポジトリでは試していません。

事前基準は[S14の正式な反復測定の手順](S14-cpu-library-matrix.md#正式な反復測定の手順)です。全組の合成・配置配線・packを前提とし、A/Aと負の対照を先に確認してから、各組のnativeとWASIを交互に各5回実行します。生の配置配線JSON、資源、入力と出力のhashを照合し、差を正規化しません。時間の統計に対照や失敗行を混ぜません。重い反復はCIに追加しません。

## 固定した条件

| 項目 | 実際の条件 |
|---|---|
| 実行コード | commit `55585c135ed82554b30fc24471ded7c3ef948c01`。開始前と終了後に清浄なcheckoutと同じHEADを確認 |
| 前提の全体回帰 | commit `6df08e89e5d8019f16b37e8a0d56ab58d6102d6f` の `build/t5-hdl-production-scalar-matrix-3`。32/32組成功 |
| 前提summary SHA-256 | `2c0c374cd145fd3e716766078bfaebfb6848100a45fafc08c34111072ac0cf43` |
| 出力先 | `build/t5-hdl-production-scalar-formal-2`。新規ディレクトリーとし、既存出力は上書きしない |
| ホスト | Linux 6.8.0-1061-aws x64、Intel(R) Xeon(R) Processor、論理CPU 2、メモリー8,327,749,632バイト |
| Node.js | 実際の実行版 `v24.21.0` |
| 実nextpnr | 全35caseのnative / WASIの実行版が `nextpnr-0.11.1` で一致 |
| 負荷 | CPU側の正式反復を並行実行。開始時load averageは0.22 / 0.80 / 1.24、終了時は2.52 / 1.52 / 1.45 |
| 計時範囲 | 配置配線の実行だけ。WASM moduleのコンパイル、前提回帰の合成・下位化・packは繰り返しの計時に含めない |

前提の全体回帰と今回の反復は、別のcommitの記録です。前提の各入力、ZIP、netlist、制約、出力と状態を読んで照合しましたが、前提の合成やpackを新しいcommitで再実行したとは書きません。CSVの `matrix_` 列も前提回帰の値で、各5回の再測定ではありません。

測定スクリプトのSHA-256は `2076e35088fc4eb4f235ac9c2883b66fbcbd77d7fa937e244a33db277d63e669` です。helperのhash、全submoduleの固定版、chipdbとパッチのhashは[metadata](S14-production-hdl-metadata.json)に保存しました。実行中のスクリプト、バイナリー、入力、HEADを変更せず、終了後にも固定値を照合しました。

nextpnrの版はタグだけから推定せず、対照を含む全35caseのmetadataに保存した両backendの `--version` の出力を読み、一致を確認しました。

```text
"nextpnr-himbaechel-gowin" -- Next Generation Place and Route (Version nextpnr-0.11.1)
```

### 再利用した製品用バイナリー

nextpnrの取得元は `https://github.com/YosysHQ/nextpnr.git`、固定版は `nextpnr-0.11.1` / `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` です。既存の製品用成果物を使い、新たなビルド時間は測っていません。

| 種類 | SHA-256 | バイト数 | build-info.jsonのSHA-256 |
|---|---|---:|---|
| native | `9b8865b8cc784a205861a1b2788bcc6f33f41255cd13ee0dc5dcae834b79d1e9` | 55407256 | `4c21e7c0702d0f6ef9a8c0059cbff3279da88e049b6f05a37030979cb1405583` |
| WASI | `70ee0c70f83069329240c6c19115ba6b548e1937261e8d0da9630141bca1f684` | 27884801 | `196a37b9ecbacf23d77a7b9e6430d3462f539e9227a0e90a9d5e0c3672b959f5` |

両方とも、同座標の切断候補を安定順にする `0002-stabilize-equal-coordinate-cuts.patch` と、同一grid keyの列挙順を固定する `0004-stabilize-segment-grid-order.patch` をビルド時に適用しています。`common/place/placer_heap.cc` の `EIGEN_DONT_VECTORIZE` もbuild-infoで照合しました。上流のcheckoutは直接編集していません。採否の経緯は[S13](S13-nextpnr-determinism.md)と[S14](S14-cpu-library-matrix.md)に残しています。

## 手順と再生成

依存・固定版の準備は[AGENTSの確認コマンド](../../AGENTS.md#10-確認コマンド)に従います。前提回帰はcommit `6df08e89e5d8019f16b37e8a0d56ab58d6102d6f` の清浄なcheckoutで、製品用のnative / WASI成果物を揃えて実行しました。

```sh
HDL_MATRIX_EVIDENCE=build/t5-hdl-production-scalar-matrix-3 \
  node --test --test-name-pattern='pinned HDL libraries build' tests/synth/gowin-pack.test.mjs
```

正式反復はcommit `55585c135ed82554b30fc24471ded7c3ef948c01` の清浄なcheckoutで、同じ前提出力を保持して実行しました。

```sh
EXPERIMENT_CONCURRENT_WORKLOAD='CPU and HDL formal verification; not isolated speedup benchmarking' \
  node scripts/verify-pnr-library-matrix.mjs --kind hdl \
  --matrix-dir build/t5-hdl-production-scalar-matrix-3 \
  --out build/t5-hdl-production-scalar-formal-2
```

同じ出力先を使う再実行は拒否されます。別の試行には新しいディレクトリーを指定し、固定条件とhashを再記録します。時間の絶対値はホストや負荷が変われば変動します。

## 結果と生データ

| 区分 | 組数・回数 | 判定 |
|---|---:|---|
| 本試行 | 32組 x 2系 x 5回 = 320回 | 全て配置配線の生JSONが前提回帰と一致 |
| A/A | 2組 x 2系 x 5回 = 20回 | 同じ正常入力で一致 |
| 負の対照 | 1組 x 2系 x 5回 = 10回 | 未知セルを拒否し、配置配線出力なし |
| CSV全体 | 350行 x 39列 = 13,650値 | 本試行320行とA/A20行が `passed`。期待した負の対照10行が `failed` |
| 性能の統計 | 正常な本試行32組のみ | 対照の30行を除外。各backendのcountは5 |

ライブラリーはlibfpga、Colibri、Open Logic、hdl-modules、verilog-axis、verilog-uart、verilog-axi、verilog-ethernetです。各部品をTang Nano 1K / 4K / 9K / 20Kで確認しました。代表部品と設定についての結果で、ライブラリーの全機能や任意の設定の保証ではありません。

[生CSV](S14-production-hdl.csv)は39列を省略せず保存しています。`status`、`valid`、終了状態、例外、signal、stderrと入出力のhash、資源、元の全体回帰の値を全行で読み、各backendの記録とも突き合わせました。[summary](S14-production-hdl-summary.json)の全32組の最小・最大・中央値を、生CSVの正常な本試行から独立に再計算して一致を確認しました。

| 記録 | バイト列のSHA-256 |
|---|---|
| metadata | `66f391bd78d132712ec425e64f7554666582ae41643383d9efc9071315382d20` |
| summary | `af77ade03e7038391c3203091604e67c7781d67c874f8b485cfeb11b396edbd3` |
| 生CSV 288,254バイト | `b345cd00882f391fbc3693e972811fc715f891d00ddc89fb7a79a4687616e4c1` |

### Tang Nano 20Kの絶対値

単位は配置配線のmsで、表示は中央値 [最小, 最大]、各5回です。全4ボードの詳細はsummaryと生CSVに保存しています。WASIメモリーは線形メモリーのバイト数であり、hostのpeak RSSではありません。この表のメモリーは各5回で同じ値でした。

| 部品 | native ms | WASI ms | WASI memory bytes |
|---|---|---|---:|
| libfpga | 167.049 [165.624, 176.833] | 346.547 [308.629, 503.549] | 32243712 |
| Colibri | 172.809 [168.091, 175.393] | 306.529 [302.950, 498.119] | 32964608 |
| Open Logic | 432.000 [203.530, 444.076] | 596.997 [391.489, 837.610] | 33816576 |
| hdl-modules | 211.501 [191.718, 400.554] | 502.028 [359.311, 691.715] | 33292288 |
| verilog-axis | 227.557 [213.149, 250.085] | 431.152 [403.690, 596.668] | 35323904 |
| verilog-uart | 564.045 [562.151, 660.492] | 1023.591 [966.080, 1246.965] | 39190528 |
| verilog-axi | 277.136 [259.834, 296.530] | 535.176 [477.942, 715.619] | 35913728 |
| verilog-ethernet | 275.896 [258.854, 372.749] | 552.066 [461.114, 722.891] | 35192832 |

CPU側との並行負荷があるため、以前のprofileとの性能改善率や、隔離条件でのnative対WASIの速度比は主張しません。採否は全バイト一致と対照の正しさを優先します。

## 警告、エラーと旧試行

全350行のstderrを読みました。本試行とA/Aに `ERROR:` はなく、`Critical path report` は `Info:` の配置配線報告です。負の対照10行だけが次の唯一のエラーを含みます。

```text
ERROR: Unable to place cell 'S13_NEGATIVE_CONTROL', no BELs remaining to implement cell type 'S13_UNKNOWN_CELL'
```

その `0 warnings, 1 error` は期待した拒否で、正常回路の失敗ではありません。終了状態は非成功でsignalなし、WASIの例外は期待した `WebAssembly.Exception` だけで、配置配線JSONがないことも照合しました。前提回帰の合成時の警告は、反復のstderrとは別の記録です。

以前のformal-1はcommit `6df08e89e5d8019f16b37e8a0d56ab58d6102d6f` の記録です。HDL側は完走しましたが、CPU側は既存LUTを書き換えた負の対照でMUXを壊し、想定外の診断で停止しました。失敗と訂正は[S14の初回の正式反復](S14-cpu-library-matrix.md#初回の正式反復で見つかった負の対照の不備)に保存しています。旧出力を上書きせず、formal-2は新しい出力先へ実行しました。旧HDLの完走を、新しいcommitの検証の代わりには使いません。

## 限界とソース

これは固定した代表回路、制約、device data、製品用バイナリーでの検証です。FPGA実機、任意の回路、全ISA、ブラウザーの画面操作を確認した結果ではありません。CPUの対応状態とも区別します。SBYなどによる形式検証の実装完了を意味するものでもありません。

nextpnr本体とパッチはISC、Eigenなどの依存の原文と配布条件は[THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)に従います。HDLの原典、ライセンス、固定版、カタログ生成とソースアーカイブは[ライブラリーの調査](../research/hdl-libraries.md)を参照してください。後続の配布で、ここに固定したバイナリーや入力を別の成果物に取り違えないことが必要です。
