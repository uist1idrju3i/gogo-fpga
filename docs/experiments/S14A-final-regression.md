# S14A 演算の縮約修正後の全60組回帰

[演算の縮約の切り分け](S14A-pnr-fp-contract.md) / [実験の索引](README.md)

## 目的と固定条件

heap placerだけに`-ffp-contract=off`を加えた製品用バイナリーで、HDL8候補とCPU7候補の4ボードを再検査しました。以前の正式反復の置換ではなく、修正後の清浄な`2e5e9f28dd359130bc6696ab530bf0af15886273`に対する回帰です。事前基準は[S13・S14の最終回帰](S14-final-regression.md)を維持し、対応状態、終了値、全資源、配置JSON、pack、下位化後のCPU実行を照合します。

全60組は各1回の回帰であり、全組を各5回やり直した結果ではありません。これとは別に、同じrevisionのSERV / 20KでnativeとWASIを各5回、A/Aも各5回実行しました。製品用バイナリーは作り直したものを再利用し、測定の途中で変更していません。診断用の旧CI artifactと、製品用バイナリーは区別します。

Linux 6.8.0-1061-aws x64、Intel Xeon、2論理CPU、メモリー8,327,749,632バイト、Node.js v24.21.0、nextpnr-0.11.1です。元のmetadataに実版、submodule、build-info、compiler、chipdb、入力・スクリプトのhashと清浄な作業treeを保存しました。ホストRSSとWASIの線形メモリーは異なる値です。並行作業があるため、速度改善率を主張しません。

## 結果と全列監査

| 範囲 | 成功 | 容量超過 | frontend非対応 | CSVの行・列・全セル |
|---|---:|---:|---:|---|
| HDL8候補 x 4ボード | 32 | 0 | 0 | 32行119列、3,808セル |
| CPU7候補 x 4ボード | 18 | 6 | 4 | 28行139列、3,892セル |

成功した全50組でnative / WASIの配置JSONが一致し、native / Pyodideのbitstreamも一致しました。成功したCPUは6候補の4K・9K・20Kです。同じ6候補の1Kは容量超過、FemtoRVは全4ボードでfrontend非対応でした。容量超過は両系の資源不足・配置エラー・出力欠落を要求し、nativeの125とWASIの1だけでは分類しません。FemtoRVは元のIcarus解析失敗を保持し、合成・配置配線の成功に数えません。

通常のライブラリー選択APIの拒否とcatalog stateを含め、[HDLの全列CSV](S14A-regression-hdl.csv)と[CPUの全列CSV](S14A-regression-cpu.csv)を生のmeasurementと全出力から作り直して照合しました。表の全7,700セルには空欄も含み、値がある項目はHDL3,064・CPU2,530です。[監査の要約](S14A-regression-audit.json)に全列名、件数、カタログ・元CSV・完全な監査JSONのhashを記録しています。

元CSVはCRLFで出力されます。リポジトリのCSVは改行だけをLFにし、全行・列・値を保持しました。元のCRLF版、完全な監査JSON、生ログは証拠ZIPに元のバイト列で保存しています。要約の`csv_sha256`はZIP内の元CSV、`repository_csv_sha256`はリンク先のLF版を指します。配置JSONやVCDは書き換えていません。

| 記録 | 元のバイト列のSHA-256 |
|---|---|
| HDL CSV | `4531379c49e0398bbf4dc20efaf79df705b93a0ceccd15fad4893474dd7e4565` |
| HDL完全監査JSON | `36e093b934c3b5d34452750bd413f49ef028350b7a1c550ef0ab1ceb0309c716` |
| CPU CSV | `c200da53000f5339ac4edd405d9643df95f1f3a82df76f9f330920272418b7f1` |
| CPU完全監査JSON | `f12b4bfdbb57a042bd74df4fb7435ef96ff32351d184d80ac8e9f0894eda5a5c` |

## 診断と制約

Infoのcritical path reportを除くと、重複しない診断はHDL253行・CPU51行です。前回の[診断の監査](S14-final-regression.md#診断の監査)と同じ種類で、警告を抑止したり元ログを消したりしていません。HDLはtranslate_offとメモリーのレジスター化です。CPUはこれらに加え、SERVの既定parameter・汎用BRAM幅変換、VexRiscvの未駆動信号、未使用のNEORV32 FPU、1Kの配置失敗を含みます。これらの説明を任意の構成の安全性へ広げません。

別にHDL4種62行・CPU3種36行のcritical path reportを確認しました。全てInfoの報告で、エラーではありません。成功した回帰のCPUはlowered netlistの命令実行、RAM/GPIOと保持セル、LED固着の負例も照合します。合成の全セルの形式等価証明や、配置配線後のタイミングシミュレーションではありません。

SERV / 20Kの追加20実行は全て終了0、例外・signalなしで、両系・全反復の配置hashは`d1f5cc0f072c9169c966eb8e5a3f674d041d2fca11b38ec6ea15e394f1887d03`でした。配置値とキー順を変えた負例も拒否しました。

| 試行 | native中央値ms（最小～最大） | WASI中央値ms（最小～最大） |
|---|---|---|
| 修正commitで各5回 | 8,775.2（7,441.5～12,939.2） | 17,696.2（13,862.5～24,242.5） |
| 同じcommitのA/A各5回 | 7,613.1（7,036.9～9,207.7） | 15,769.5（13,207.9～17,408.4） |

## 再実行と証拠の保管

固定ツールとバイナリーを[AGENTSの確認コマンド](../../AGENTS.md#10-確認コマンド)で用意し、前記のrevisionを清浄に保って実行します。既存の出力先を上書きせず、新しいディレクトリを使います。通常の選択制限は有効のまま、非対応の候補だけが検査専用の入力経路を使います。

```sh
HDL_MATRIX_EVIDENCE=build/S14A-hdl CPU_MATRIX_EVIDENCE=build/S14A-cpu \
  node --test --test-concurrency=1 tests/synth/gowin-pack.test.mjs
node scripts/audit-library-matrix.mjs hdl build/S14A-hdl build/S14A-hdl-audit.json \
  2e5e9f28dd359130bc6696ab530bf0af15886273
node scripts/audit-library-matrix.mjs cpu build/S14A-cpu build/S14A-cpu-audit.json \
  2e5e9f28dd359130bc6696ab530bf0af15886273
```

GHDL nativeがホストで起動できない場合は、同じ固定版の隔離環境を`GHDL_NATIVE_BIN`のwrapperで指定します。追加のSERV / 20K反復は[元の再生成手順](S14A-pnr-fp-contract.md#再生成と監査)の製品用とA/Aを使います。別revisionで得た成功を、前記のrevisionの確認へ読み替えません。

元の診断と失敗試行は491ファイルの証拠ZIPに保存済みです。SHA-256は`fa8a253d9c5e04add7b4aa3d5818a9e7d7d75be29f39a0350bd61623cfd25453`です。今回の全60組・追加反復・完全な監査・回帰ログは2,172ファイル、57,217,484バイトの別ZIPに保存しました。SHA-256は`4b6aa99c5b476dcbc51fa7e983bbf1494dd106e520bb3003dece3a8ff7526f56`です。両ZIPのCRCを検査し、[今回の全ファイルのhash目録](S14A-regression-evidence.sha256)を保存しました。ログとバイナリーはコミットせず、セッションでZIPを共有します。

これは手元の製品用バイナリーの検証です。修正後のCI全体は全実装後の別の確認、ブラウザー操作とT6全体も別の残件です。Tang Nano実機は本リポジトリでは試していません。
