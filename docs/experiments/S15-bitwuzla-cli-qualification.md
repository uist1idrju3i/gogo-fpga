# S15 P4 BitwuzlaのCLI比較と独立監査

- 状態: CLIの正式5回・A/A 2回と全列監査が成功。SMTBMC接続・製品認定は未完了
- 前段: [固定依存と診断ビルド](S15-bitwuzla-build.md)
- 戻り先: [実験索引](README.md)

## 目的と事前基準

上流Bitwuzlaのnative版とWASI版で、同じSMT入力への応答、異常終了、明示的に未対応の機能を比較します。ソルバーの意味論は変更しません。両版の診断バイナリーを同じ清浄なcommitから別々にビルドし、原本の構文エラーでtrapする旧WASIバイナリーを負の対照に残します。旧版のtrapは成功として数えません。

1. `--wrap-mode=nodownload` と固定GMP・MPFR・CaDiCaL・SymFPU、上流Mesonのoverlay、原license、全patch、実行したコマンドと終了状態を独立に照合します。バイナリーと全静的libraryのhash、WASIの終了境界、未対応thread・RSSも照合します。失敗ビルドや作業中の変更を正式結果へ含めません。
2. 版表示、help、bit-vectorの値取得とpush/pop、EOF、構文エラー、model、time limit、浮動小数点の5丸め方式とNaN、配列の計14条件を各版で実行します。正常系は終了状態・stdout/stderrを照合します。WASIのtime limitはthread非対応の診断とtrapを記録し、SAT判定や外部workerの期限と混同しません。
3. 旧WASIの構文エラーは別の負の対照として `runtime-error`、終了codeなし、trapを要求します。修正版は両版で同じ診断文を出し、終了code 1を要求します。元のWASIがtrapしない場合も監査は失敗させます。
4. 各条件の元入力、stdout、stderr、JSON、CSVの全14列、バイナリーとmetadataのhash、build logを保存します。独立監査器で全列の改変、入力・出力・依存・patch・実行statusの改変、欠落や余剰の負の対照を確認します。監査に通った条件のみ正式結果に含めます。
5. A/Aを2回、その後に正式5回を、同一の清浄なcommit・バイナリーで実行します。各回は異なる未使用の出力先を使い、実行中のスクリプトや資材を変更しません。A/Aと正式結果の期待応答・終了状態・hashは全回一致が必要です。起動時間は最小・中央値・最大を記録しますが、回ごとに一致するとは仮定しません。
6. 生の証拠をZIPとmanifestに保全し、ZIP全件のbyte数・SHA-256を照合します。別の清浄な場所へ展開し、元のbuild出力なしでも監査器を再実行します。使用したGit commitのblobはGitから参照できる状態を保ちます。

この比較が通っても、SMTBMC/SBYへの接続、取消と外部期限、配布条件の検証、製品での有効化は別の検査です。BitwuzlaとBoolectorは引き続き無効とします。実機のTang Nanoでは試していません。

## 予備試行と失敗

固定Mesonの清浄な診断ビルドとCLIの最初の29実行は[前段の記録](S15-bitwuzla-build.md)にあります。監査器を追加するために作業ツリーを変えた後、改めて行った予備試行は、実行時のスクリプトがcommitのblobと一致しなかったため、独立監査で `Harness commit mismatch` として拒否しました。監査器の最初の呼び出しには必須の `--input` がなく、引数エラーで停止しました。どちらも正式結果に含めず、生ログは `build/S15/` に残しています。同じ版の清浄な計測器・監査器を固定してから再実行します。

2 CPUのホストでnativeとWASIを並列にした初回のclean-03ビルドは、出力metadataが両方とも `error` になったため認定外にしました。原因は並列の資源競合と断定せず、全ログを残して逐次ビルドで再確認します。その後の逐次clean-03ビルドは両方 `built`、同じcommitで29実行を通過しましたが、計測器の変更後の正式結果には使いません。

## 再実行の入口

```sh
python3 scripts/build-solver-probe.py --solver bitwuzla --runtime native --meson "$HOME/.cache/toolchain-meson/bin/meson" --jobs 1 --out build/S15/bitwuzla-native-new
python3 scripts/build-solver-probe.py --solver bitwuzla --runtime wasi --meson "$HOME/.cache/toolchain-meson/bin/meson" --jobs 1 --out build/S15/bitwuzla-wasi-new
node scripts/probe-extra-solver-cli.mjs --solver bitwuzla --phase formal-probe --native build/S15/bitwuzla-native-new --wasi build/S15/bitwuzla-wasi-new --negative-wasi build/S15/bitwuzla-wasi-clean-01 --out build/S15/bitwuzla-cli-new
python3 scripts/audit-extra-solver-cli.py --input build/S15/bitwuzla-cli-new
```

出力先は毎回未使用の名前にします。最後の負の対照は、終了境界修正前の清浄な旧版から作ったWASIバイナリーです。正式結果を追記するときに、実際のcommit・binary・CSV・証拠ZIP・実行回数を記録します。

## 清浄な同一commitによる正式比較

計測器・独立監査器と診断buildを `d8fdbc6cf9ed23ce58e6aebd26d9f9d311c652b5` に固定しました。nativeとWASIを同時にせず、固定Meson 1.12.1と `--jobs 1` で逐次ビルドしました。両方のmetadataは `built`、全コマンドの終了状態は0、worktreeは空です。修正前の負の対照だけは、前段の `c84b76d94e0371d4abfce568f9611175b8743bc4` のWASIを保持しています。

| 資材 | byte数 | SHA-256 |
|---|---:|---|
| native修正版 | 7,672,896 | `c618a94953cbce37d14e94db9f53f9f408a463e94f213b9a5535e0c3ec2b8020` |
| WASI修正版 | 8,356,855 | `069d676fb4408352344bab80474fc74b5a8e39caf31747b40c2951f6cc43ead7` |
| WASI修正前の負の対照 | 8,357,316 | `f63c7514696d29220c122aaf64753b39f9bbf0042708baf222bd4f76bbdd6e83` |

nativeのcompilerはGCC/G++ 11.4.0、WASIはSDK 34.0のclang 23.1.0、Nodeはv24.21.0、Pythonは3.12.13です。ホストはUbuntu 22.04.5 LTS、x86_64、2 CPUです。SDK archive、固定依存、静的library、header、実行flagの実値とhashは各buildのmetadataとlogに残しています。今回のbuild出力先は前段と異なるため、前段のbinaryとのhash一致は仮定しません。

A/Aを `aa-1`、`aa-2`、正式比較を `formal-1` から `formal-5` の順で実行しました。出力先は `build/S15/bitwuzla-cli-d8fdbc6-<run>` です。各回の29実行と全14列を、保存した入力・生stdout/stderr・worker結果・build資材へ独立に照合しました。A/Aは58行、正式比較は145行で、[A/A CSV](S15-bitwuzla-cli-aa.csv)と[正式CSV](S15-bitwuzla-cli-formal.csv)には元の14列に `run` を加えた15列を保存しています。全7回で入力・出力hash、終了状態、memoryとbuild由来の全列が一致しました。時間とpipe閉鎖時のwrite errorは反復一致の対象外ですが、それぞれの実行の生記録と照合しています。

| 条件 | 全7回で確認した結果 |
|---|---|
| 版・help・値取得・push/pop・EOF・model・5丸め方式・NaN・配列 | 修正版native/WASIのstdout/stderrと終了状態が一致 |
| 構文エラー | 修正版は両方 `exited`・終了1、同じstderr。旧WASIは `runtime-error`・終了値nullで、失敗を成功へ変えない負の対照 |
| 内部time limit | nativeは終了0。WASIはthread非対応のstderrと `runtime-error`、終了値nullで拒否。workerの外部期限の検査ではない |
| memory | 修正版WASIの正常終了と構文エラー終了は33,554,432 byte。trapとnativeはnull。RSSや測定値0とは扱わない |

正式5回の経過時間は次のとおりです。単位はmsで、worker起動・輸送を含みます。ソルバーの探索性能を比較する数値ではありません。全条件の最小・中央値・最大は集計器から再生成できます。

| 条件 | native 最小/中央値/最大 | WASI 最小/中央値/最大 |
|---|---|---|
| 版表示 | 1.977 / 2.028 / 2.227 | 80.149 / 86.968 / 135.076 |
| 値とpush/pop | 3.316 / 3.437 / 4.374 | 92.418 / 109.705 / 122.466 |
| 構文エラー | 5.914 / 6.814 / 9.918 | 72.859 / 86.795 / 96.153 |
| 内部time limitの境界 | 2.538 / 3.494 / 3.794 | 63.035 / 71.544 / 81.161 |

独立監査器の単体13件は、各CSV列、status、binary・library・header・license・archive・wrap・overlay、patch、buildの失敗、booleanの偽を終了値0と誤認する例、dirty worktree、source snapshot、欠落・余剰・移設などを負の対照にしています。集計器の単体4件では、正式5回とA/A 2回の再生成、回の欠落、公開CSVの列やrun名の改変、異なるcommitの混入を拒否しました。合計17件、既存を含むprotocol検査96件とWeb単体267件が成功しています。

監査器の初回の原archive照合は、CaDiCaLのlicenseがarchive直下にあるという誤った想定で停止しました。実際のpathは `cadical-rel-2.1.2/LICENSE` です。合成fixtureも実archiveの階層へ直し、清浄なcommitから正式比較を始めました。最初に現在の作業ツリーを使って監査器を直した予備結果は、正式比較と分けて保存しています。

```sh
python3 scripts/summarize-extra-solver-cli.py --prefix build/S15/bitwuzla-cli-d8fdbc6 --out docs/experiments --check
python3 scripts/package-extra-solver-cli.py --prefix build/S15/bitwuzla-cli-d8fdbc6 --out build/S15/bitwuzla-cli-evidence-new.zip
python3 scripts/audit-extra-solver-cli.py --input <restore>/build/S15/bitwuzla-cli-d8fdbc6-formal-1 --evidence-root <restore> --git-repo .
```

集計器は全7回を再監査し、元の14列にrun名だけを加えて公開CSVを作ります。`--check` は書き込みをせず、公開CSVの全byteとrun名を照合します。証拠作成には清浄なcommitが必要です。`--extra` を繰り返し指定すると、正式結果とは別に予備試行・失敗ログ・実行用shellなどを追加できます。復元後の再監査では、元のGit commitを参照できるリポジトリを明示します。

## 証拠ZIPと復元後の監査

`bitwuzla-cli-d8fdbc6-evidence-01.zip` は30,278,979 byte、SHA-256は `41e5f2a2a305408bde3f7b44773e7d8d03c0eb538cd3c09dbfc9a94a3abb2d55` です。作成器は清浄な `bd20f27a64f799a3280edc9711fd6196a11f4b20` を記録し、[全1,443ファイルの目録](S15-bitwuzla-cli-files.csv)を保持しています。archive内のmanifestはSHA-256 `1a48d85531ac37aa4d57dfceed38023ed79c043c3ba778ef6cf7e22b37ae4a07` です。7回の入力・生出力・JSON・CSV・setupとsource snapshot、両修正版と旧WASIのbinary・静的library・header・metadata・build log・patch・依存archiveと原license・overlay、予備試行と監査失敗の記録、集計器・証拠作成器を含みます。Gitの履歴と全SDKの配布archiveを内包するZIPではありません。

ZIPの全entryの名前・個数・サイズ・SHA-256を検査してから、一時領域ではない未使用の `build/S15/bitwuzla-cli-d8fdbc6-restored-01` へ復元しました。展開した全1,443ファイルも目録と照合し、復元したPython監査器で全7回の29行14列、復元した集計器でA/A 58行・正式145行の全15列を再監査しました。元のbuildディレクトリーへのfallbackは使わず、`--evidence-root` で復元先へ写像しています。参照するGit commitの原文だけは `--git-repo` で指定した本リポジトリから取得しました。これらの監査は成功しています。

## 残る認定

今回の通過範囲はCLIとbuild由来の独立監査です。原本の `yosys-smtbmc` とSBYによるBMC・prove・cover、実行中の取消・外部期限、元のVerilog/VHDLでの反例再実行、製品資材のclosure・配布と画面接続は未完了です。browser UIやTang Nanoの実機では試していません。BitwuzlaとBoolectorは製品catalogで無効のままです。
