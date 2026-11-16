# S17 Issue #21の依存更新と互換性確認

- 対象: [依存更新通知 #21](https://github.com/uist1idrju3i/gogo-fpga/issues/21)
- 実装: [PR #32](https://github.com/uist1idrju3i/gogo-fpga/pull/32)
- 更新ごとの変更履歴、採否、ライセンス: [調査記録](../research/issue21-dependency-update.md)
- 戻り先: [実験索引](README.md)

## 目的と採否の基準

正式版とbranch更新を区別し、既存のWeb製品で使う依存を更新します。solverの入力ソースを更新することと、製品の選択項目へ昇格させることは別に判定します。既定solverはYices2のままです。

最終試験前の基準は証拠書庫の`review/campaign-plan.json`に保存しました。4ボードのSRAMとflashを各5回検査し、payloadの全byte一致、ログの`FAIL`なし、負の対照の拒否を要求します。書き込み部は別の出力先で再ビルドし、WASMとMJSのSHA-256一致が条件です。Yosysはnative/WASIの出力一致と構文エラーの拒否、ライブラリーは独立scoreboardの正常系・異常系、配布物はhash・原ライセンス・1ファイル25 MiB未満を検査します。

速度は観測値として保存し、採否を速さだけで決めません。複数の依存を一度に変更し、重いコンパイルも同じホストで走ったため、時間差を特定の依存の改善とは扱いません。基準を置く前の試行は予備試行として残します。

## 基準と実行環境

基準のソースは`3bfacd962f456ea78d6c4fa794fb5a0c4e7216e6`です。旧版の書き込み部・Yosys・xz decoderを保全してから更新しました。製品コードとNEORV32互換性修正を含む候補は`bb25227`です。途中の互換性修正は`787f762`、上流patchの適用先監査は`4944018`に記録しています。各ビルドの実際のcommit、gitlink、patch、コマンドはmetadataで区別します。

ホストはUbuntu 22.04.5 LTS、Linux 6.8.0-1060-aws、x86_64、2 CPU、物理メモリー約8 GiB、swap 12 GiBです。実際に確認したツールはNode.js v26.13.1、CMake 3.31.10、Autoconf 2.71、Automake 1.16.5、libtool 2.4.6、GNAT 10.5.0です。書き込み部はEmscripten 7.0.0、YosysとdecoderはWASI SDK 34.0を使います。GHDLのnative参照は、ホストで実行できるGHDL 6.0.0をGNATで再ビルドしました。

`review/host-qualification.json`とsubmodule一覧に環境を保存しました。基準の書き込み部は`build/project-delete-verified`、候補は`build/issue21-openfpgaloader-compatible`、再現ビルドは`build/issue21-final-loader`です。後者と同じWASM・MJSを通常の`build/jspi-pthread`へ配置し、現在のmetadataでWebを組み立て直しました。資材を使い回した箇所はSHA-256で照合し、配置しただけで再ビルド済みとは数えません。

## 書き込み部とdecoder

[生の資材比較](S17-issue21-artifacts.csv)には元のbyte数、gzip後のbyte数、SHA-256を保存します。gzipはlevel 9、mtime 0でそろえました。gzipの値は比較用で、公開形式のzstdと同じものではありません。

| 資材 | 基準のbyte数 | 候補のbyte数 | 基準のgzip byte数 | 候補のgzip byte数 |
|---|---:|---:|---:|---:|
| openFPGALoader WASM | 1,639,829 | 1,682,614 | 579,376 | 588,462 |
| openFPGALoader MJS | 98,956 | 98,723 | 27,267 | 27,188 |
| xz decoder | 20,994 | 26,119 | 8,499 | 10,880 |
| Yosys WASM | 35,038,277 | 40,215,289 | 9,481,323 | 10,812,493 |

書き込み部の候補WASMのSHA-256は`090bb5c1f06cc6297f196eef51bcb83e814f29bacf1eacc74018c5204786db98`です。通常配置と別のビルド先でWASM・MJSが一致しました。Emscripten 7ではC++ヘッダーの間接includeに依存できなくなったため、libusbのビルド用コピーへのpatchと、cxxopts向けの明示includeで対応しました。JSPI・pthread・例外の設定は保持します。

xz-embeddedは新版の`xz_sha256.c`を使います。SHA-256付きの正常な入力を展開し、検査値のbyteだけを反転した入力を拒否する対照を追加しました。SHA-256を無効化してサイズ増を避ける判断はしていません。

候補の仮想USB試験は43件すべて成功しました。[生CSV](S17-issue21-usb.csv)には検出、4ボードのSRAM/flash各5回、bscanの追加条件、基準の失敗と追試を残します。基準は43件中42件成功で、9Kの外部flash検証中に子processが終了値を返さず失敗しました。同じ旧WASMによる追試は成功し、184,444.703 msでした。失敗時は421,368.232 msです。これだけで原因や新版による修正を断定しません。ログに残る失敗を消したり、43件成功へ読み替えたりしません。

同一条件の5回でpayloadを再照合し、別ビルド先のhashも一致しました。一方、基準と候補は交互の順では実行していません。独立した事前A/Aの性能測定もないため、この記録から高速化率は求めません。仮想デバイスの値は実機の値ではありません。

## 合成・ライブラリー・形式検証

Yosys 0.71のWASIとnative参照のビルドが成立しました。4ボードの合成、include・define、構文エラー、WASI shim、出力比較の負の対照を含む19件が成功しました。VHDLライブラリーとGHDLの解析・合成、8部品の独立scoreboardは計28件成功しました。CPUのROM・RAM・GPIOと壊したプログラムの対照は計9件成功しています。

NEORV32ではfence端子の変更を試験用bridgeへ反映しました。cacheとwrite queueを持たない構成だけで完了入力`fenced_i`を`1`へ接続し、ROMの先頭に`fence`と`fence.i`を加えています。上流RTLは編集せず、元VHDLとGHDL WASMの下位化結果を照合しました。cacheを持つ利用者の設計へこの接続を一般化しません。Ibexなど、従来の未対応経路を更新だけで利用可能にはしません。

最終レビューで、20語へ拡張したNEORV32のROMに対し、試験用memoryの容量と読み出し範囲が18語のままだと分かりました。正常ループだけでは末尾の欠落を見逃します。`5f2b497`でROM長を読み出し範囲へ反映し、分岐命令を反転して末尾の異常通知GPIOまで実行する負の対照を加えました。Node.js v26.13.1で7 CPU各7条件をnative/WASMで比較し、9件の試験が成功しました。

HTTPで配った実資材を使う形式検証は39件成功しました。Yosys SAT、Yices2のSBY、VHDLのGHDL変換、構文・property不備、停止・期限・再起動を含みます。Click 8.5.1もこの経路で使用します。Nodeの試験ではCache Storageがない旨の警告が出ますが、hash検証を保ったまま実solverを起動する経路を検査しています。

Bitwuzla 0.10.0のWASIビルドは成立しました。固定したGMP・MPFRと、CaDiCaL 3.0.1・SymFPUの上流Meson差分を適用しています。`-I`と`-isystem`は固定先だけを許可し、hostのヘッダーや違う適用先の受理を負の対照で拒否しました。Node.js v24.22.3ではCLI 14条件をnative/WASI各5回、計140判定で期待どおり確認しました。WASIのthreadを使う期限指定は利用不可として検査します。生の値は`review/bitwuzla-cli.csv`と各試行の`setup.json`に保存します。

これら140判定をNode.js 26の結果とする以前の説明は誤りでした。v26.13.1での追加試行は`--version`の段階で`invalid-wasm`となりました。WASMの検証エラーは`module uses a mix of legacy and new exception handling instructions`です。検証を緩めるフラグは使いません。ビルド成立と旧runtimeでのCLI診断に範囲を限定し、ブラウザー対応や製品認定は未完了とします。既定solverはYices2のままです。

Z3 5.4.1は隔離診断用ソースの更新にとどめます。WASIビルドは11%の段階で終了137となり、製品採用の成功には数えません。

## 再実行

必要なsubmoduleと固定ツールを用意し、未使用のビルド先を選びます。版はpin checkerから取得します。

```sh
scripts/build-wasm.sh
scripts/build-synth-wasm.sh
scripts/build-synth-wasm.sh --native
scripts/build-decoders.sh
scripts/build-web.sh
node --test --test-concurrency=1 tests/web/*.test.mjs
node --test --test-concurrency=1 tests/synth/yosys.test.mjs tests/synth/yosys-parity.test.mjs tests/synth/wasi-p1.test.mjs
node --test --test-concurrency=1 tests/synth/ghdl-wasm.test.mjs tests/synth/library-components.test.mjs tests/synth/cpu-components.test.mjs
node --test --test-concurrency=1 tests/product/formal.test.mjs
WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs
scripts/package-release.sh v0.0.0-issue21
```

2 CPUのホストでは重いビルドを同時に増やさず、必要なら`JOBS=1`を指定します。ホストがGHDL参照版の要求するglibcを持たない場合は、固定ソースからローカルで作った同版の参照を`GHDL_NATIVE_BIN`へ指定します。採用版と異なる参照で成功に置き換えません。

## 失敗試行と制約

- 初期の仮想USBではfixtureがなく失敗しました。固定した参照からfixtureを生成して再実行し、この準備失敗も保全しました。
- Emscripten 7のatomic/include衝突、Trunk 0.22.1の`--verbose`と`--log`の競合を修正しました。新しい最適化オプションは追加していません。
- YosysとZ3の初期ビルドには終了137がありました。swap追加と並列数の抑制後、Yosysは成立しました。Z3の成功とは扱いません。
- GHDL参照資材にはホストより新しいglibcが必要でした。ソースから同版を再ビルドして解析・合成を確認しました。
- BitwuzlaのMPFR不足、Mesonの相対パス、移動したsourceへのpatch、固定依存の`-isystem`指定を順に修正しました。
- Web組立てでは古いbuild metadataを拒否する試行がありました。patch・submodule・build scriptのhashがそろった資材だけを最終配置しました。
- 生成アプリが必要な単体試験を案内HTMLのまま実行し、2件が失敗しました。別の試行ではWeb組立て中に試験を開始したため中止しました。どちらも最終結果へ含めず、組立て完了後の再実行で459件が成功しました。
- 上流patchの適用先`cwd`を取り違えても監査を通った問題は、失敗を再現してから修正しました。適用先を変える対照を含む14件が成功し、`4944018`へ保存しました。
- Releaseの初回検査はSurferのHTML不足で失敗しました。生成済みのWeb資材をそろえた再試行で、配布物と対応ソースの照合が成功しました。
- 削除E2EとCPUのpack shardは、native参照用の`gowin_pack`がなく準備で失敗しました。固定された`requirements-nextpnr.txt`から仮想環境を作り直した後の結果は、次の最終確認へ記録します。削除操作の成否とは区別します。

Tang Nano実機は本リポジトリでは試していません。VHDL原文による反例の独立再実行も、この依存更新で完了したとは扱いません。全実装後の画面操作は別の受入確認として記録します。

## 削除機能と配布物の最終確認

生成したWebアプリをNode.js v26.13.1とPlaywright 1.64.1で検査しました。Web単体459件、HTTPで配信した形式検証39件、CPUのpack shard 8条件が成功しました。pack shardではSERVとNEORV32を4ボードそれぞれで配置配線し、nativeとPyodideのbitstreamを比較します。solverの固定依存・上流patchの監査152件も成功しました。

削除のブラウザー回帰は5件成功しました。取消し、複数プロジェクトからの削除と残る項目への切替、最後の削除、再読込後の空状態、新規作成、OPFS失敗時の編集保持と再保存、保存中の削除と遅い保存による再作成の防止を確認しました。成功時は一覧だけで判断せず、OPFSの実ディレクトリーを直接開き、`NotFoundError`になることも検査します。

4ボードの画面を取得し、4/4枚で削除ボタン、選択ボード、FPGA情報、レイアウトを目視しました。1Kのプロジェクトを別ボードへ切り替えた3枚には、制約ファイルの対象が異なるという警告が出ています。制約の再生成や合成が成功したことを、この画面だけからは主張しません。

```sh
node --version
node scripts/run-ci-shard.mjs pack cpu-3 build/issue21-pack-cpu3-qualified
PLAYWRIGHT_PORT=8132 S5_PLAYWRIGHT_OUTPUT_DIR=build/issue21-deletion-acceptance \
  npx playwright test tests/e2e/project-deletion.spec.mjs
```

再実行にはNode.js 26と、固定依存から作ったnativeの`gowin_pack`が必要です。形式検証の初回試行では、配信したYosysの圧縮前後のhash検査が失敗しました。Webの再組立て後の39件成功を採用し、失敗もログへ残します。最終のRelease検査ではWeb資材、固定ライブラリー22件の再生成、ライセンスと対応ソースの照合が成功しました。

## 原記録

[資材比較](S17-issue21-artifacts.csv)、[仮想USB](S17-issue21-usb.csv)、[BitwuzlaのCLI比較](S17-issue21-bitwuzla-cli.csv)を生CSVとして保存します。[証拠書庫](S17-issue21-evidence.zip)には、判定前の基準、取得した変更履歴・ライセンス、ビルド・失敗ログ、CLIとCPUの出力、形式検証のSQLite・VCD、画面と試験器を収録します。[全ファイルの目録](S17-issue21-evidence-files.csv)にbyte数とSHA-256を記録しました。実行バイナリー全体とビルド用の作業領域は収録せず、資材のhashと再生成手順を保持します。

書庫は2,539ファイル、16,017,385 byteです。SHA-256は`0cbee67d3cb02248a989b3073f8c0aca300fdc5169b71ab333e548c10c88f76f`です。ZIPのCRCと、目録の全ファイルのbyte数・SHA-256を再照合しました。目録自体は件数に含めません。
