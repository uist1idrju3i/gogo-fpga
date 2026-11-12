# S14 製品用スカラー設定によるCPUの正式反復

[S14の事前基準・初回の失敗へ戻る](S14-cpu-library-matrix.md) / [HDLの正式結果](S14-production-hdl.md) / [実験の索引](README.md)

カタログ昇格後の再検査は[全60組の最終回帰と配布ソースの照合](S14-final-regression.md)に分けました。本書の正式反復とは実行したrevision・出力先が異なります。元の反復・失敗ログを新しい結果へ置き換えていません。

## 目的と判定

CPU7候補と4ボードの全28組を検査しました。固定構成のSERV、PicoRV32、NEORV32、Hazard3、VexRiscv生成済みRTL、DarkRISCVは、4K・9K・20Kの18組でnative / WASIの配置配線結果が各5回一致しました。同じ6候補の1Kは容量超過です。FemtoRV Quarkの4組は、native / WASMのIcarusで同じ解析エラーを確認し、frontend非対応と分類しました。

事前基準は[S14の正式反復手順](S14-cpu-library-matrix.md#正式な反復測定の手順)です。正常、容量超過、frontendのA/Aと負の対照を先に検査し、本試行は両系を交互に各5回実行しました。生の配置配線JSON、資源、入出力のhashを照合し、差を正規化しません。正常な本試行だけを性能統計へ含めます。

## 固定条件と再生成

実行commitは `55585c135ed82554b30fc24471ded7c3ef948c01`、前提回帰は `6df08e89e5d8019f16b37e8a0d56ab58d6102d6f` です。開始前・終了後の清浄なcheckout、不変のHEAD、入力・スクリプト・バイナリーのhashを確認しました。前提summaryのSHA-256は `9506d2539d5277368c89f9d6f591a3bd97c61d38db6b1339162a2d05f3f25b8b` です。

実行環境はLinux 6.8.0-1061-aws x64、Intel(R) Xeon(R) Processor、論理CPU 2、メモリー8,327,749,632バイト、Node.js `v24.21.0` でした。配置配線の実版は両系とも `nextpnr-0.11.1`、Icarusは13.0 stableです。HDLとCPUの正式反復を並行実行したため、隔離した性能改善率や速度比は主張しません。

[metadata](S14-production-cpu-metadata.json)に全helper、submodule、実版の出力、Icarus資材、nextpnrバイナリー、build-info、chipdb、パッチ、数値計算設定のhashを保存しました。製品用バイナリーは[HDL正式反復](S14-production-hdl.md#再利用した製品用バイナリー)と同一です。パッチ0002・0004と `EIGEN_DONT_VECTORIZE` を照合しました。上流checkoutは直接編集していません。

固定依存とビルドは[AGENTSの確認コマンド](../../AGENTS.md#10-確認コマンド)に従います。前記の前提commitで回帰を実行し、その出力を保持して、正式反復のcommitで次のdriverを実行しました。

```sh
CPU_MATRIX_EVIDENCE=build/t5-cpu-production-scalar-matrix-3 \
  node --test --test-name-pattern='pinned CPU' tests/synth/gowin-pack.test.mjs

EXPERIMENT_CONCURRENT_WORKLOAD='CPU and HDL formal verification; not isolated speedup benchmarking' \
  node scripts/verify-pnr-library-matrix.mjs --kind cpu \
  --matrix-dir build/t5-cpu-production-scalar-matrix-3 \
  --out build/t5-cpu-production-scalar-formal-2
```

既存の出力先は上書きせず停止します。別試行には新規出力先を使い、版とhashを記録し直します。driverのSHA-256は `2076e35088fc4eb4f235ac9c2883b66fbcbd77d7fa937e244a33db277d63e669` です。計時は配置配線の実行だけで、moduleのコンパイルや前提の合成・下位化・packは含めません。CSVの `matrix_` 列は前提回帰の値で、今回各5回測った値ではありません。

## 結果と証拠

| 区分 | 実行回数 | 判定 |
|---|---:|---|
| 正常な本試行 | 18組 x 2系 x 5回 = 180回 | 生の配置配線JSONと資源が一致 |
| 容量超過の本試行 | 6組 x 2系 x 5回 = 60回 | 数値の資源超過と配置エラーを照合。出力なし |
| frontend非対応の本試行 | 4組 x 2系 x 5回 = 40回 | 同じIcarus解析エラー。合成・配置配線・packの成功ではない |
| A/A | 3経路 x 2組 x 2系 x 5回 = 60回 | 各経路で同じ分類 |
| 負の対照 | 3経路 x 2系 x 5回 = 30回 | 壊した入力や誤った診断の期待値を拒否 |
| CSV全体 | 370行 x 39列 = 14,430値 | passed 200、failed 30、capacity-exceeded 80、frontend-unsupported 60 |

failedの30行は負の対照の期待した拒否で、正常な本試行の失敗ではありません。[生CSV](S14-production-cpu.csv)は全39列を保存しました。全行の状態、終了状態、例外、signal、stderr、hash、資源、前提回帰の値を読み、case別記録と照合しました。[summary](S14-production-cpu-summary.json)の正常18組の最小・最大・中央値は、生CSVから独立に再計算して一致しました。対照、容量超過、frontendは統計に含めません。

| 記録 | バイト列のSHA-256 |
|---|---|
| metadata | `c616787fa8a56f945eb60c8cf5d8ffa02be9eb292184e139beb80c7697a2d3e4` |
| summary | `04b313f2c7f1839c652aa03472f4d50b89b126807633645a1de50514f6b410fc` |
| 生CSV 271,243バイト | `a27b96396b7cb1ac254c2053116d67c11b0c1a77607e15c0421663c4f575379b` |

前提回帰と正式反復の全3,768ファイルは[サイズ・SHA-256の目録](S14-production-cpu-manifest.json)に保存しました。目録には全列監査のhashと集計も含めます。目録はログ本文そのものではありません。大きなログと生成物はコミットせず、上記の固定条件とコマンドから再生成します。

metadata内のcompiler flagsは、prefix mapの入力も含めて測定時の原文を保持しています。これらは個人環境のファイルを再現手順や根拠として参照するものではありません。文書パス検査では、[理由付き例外](../../.github/document-path-allowlist.tsv)のJSON pointerと値のSHA-256が一致する2項目だけを引用として扱い、不要な例外や値の変更を拒否します。metadataのバイト列と上記hashは変更していません。

## 診断、失敗した旧試行と限界

全370行の診断を読みました。正常な配置配線の `Critical path report` はInfoの報告で、エラーではありません。未知セルの負の対照は、`S13_NEGATIVE_CONTROL` と `S13_UNKNOWN_CELL` を含む唯一の配置エラー、非成功の終了、signalなし、期待したWASI例外と配置配線出力がないことを確認しました。容量超過は資源数と診断を照合し、終了状態だけで判定しません。

FemtoRVは宣言前の `instr` 参照をIcarus 13.0が解決できず、`Unable to bind wire/reg/memory` と診断します。上流ソースは変更していません。前提回帰の合成時の警告は今回の配置配線のstderrとは別の記録です。

formal-1は既存LUTを書き換えた負の対照がSERVのwide MUXも壊し、想定した診断より先に失敗しました。[初回の失敗と全2,914ファイルの保全記録](S14-cpu-library-matrix.md#初回の正式反復で見つかった負の対照の不備)を保持しました。formal-2は接続のない未知セルを追加する方式に修正し、新規出力先で実行しました。初回のHDL完走も、今回のcommitの確認には流用していません。

カタログは6候補の4K・9K・20Kをconfirmed、1Kをcapacity-exceededとし、FemtoRVは全ボードをfrontend-unsupportedとして選択できない理由を表示します。固定構成の仮想検証であり、任意のCPU構成、全ISA、ブラウザー画面操作、T6完了を意味しません。Tang Nano実機は本リポジトリでは試していません。source closureと選択制限を有効にした版の最終回帰は別に確認します。

## カタログ昇格後の選択制限と検査の修正

`ad15b1accb5fa57ecb2b3b35df6d919038c0816f` の最終回帰ではHDL全32組が成功しましたが、CPUはSERV / 1Kを通常選択の制限が拒否し、合成前に停止しました。容量超過の入力を製品画面で許可する問題ではなく、検査器が製品と同じ入力経路を使った問題です。CPUのsummaryは成功0・期待28のまま保持し、CPU全体の成功には数えません。

検査器は、容量超過とfrontend非対応の候補について、まず通常選択が拒否されることを確認します。その候補だけを明示的な検査用入力で実行し、容量超過、frontend非対応、正常完走の実測分類がカタログと一致することを要求します。未検証の候補を一括許可せず、confirmedの候補は通常の選択制限を有効にしたまま実行します。既存の証拠ディレクトリは上書きせず、新しい出力先で再検証します。

別の回帰では、Gitの個人設定がない環境で資材生成のfixture commitが失敗しました。システム設定とグローバル設定を無効にすると23件で再現しました。fixtureのGit subprocessだけに検証用author / committerを設定し、同じ設定なしの環境で23件が成功しました。Webから呼ぶ回帰も、毎回Gitの外部設定とidentityを使わない条件に固定しました。開発者やCIのGit設定自体は変更していません。
