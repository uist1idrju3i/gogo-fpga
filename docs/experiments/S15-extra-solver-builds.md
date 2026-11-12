# S15 P4 追加ソルバーの固定依存と診断ビルド

- 状態: 清浄なcommitでBoolector native/WASIを生成し、CLIの5条件が一致。型幅・traceの正式反復は別記。[BitwuzlaのMeson診断](S15-bitwuzla-build.md)は別記録。SMTBMC認定と製品化は未完了
- 基準: [S15の共通基準](S15-formal-verification.md)、[候補と無効理由](../research/formal-capabilities.md)
- 戻り先: [実験索引](README.md)、[形式検証の調査](../research/formal-solvers.md)

## 目的と固定条件

BitwuzlaとBoolectorを、固定した上流実装のままnative/WASIで動かせるかを調べます。nativeは比較用であり、製品として配布しません。Boolectorは保守終了のため既定にはしません。未検証の候補は能力一覧で無効のまま保持します。

本書は診断ビルドより前に追加しました。実行するcommit、作業ツリーの差分、実際のcompilerとSDK、全コマンド、終了状態、所要時間、ログとbinaryのSHA-256は試行ごとの `metadata.json` に保存します。実行中のスクリプトは変えず、失敗した出力先は再利用しません。正式な検証は清浄な同一commitに限り、予備試行と区別します。

| 条件 | 固定方法 |
|---|---|
| 本体 | `git ls-tree HEAD vendor/bitwuzla vendor/boolector`。原本の直接編集はしない |
| Bitwuzlaの依存 | 固定版の `subprojects/cadical.wrap` と `symfpu.wrap`、RESEARCHのGMP・MPFR表から読む |
| Boolectorの依存 | 固定版の `contrib/setup-cadical.sh` と `setup-btor2tools.sh` のcommitと取得元から読む |
| Boolectorのprofile | 上流のonly-CaDiCaL、GMPなし、Pythonなし、単一thread。Lingelingなどを暗黙に加えない |
| Meson | `requirements-formal-build.txt` のhost専用hash lock。rootのpip Dependabotで更新を監視 |
| MPFR | RESEARCHのarchive pin。公式配布、GNUミラー、原文licenseと変更履歴を照合 |
| 製品の境界 | 新しいarchive pinの登録だけでバイナリーや配布ソースの同梱完了とは扱わない |

## 結果を見る前の採否基準

1. 本体・依存の固定値に一致し、必要なlicense原文があり、実際のlink対象を列挙できること。未知の指定、取得先やcommitの不一致、出力の上書きは拒否します。
2. nativeとWASIの両方を上流のビルド方式で作り、版表示、`--help`、SMTのsat/unsat、値の取得、push/pop、EOFを比較できること。構文エラーは終了コード0でも成功にしません。
3. WASIは実workerを使い、stdout/stderr、分割した入力、応答の境界、停止、期限切れを区別できること。原本SMTBMCが行うBitwuzlaの `--help` 起動も仮想processへ接続します。
4. 採用前に同じbinary・入力のA/A 2回と正式5回、全列の独立監査、hash改変・欠落などの負の対照を実施します。成功条件を削って通しません。
5. 512 MiBのmemory上限、配信ファイル25 MiB未満、原文licenseと対応ソースの提供を満たすこと。静的リンクではGMP・MPFRの再リンク条件も確認します。

ビルド成功だけでは能力一覧を有効化しません。資材manifest、binary hash、原本SMTBMC/SBY、反例、配布の確認は別の条件です。proof semanticsやSMT parserをJavaScriptへ移植しません。

## MPFRの取得と原文

公式の [4.2.2配布ページ](https://www.mpfr.org/mpfr-4.2.2/) は2025年3月20日公開を示しています。[原archive](https://www.mpfr.org/mpfr-4.2.2/mpfr-4.2.2.tar.xz) と [GNUミラー](https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.2.tar.xz) は全バイトが一致しました。正となるSHA-256はRESEARCHの表に置き、ここへ複製しません。

同梱READMEはLGPL-3.0-or-laterを示します。`COPYING`、`COPYING.LESSER`、README、NEWSを改変せず保存します。NEWSの4.2.1から4.2.2への変更は、binary128の型の可搬性、ゼロの `%c` 書式出力の修正と安全性への影響、GMPの `vsnprintf` 代替の問題検出を含みます。独自の算術実装や高速化への置換は行いません。

[Detached signature](https://www.mpfr.org/mpfr-4.2.2/mpfr-4.2.2.tar.xz.asc) をGNU keyringと `gpgv` で照合し、終了0、`GOODSIG` と `VALIDSIG` を確認しました。署名鍵fingerprintは `A534BE3F83E241D918280AEB5831D11A0D4DB02A` です。これは取得したkeyringとの署名一致であり、独立した信頼経路の確認を追加したとは主張しません。GMPで以前確認した期限切れ警告を、このMPFRの結果で取り消しません。

Meson 1.12.1のwheelはPyPIのSHA-256に一致し、同梱COPYINGはApache-2.0でした。runtimeの依存はなく、ninjaなどのextrasは指定しません。Mesonを製品のWASMへ含めるわけではありません。

## Boolectorの初回ビルドと次の対照

清浄なcommit `8db748d8006dd348152c2b737f266c70520a2d8c` でnative/WASIを順に実行しました。nativeはGCC/G++ 11.4.0、CMake 3.22.1で生成でき、版表示は3.2.4でした。バイナリーは2,861,824 bytes、SHA-256は `5306934dc6ffd626e8a02d577f4508985ada7e80af2912acd45349c6b9c7ceeb` です。これはビルドと版表示の診断であり、SMTの正しさや正式な比較を確認した結果ではありません。

WASIはCaDiCaLのconfigureがC++のcompiler probeをリンクする時点で停止しました。`__cpp_exception`、`_Unwind_RaiseException`、`_Unwind_DeleteException` が未解決で、Btor2ToolsとBoolector本体のビルドには到達していません。終了状態 `error` と依存の原archive、license、configureログを残し、成功したnativeの結果と混同しません。

原本のconfigureは `LDFLAGS` を渡さず、生成したtargetの実行も要求します。次の対照では `patches/cadical-wasi-cross.patch` を隔離したソースへ適用します。compiler probeのリンクにはSDKのlibunwind・setjmpを渡し、明示したcross buildではtargetをhostで実行しません。C++の機能は実際のコンパイルとリンクで確かめ、unlocked IOは無効にします。nativeの実行確認は残し、判定アルゴリズムには触れません。static archiveの生成にも指定したARを使います。WASIで判定できることや、このpatchの採用を先に確定したわけではありません。

## 再実行の入口

### CaDiCaLのWASI境界と失敗試行

初回のconfigure失敗に続き、同じbase commitの未コミット変更で次の予備試行を行いました。正式な性能比較や5回反復には数えません。各出力先は `build/S15/` 配下で、再利用していません。

| 出力先 | 状態と停止箇所 | 次に変えた条件 |
|---|---|---|
| `boolector-wasi-cross-preliminary-02` | patchのhunk不一致 | 固定ソースから差分を作り直す |
| `boolector-wasi-cross-preliminary-03` | CaDiCaLの `popen` / `pclose` が未宣言 | WASIの外部pipe要求を明示拒否する |
| `boolector-wasi-cross-preliminary-04` | `rusage.ru_maxrss` がない | native RSSの未提供を明示する |
| `boolector-wasi-cross-preliminary-05` | `signal.cpp` の `alarm` が未宣言 | OS alarm要求を明示拒否する |
| `boolector-wasi-cross-preliminary-06` | WASIバイナリーの生成まで成功 | 清浄な同一commitで両runtimeを作り直す |

予備06のWASMは2,116,590 bytes、SHA-256は `49f7d52682fe6e9142b75d58873eaf28a69d87dd654dea59aa9987ea902c4764` でした。これは生成の確認だけで、まだ実行・判定・SBY接続の確認ではありません。

上記のcross設定に加え、[外部pipe](../../patches/cadical-wasi-pipes.patch)、[RSS](../../patches/cadical-wasi-resources.patch)、[alarm](../../patches/cadical-wasi-alarm.patch)を別のpatchにしました。外部pipeとOS alarmは診断をstderrへ出してabortし、成功したようには扱いません。solverを止める期限と取消はworker側の境界で別に検証します。CaDiCaLのRSS関数が返す0は未提供のsentinelで、測定値0ではありません。metadataの `cadical_native_rss_available: false` でも区別します。SATの判定処理は変更しません。

依存の原licenseは取得したarchive内に保持します。CaDiCaLはArmin Biere、BTOR2ToolsはArmin Biere・Mathias Preiner・Aina Niemetzの著作権表示を含むMITの原文を確認しました。patchを適用したソースの提供時も、この原文を保持します。製品配布のlicense closureが完了したという意味ではありません。

以後の試行ではdriverと適用patchのsnapshotも出力先に保存し、hashを記録します。過去のdriverも記録済みSHA-256に一致する原文を保全しました。最初の誤ったpatchによる部分適用とrejectも失敗記録として残します。

### 清浄な版でのビルドとCLI診断

```sh
python3 -m venv build/formal-build-tools
build/formal-build-tools/bin/pip install --require-hashes -r requirements-formal-build.txt
python3 scripts/build-solver-probe.py --solver boolector --runtime native --out build/S15/boolector-native-01
python3 scripts/build-solver-probe.py --solver boolector --runtime wasi --out build/S15/boolector-wasi-01
node scripts/probe-extra-solver-cli.mjs --native build/S15/boolector-native-01 --wasi build/S15/boolector-wasi-01 --out build/S15/boolector-cli-01
```

`--cmake` と `--jobs` でhostツールのパスと並列数を明示できます。対応していないsolver名は拒否します。BitwuzlaのMeson経路とCLI予備比較は別記録とし、正式反復・SMTBMC認定は未完了です。Tang Nano実機での動作は本リポジトリでは試していません。

CLI診断は清浄なbuild metadataとbinary hashを先に照合し、version、help、値取得とpush/pop、EOF、構文エラーの5条件をnativeと実workerで交互に実行します。WASIは7 byte bufferへ3 byteずつ書き、stdout/stderrの全byteと終了コードを比較します。Boolectorのsat終了10を通常終了0へ読み替えません。構文エラーの終了1も独立して検査します。生CSVと各stream・結果JSONは出力先へ保存します。これは予備CLI診断であり、全列の独立監査・正式反復・SMTBMCの検証を代替しません。

## 清浄なビルドとCLIの予備結果

清浄なcommit `e286c9f4b676ee3306a6ee51e7b6142e9d4686e3` から両runtimeを生成しました。nativeはGCC/G++ 11.4.0とCMake 3.22.1、WASIはSDK 34.0です。Boolectorの版表示はいずれも3.2.4でした。

| runtime | bytes | SHA-256 |
|---|---:|---|
| native | 2,861,824 | `e4bab02e41676e17b2aa798f8ebca74023618a8ef79f2b37ef882040c25ed666` |
| WASI | 2,116,270 | `00bbbbce78b4a355d9f75a289e00d43c43e4765fbca032cf7d66bf03d088a0a1` |

最初のCLI実行はNode検査側の `crossOriginIsolated` 指定不足で、WASIの起動前に `isolation-required` として停止しました。生CSVはnativeのversion 1行だけで、成功には数えません。既存のNode検査と同じ指定を加え、清浄なcommit `c344c8bd4b20f5aa6623312728da0d88752f6da5` の計測器で上記の同じbinaryを比較し直しました。build commitとharness commitは別々に記録しています。

5条件・計10実行が成功しました。version・helpは終了0、sat/unsatと値取得・push/pop、EOFは終了10、構文エラーは終了1でした。stdoutとstderrはそれぞれnative/WASIで全byte一致し、通常の条件でstderrは空、構文エラーではstdoutは空でした。値取得の応答は次のとおりです。

```text
sat
((x #b00101010))
unsat
sat
```

[生CSV](S15-extra-solver-cli-preliminary.csv)は10行14列を原文のまま保存しました。各列と結果JSON、全streamを確認しましたが、独立監査器による全列監査と正式反復はまだ実施していません。小さなbufferによる分割I/Oは試していますが、仮想process brokerからの起動・取消・期限切れや、原本SMTBMC/SBYでの判定を検証済みとは扱いません。

### 警告と採用の保留

ビルド成功を、警告がないという意味では使いません。nativeのCaDiCaLではGit情報を含まないarchiveからIDENTIFIERを取得できない警告が出ました。依存のcommitはdriverが取得時に照合し、metadataへ別に記録しています。

WASIには次の正しさに関わる警告が残っています。どちらも固定版の原文と照合し、単なる未使用変数の警告とは分けて扱います。

- BTOR2Toolsの `src/btor2parser/btor2parser.c` の261・773・1248・1293行で、64 bitのIDを `labs(long)` に渡しています。WASIの32 bit longへの変換により切り詰める可能性があります。今回はSMT-LIB入力だけを試しており、BTOR2の正しさを確認していません。
- Boolectorの `src/btortrapi.c` の58〜77行では、WASM向け条件分岐がgzip用 `popen` を除いた後に、未初期化の `FILE *file` を参照し得ます。gzipのAPI traceを試した結果ではなく、コンパイラー警告と原文から確認した問題です。

このほかに未使用の関数・変数の警告もあり、全ログを証拠へ含めました。今回の5条件の一致だけでは、これらの問題や保守終了のリスクを解消したとは扱いません。Boolectorの製品候補は無効のままとし、採用は保留します。

### 証拠の保全

証拠ZIP `s15-extra-solver-preliminary-e286c9f.zip` は11,558,735 bytes、SHA-256は `dcebaeee5b6d7bc0a8ec5ec4cb401e95571f2acf61a83195b324ab4b977d43a7` です。失敗試行・成功したビルド・CLIの生出力、依存の原archiveとlicense、driverとpatchのsnapshot、MPFRの取得・署名記録を含む415ファイルを保存しました。[全ファイルの目録](S15-extra-solvers-files-sha256.csv)は各サイズとSHA-256を記録し、ZIPから読み戻した全件が元のbyte列と一致しています。目録自体のSHA-256は `6cd06cbd52c0e77085063612ebe8fd900e7fbe39efaa2a82998a7296f7830216` です。ZIPはチャットで渡し、repositoryには生CSV・目録と本記録を残します。

初回の不正patchは原文snapshotを残せていません。部分適用したconfigure・makefile、reject、記録済みpatch hashは保全していますが、そのpatch原文を保全できたとは主張しません。以後の試行は適用したpatchのsnapshotを保存します。
