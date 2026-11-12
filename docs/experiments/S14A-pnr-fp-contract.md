# S14A: SERV / 20K の浮動小数点演算の縮約と配置差

[実験の索引](README.md)へ戻る。

## 目的と先に定めた基準

[S14の正式反復](S14-production-cpu.md)は手元の製品用バイナリーで一致しました。その後、[PR 47](https://github.com/gogo-fpga/toolchain/pull/47)と[PR 48](https://github.com/gogo-fpga/toolchain/pull/48)の環境では、SERV / Tang Nano 20Kの配置配線JSONに差が出ました。元のCIのバイナリーと入力で差を再現し、比較条件を緩めずに原因を切り分けます。以前の成功を取り消したり、別の環境の成功へ読み替えたりしません。

基準commitは `571da8ac6961a4cc4bb3d990182d3eac07a085d3` です。製品用設定の変更前に、Eigenのベクトル化を無効にしても残るFMAの丸め差を仮説として定めました。FMA命令があることだけでは原因としません。入力、seed、chipdb、ソース、他のobjectを固定し、heap placerの演算の縮約だけを切り替える対照を使います。

事前基準は、各条件でnativeとWASIを各5回以上実行し、元の差が安定して現れ、縮約を無効にした条件だけが厳密に一致することです。全実行の終了状態、例外、signal、入力、配置結果、資源、ログを読みます。同じバイナリーのA/A試行と、配置値・キー順を変えた負の対照も要求します。JSONの値、キー順、creatorを削除・置換・ソートして合格させません。製品用nativeとWASIは作り直してから別に確認します。

これは不具合の診断です。以下の反復は作業中の差分を含む状態で行い、[全列監査](S14A-pnr-fp-contract-audit.json)に基準commitと差分のSHA-256を保存しました。提出commitそのものの確認とは区別します。

## 固定条件とツール

- nextpnrは `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` です。[元のCI実行](https://github.com/gogo-fpga/toolchain/actions/runs/41352383006)のnative / WASIの成果物とbuild-infoを保存して使用しました。
- nativeのELFにある `.comment` は `GCC: (Ubuntu 15.2.0-16ubuntu1) 15.2.0` です。対照も同じコンパイラーを隔離環境で使いました。CPUのFMAが使える `-march=x86-64-v3`、`-O3`、LTO、元のリンクobjectを固定しました。
- 同じ `placer_heap.cc` にパッチ0002を適用したSHA-256は `1a088adcbbbe523dc919034e48b7aad8fd29e0544bcfdaff55be6e074cd475db` です。両対照とも `EIGEN_DONT_VECTORIZE` を維持します。
- 入力netlistは `fb3130cc993ea5899f184d9ece04e23fbe521cc3c19b1e096f0cf6d6370e1b60`、seedは `73421`、周波数は12 MHzです。制約は保存済みプロジェクトから生成したものを再利用し、手で編集していません。
- 両系のGW2A-18Cのchipdbは `47b5695929d7eb29517ecf9007fe6dd810e932665e450519251c3cd77a88d040` です。元のnativeに埋め込まれたCIの配置先は手元にないため、同じバイト列のchipdbを `--chipdb` で明示します。
- 手元の製品用再ビルドはGCC 11.4.0、CMake 3.31.10、WASI SDK 34.0です。Node.jsは24.21.0です。CIの成果物と手元の成果物のcreator表記が異なることも記録します。

実行環境はLinux x86_64です。OS、CPU、メモリー、全submodule、実コマンド、各ビルドのcompiler version、flags、objectと実行ファイルのhashを生成したmetadataへ保存しました。大きなログやバイナリーはコミットせず、再生成の手順を以下に残します。

## 反復の結果

各行はnative 5回とWASI 5回です。同じ実行系の5回はすべて自己一致し、全60実行が終了状態0、例外なし、signalなしでした。

| 条件 | nativeの配置hash | WASIの配置hash | 厳密一致 |
|---|---|---|---|
| 元のCI | A | B | 不一致を5回再現 |
| 最初のoff診断 | B | B | 5回一致 |
| 同じGCCのfast対照 | A | B | 不一致を5回再現 |
| 同じGCCのoff対照 | B | B | 5回一致 |
| 再ビルドした製品用 | C | C | 5回一致 |
| 同じ製品用のA/A | C | C | 追加5回一致 |

hashは `SHA-256(JSON.stringify(JSON.parse(bytes)))` です。挿入順を含めて比較し、正規化していません。

- A: `3ffcfa37164faf66bc871feab925562ebbe6b92058486d617a73ed9528749dff`
- B: `bb8b4c53bea1c95730675b3b76f1d5424016be42265d984f1fef0d811fb0cd14`
- C: `d1f5cc0f072c9169c966eb8e5a3f674d041d2fca11b38ec6ea15e394f1887d03`

BとCの値の差はcreatorだけでした。元のCIは `Next Generation Place and Route (Version 62e659e)`、手元は `Next Generation Place and Route (Version nextpnr-0.11.1)` です。この調査でその差を観察しましたが、BとCの厳密比較が成功したとは扱いません。比較内ではそれぞれ同じ版表記を使い、creatorの除去はしていません。

fastとoffの対照は同じcompiler、同じCPU target、同じpatched sourceとリンクobjectです。切り替えた `-ffp-contract` に対応して、元の不一致と一致が反転しました。この条件での直接原因はheap placerの演算の縮約です。native全体の最適化、ソート順、回路、seedを変えず、製品用のこの翻訳単位だけに `-ffp-contract=off` を採用します。WASI側にも同じ明示設定を適用します。

LUT4は1,322、DFFは469、RAM16SDP4は40、BSRAMは0で、全条件の全実行が同じ資源表でした。12 MHzの配置配線を完走しました。ログで抽出した60件の `Critical path report` はすべてInfoの報告で、エラーではありません。ブラウザーや実機での動作確認ではありません。

## 時間、メモリー、大きさと制約

[生CSV](S14A-pnr-fp-contract.csv)は60行11列です。全660セルを実行別のresult、stdout、stderr、入力hashと配置JSONに照合しました。監査器は期待した不一致を明示する必要があり、診断CLIの終了状態0だけを一致の根拠にしません。各条件で配置セルのBEL値を変えた負例とルートのキー順を逆にした負例がともに拒否されました。

| 条件 | nativeの中央値ms（最小～最大） | WASIの中央値ms（最小～最大） |
|---|---|---|
| 元のCI | 4,549.3（4,478.6～7,394.1） | 12,203.0（8,649.1～28,381.6） |
| fast対照 | 7,096.9（4,606.5～7,318.5） | 14,386.4（8,933.5～15,491.0） |
| off対照 | 5,214.3（4,801.7～13,048.0） | 16,777.9（8,860.1～20,997.3） |
| 製品用 | 9,718.1（5,084.4～12,743.4） | 12,490.4（9,485.1～20,041.0） |
| 製品用A/A | 5,156.5（5,116.8～5,269.9） | 11,051.2（9,085.5～12,558.7） |

ビルドと他の回帰が並行していたため、これらは実行時間の記録であって速度の優劣を示す実験ではありません。最初のoff診断を含む全統計は監査JSONに保存しました。WASIの最終linear memoryは全60実行のうちWASI 30実行すべてで53,477,376バイトでした。nativeのRSSは測っていません。WASIの値をhost RSSやpeak memoryとは扱いません。

元のCIのnativeは55,501,176バイト、WASIは27,884,785バイトです。再ビルドした製品用はnative 55,411,080バイト、WASI 27,884,842バイトです。nativeはcompilerと版表記なども違うため、差を縮約設定だけの効果とはしません。対照のbinary hash、全条件のサイズ、版表記とchipdb hashも監査JSONに保存しました。

## 再生成と監査

元のCIのnative object treeを `build/S15/ci-41352383006-nextpnr/native/nextpnr`、WASIを同じ成果物の `wasi/nextpnr` に展開します。元のtreeは読み取り専用にし、元のCIと同じソース・依存の配置を用意したGCC 15.2.0の隔離環境で実行します。`--out` は未作成の場所を指定します。

```sh
python3 scripts/build-pnr-scalar-probe.py --build-dir build/native/nextpnr \
  --out build/S15/serv20k-gcc15-fast-control2 \
  --patch patches/nextpnr/0002-stabilize-equal-coordinate-cuts.patch \
  --march x86-64-v3 --fp-contract fast
python3 scripts/build-pnr-scalar-probe.py --build-dir build/native/nextpnr \
  --out build/S15/serv20k-gcc15-off-control2 \
  --patch patches/nextpnr/0002-stabilize-equal-coordinate-cuts.patch \
  --march x86-64-v3 --fp-contract off
```

ここでの `build/native/nextpnr` は隔離環境内に読み取り専用で配置した元のCI object treeです。手元の別のcompilerのobjectに置き換えません。SERV / 20Kの保存入力は `tests/synth/gowin-pack.test.mjs` のCPU matrixでも再生成できます。

```sh
CPU_MATRIX_EVIDENCE=build/S14A-cpu node --test \
  --test-name-pattern='pinned CPU libraries retain' tests/synth/gowin-pack.test.mjs
node scripts/diagnose-pnr-layout.mjs --board tangnano20k \
  --case-dir build/S14A-cpu/serv/tangnano20k \
  --out build/S15/serv20k-ci-fast-control2-five \
  --native-binary build/S15/serv20k-gcc15-fast-control2/nextpnr-himbaechel-gowin \
  --native-share build/S15/ci-41352383006-nextpnr/native/nextpnr/share \
  --wasm-binary build/S15/ci-41352383006-nextpnr/wasi/nextpnr/nextpnr-himbaechel-gowin.wasm \
  --wasi-share build/S15/ci-41352383006-nextpnr/wasi/nextpnr/share
```

同じコマンドの出力先とnative binaryをoff対照へ替えます。元の条件は元のnative binaryを指定します。製品用とA/Aは `scripts/build-pnr-wasm.sh --native` と `scripts/build-pnr-wasm.sh` の再ビルド後、binary / shareの上書き引数を付けず、新しい出力先で各5回実行します。

```sh
node scripts/audit-pnr-diagnostics.mjs \
  --sample old=build/S15/serv20k-ci-old-five \
  --sample off=build/S15/serv20k-ci-off-five \
  --sample fast-control=build/S15/serv20k-ci-fast-control2-five \
  --sample off-control=build/S15/serv20k-ci-off-control2-five \
  --sample product=build/S15/serv20k-product-five \
  --sample product-aa=build/S15/serv20k-product-aa-five \
  --expect-mismatch old --expect-mismatch fast-control --out build/S15/serv20k-audit
```

CSVのSHA-256は `579d7edb330fc9516be8ad3aba300ed5bf27a98daa2a278666c9e632f393acfb`、監査JSONは `0c268fa8a20abbbcd72eae92a2f790aef0bf4610121e48e65dfb0774f609bd94` です。監査器の単体テストはCSVのstatus、配置値、binary provenance、終了状態の改変と、誤った期待判定を拒否します。

## 失敗した試行と採用範囲

- 製品用の最初の再ビルドはhostのCMake 3.22.1が上流の最低版3.25に足りず、コンパイル前に失敗しました。固定ツールのCMake 3.31.10を明示して再実行し、native / WASIを再生成しました。失敗ログは保持しています。
- 最初の汎用fast対照は、元のCMake 4系のlink commandが元のtreeの `link.d` を書こうとして、読み取り専用の保護により失敗しました。ELFだけでなくlinkerの依存ファイルも対照の出力先へ向けるよう検査器を修正しました。元のELFとobjectを変更していません。
- 追加したprobeの単体テストは、空のCMake変数のfixtureに区切りの空白がなく、最初は失敗しました。fixtureを実際の形式へ修正しました。製品のflags解析を緩めていません。

採用する設定はheap placer翻訳単位だけです。compile commandsから `EIGEN_DONT_VECTORIZE` と `-ffp-contract=off` が各1個あることを検査し、競合する縮約設定、unsafe math、response fileを拒否します。版、ソースpin、既存の順序固定パッチ、JSONの厳密比較、製品の対応ボードは変えません。

CIのcache保存keyをrestoreと同じ入力へ揃え、次回の失敗時には `build/t5-library-flow-*` の入力とログを7日間保存します。取得した元の失敗や未確認の範囲を成功へ書き換えません。[提出commitの全60組回帰と全列監査](S14A-final-regression.md)は別に記録しました。HDL32組成功、CPU18組成功・6組容量超過・4組frontend非対応です。修正後CI全体とT6全体は未完了です。Tang Nano実機は本リポジトリでは試していません。
