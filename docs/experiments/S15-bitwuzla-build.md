# S15 P4 BitwuzlaのMeson診断ビルド

- 状態: 固定依存だけの清浄ビルドとCLI予備29実行が通過。[後続の正式5回・全列監査](S15-bitwuzla-cli-qualification.md)も成功。製品認定は未完了
- 事前基準: [S15共通基準](S15-formal-verification.md)、[追加ソルバーの基準](S15-extra-solver-builds.md)
- 戻り先: [実験索引](README.md)、[形式検証の候補](../research/formal-capabilities.md)

## 目的と範囲

固定Bitwuzla 0.9.1の上流Meson buildを再利用し、native参照版とWASI診断版を作ります。SAT・SMTの判定、浮動小数点の意味、応答の解析を別言語へ移植しません。native版は比較専用で、製品として配布しません。

この記録はビルド経路の診断です。正式5回・A/A 2回、独立監査、SMTBMC/SBY接続、取消・外部期限、製品の配布条件を通過したという意味ではありません。BitwuzlaとBoolectorは製品で無効のままです。

## 固定依存とビルド経路

依存の取得元・固定値は [形式ソースの記録](../research/formal-sources.md#ビルドprofileと無効な依存)と [MPFRの原記録](S15-extra-solver-builds.md)を正とします。driverはBitwuzlaの `cadical.wrap` と `symfpu.wrap` を読み、値を手で複製しません。

- GMP 6.3.0とMPFR 4.2.2の原archiveをSHA-256と照合し、別のprefixへ静的ビルドします。GMPは `--disable-assembly --enable-cxx`、WASIのMPFRは `--disable-thread-safe` を指定します。原license、生成したheader、static libraryのhashをmetadataへ保存します。
- CaDiCaL 2.1.2はwrapのarchive hash、SymFPUはwrapのcommitと照合します。上流のMeson package overlayもhashを記録して適用します。CaDiCaLはMIT、SymFPUは原本のBSD licenseを保持します。
- Mesonの自動取得を `--wrap-mode=nodownload` で禁止します。native/cross machine fileを生成し、GMP/MPFRの実際のinclude・link引数と版がstaging先に一致しなければ停止します。想定外の外部依存やsystem CaDiCaLも拒否します。
- `default_library=static`、`testing=disabled`、`unit_testing=disabled`、`optimization=2`、`strip=false` を固定します。期待する本体は `objects/src/main/bitwuzla` です。生成した全static libraryと本体のサイズ・hashを記録します。

Ubuntu 22.04.5、x86_64、2 CPU、Python 3.12.13、Node v24.21.0、GCC/G++ 11.4.0、WASI SDK 34.0（Clang 23.1.0）、Ninja 1.10.1、pkg-config 0.29.2で診断しました。Mesonは初回の1.9.2から既存lockの1.12.1へ訂正しました。旧版の結果を固定版での検証とは扱いません。

## WASI境界とpatchの理由

vendorを直接編集せず、staging先へ `patch --batch --fuzz=0 -p1` で適用します。全patchの原文snapshotとhashをbuild metadataに残します。

| patch / adapter | 変更する境界 | 成功したふりで代替しない内容 |
|---|---|---|
| `cadical-wasi-process-boundary.patch` | `sys/wait.h`、外部pipe・child process・OS alarm、resource統計 | processとalarmは明示診断後にabort。RSSは利用不可のsentinelとmetadataで区別 |
| `cadical-wasi-random-seed.patch` | host・network・process・時刻に依存する既定乱数seed | WASIで既定constructorを呼べば診断後にabort。明示seedのSAT実装は変更しない |
| `bitwuzla-wasi-time-limit.patch` | CLIのthreadとpthread依存 | 非ゼロの内部time limitは診断後にabort。外部workerの期限とは別機能 |
| `bitwuzla-wasi-rss.patch` | nativeのRSS、`ru_maxrss`、`/proc` | WASIでは原APIの利用不可値0を返す。metadataの `bitwuzla_native_rss_available=false` と合わせ、測定値0とは扱わない |
| `bitwuzla-wasi-exit.patch` | error destructorからの `proc_exit` | WASIだけdestructorを `noexcept(false)` にし、shimの終了例外を `std::terminate` で潰さない。診断文・終了codeとnativeの型は変更しない |
| `bitwuzla-gmp-limb-width.patch` | GMP limbの32 bit shift | 両runtimeでshift前に `uint64_t` へ拡張。64 bitのbranch条件とhash式は維持 |
| `scripts/wasi-meson-compiler.py` | MesonがELF linkerとして生成するarchive grouping引数 | wasm-ldが拒否する完全一致の `-Wl,--start-group` と `-Wl,--end-group` だけを外す。他の引数とエラーはそのままcompilerへ渡す |

Meson 1.12.1はWASI SDKのClangを `ld.lld` と判定しました。WASIをEmscriptenやLinuxと偽らず `system='wasi'` のまま扱い、adapterをmachine fileに記録します。[LLVMのWASM linker文書](https://lld.llvm.org/WebAssembly.html)にある既定の未解決symbol拒否も緩めません。C++のlinkにはcompile時と同じ `-fwasm-exceptions` を渡し、SDKの対応する例外libraryを選びます。

CaDiCaLのCPU時刻はSDKのwall-clock emulationであり、nativeのCPU時間と同一とは扱いません。RSSのsentinelもWASM linear memoryの使用量とは別です。

## 予備試行と失敗の保存

基準commitは `bf2320af846c448d5c72a74483fa8ca0f6954705`、作業中の変更を含む予備試行です。[生CSV](S15-bitwuzla-build-preliminary.csv)に各status、metadata・driver・本体のhash、Meson版、経過秒を原記録から転記しています。正式な同一commitの結果ではありません。

| 試行 | 結果と解釈 |
|---|---|
| native preliminary-01 | 本体は生成したが、stagingに `gmpxx.h` がなくhost headerを使い得た。Mesonも旧版のため認定に使わない |
| WASI preliminary-01 | CaDiCaLの `sys/wait.h` 不在で停止 |
| WASI preliminary-02 | CaDiCaLの既定乱数seedが使う `netdb.h` 不在で停止 |
| WASI preliminary-03 | stagingの `gmpxx.h` 不在で停止。native初回も清浄な依存結果から除外 |
| WASI preliminary-04 | Mesonを1.12.1へ訂正。最終linkでELF group引数と例外libraryの選択が失敗 |
| WASI preliminary-05 | link probeの修正で `getrusage` が検出され、未提供の `ru_maxrss` fieldで停止 |
| WASI preliminary-06 | 本体8,357,412 bytesを生成。SHA-256 `c427675dd43312da81b595efdf2bcfe2cce4ac631de17b249f7bb91a77da9eed`。まだ作業中の版であり認定外 |

原log・metadata・依存・patch snapshotは各 `build/S15/bitwuzla-*-preliminary-*` に保存しています。temporary directoryへ置き換えたり、失敗を成功行へ書き換えたりしません。

### 清浄な固定依存の初回比較

`c84b76d94e0371d4abfce568f9611175b8743bc4` で両runtimeのbuild metadataが `built`、worktreeが清浄、GMP/MPFRのheaderとlibraryがstaging先に一致しました。nativeは7,672,896 bytes（SHA-256 `ef36baaee63b03cd113281421b4b9bffc40a3b11dac6c74c0abf7fb3a606d716`）、WASIは8,357,316 bytes（`f63c7514696d29220c122aaf64753b39f9bbf0042708baf222bd4f76bbdd6e83`）です。

CLI比較は構文エラーで停止しました。stderrの全byteは一致しましたが、nativeの終了code 1に対し、WASIは `runtime-error: unreachable` です。版・help・値取得/push/pop・EOFの成功を、全条件の通過とは扱いません。

終了importを包んだ診断では `proc_exit(1)` が1回呼ばれた後、`Error::~Error`、`std::terminate`、`abort` のstackを確認しました。上流のerror destructorは暗黙の `noexcept(true)` であり、shimの終了例外がこの境界を越えられません。終了した事実をlog文字列から推測して成功扱いする変更は避け、WASI側のdestructorだけを適応します。修正前binaryを負の対照として残します。

原記録は `build/S15/bitwuzla-cli-clean-01` です。追加診断の初回はstdin APIの取り違えにより入力を渡せず、次の2試行も引数の型が違ったため除外しました。採用した診断は `syntax-exit-stack-04.json` です。通常のworker経由で得た初回の失敗CSV・stdout/stderrは上書きしていません。

### 終了境界の修正後の予備比較

機能commit `c45aad118c7f9ce52a0c782f54d3e0f9fd562673` をpushし、同じ清浄な版から固定依存で生成したnative/WASIを比較しました。nativeは7,672,896 bytes（SHA-256 `92de1c45986cb99ba3289ddbd180f9324a16e72445c7981d9226ce2451bfa9f7`）、WASIは8,356,855 bytes（`9269a522f4ec942d633d0c556eb231559e9993a383dc74665412e82bfbe61fb1`）です。

14条件を両runtimeで実行し、修正前WASIの構文エラーを負の対照として加えた計29実行が予備基準を通過しました。[生CSV全29行14列](S15-bitwuzla-cli-preliminary.csv)は全cellを個別JSONと照合し、input・stdout/stderr・本体・metadataのhash、buildの全command終了値とlog・全libraryのhashも確認しました。これは正式反復や、負の対照で検査した独立監査器の通過とは区別します。[初回の失敗CSV全10行](S15-bitwuzla-cli-failure-preliminary.csv)も保持します。

- 通常の13条件は版・help・sat/unsat・値/push/pop・EOF・構文エラー・model・FPの5丸めmode・NaN・array-storeです。stdout/stderrの全byteと終了codeがnative/WASIで一致しました。構文エラーは両方とも正常なエラー終了code 1であり、修正前WASIだけがtrapになる負の対照も維持しています。
- 残る1条件は内部time limitの境界です。nativeの `--time-limit=10000` は短い入力を判定し、WASIは明示診断後に `runtime-error` となります。この拒否をsat/unsat成功と数えたり、内部time limitが利用可能と扱ったりしません。早期停止で起きた入力pipeのcloseもJSON・CSVに残します。
- 通常終了時のWASM linear memoryは33,554,432 bytesでした。trap時とnativeの値は未取得であり、0へ置き換えていません。native RSSの測定値ではありません。

### 予備証拠の保全

失敗・除外試行と清浄build、CLIの原出力・stack診断、実際のdriver・patch・固定archive・header・library・本体を `bitwuzla-build-c45aad1-evidence.zip` にまとめました。[全1,004ファイルの目録](S15-bitwuzla-build-files.csv)とZIP全entryのサイズ・hashを照合しました。ZIPから展開した計測器による正式な再監査はまだ実施していません。

ZIPは83,975,250 bytes、SHA-256 `6ad0b88cdf269789c45f53d9e002d189f7b6b294dfe2e11f152ebcb1d447d742`、目録のSHA-256は `fd18c0d8d151598cc77ca34b95271876d9c2daefcc09c7f9f7e61a3c4036aa3d` です。VMの一時領域へ移して原記録を削除することはせず、後続の正式反復とも別に保持します。

## 残る警告と次の採否条件

初回のWASI buildでは `src/util/gmp_utils.cpp:123` と `src/solver/fp/floating_point.cpp:450` に、32 bit limbを32 bit shiftする警告が残りました。どちらも `mp_bits_per_limb == 64` のbranch内であり、今回の32 bit GMPでそのbranchを実行した結果ではありません。shift前の型を64 bitへ広げるpatchを両runtimeへ適用し、修正後の清浄buildで該当警告がなく、予備応答も一致することを確認しました。

GMP C++ literalの空白に関する非推奨警告と、CaDiCaLの非trivial型に対する `memset` 警告も保持します。ビルド成功を、警告なし・意味論の認定済みとは扱いません。

WASIのGMPにはunused expressionとbitwise conditionalの優先順位、MPFRには `-ffloat-store` の非対応と32 bitの `size_t`/`int` と定数の比較に関する警告もあります。原logを保持し、FPの限定fixtureの一致だけでMPFR全体の準拠性を認定しません。

予備比較に続く正式5回・A/A 2回と全列の独立監査器は[後続の記録](S15-bitwuzla-cli-qualification.md)に分けました。現段階の性能値や起動時間を改善の根拠にしません。

```sh
python3 scripts/build-solver-probe.py --solver bitwuzla --runtime native \
  --meson "$MESON_BIN" --jobs 1 --out build/S15/bitwuzla-native-clean-02
python3 scripts/build-solver-probe.py --solver bitwuzla --runtime wasi \
  --meson "$MESON_BIN" --jobs 1 --out build/S15/bitwuzla-wasi-clean-02
node scripts/probe-extra-solver-cli.mjs --solver bitwuzla \
  --native build/S15/bitwuzla-native-clean-02 --wasi build/S15/bitwuzla-wasi-clean-02 \
  --negative-wasi build/S15/bitwuzla-wasi-clean-01 --out build/S15/bitwuzla-cli-clean-02
```

`MESON_BIN` は既存 `requirements-formal-build.txt` のhash lockで導入した実行ファイルです。出力先が存在すればdriverと計測器は上書きせず停止します。予期しない終了やunsupportedな境界は通常のsat/unsatとは別に検査します。Tang Nano実機は本リポジトリでは試していません。
