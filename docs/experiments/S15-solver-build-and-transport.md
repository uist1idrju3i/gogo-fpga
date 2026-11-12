# S15 P2 Yices2・Z3のビルドと双方向通信

[形式検証の索引](S15-formal-verification.md) / [実験の索引](README.md)

現在の結果は[両solverのnative/WASI正式比較](S15-solver-native-wasi.md)へ記録しています。clean buildと各5回・A/A 2回の全329行31列を監査済みです。以下は当初の事前基準・失敗と予備試行の履歴を保持したものです。SBYと製品画面の接続は未完了です。

## 目的と事前基準

承認済みT6 P2として、上流のYices2とZ3を固定ソースからビルドし、SMT-LIBの解釈を移植せずにnativeとWASMの双方向通信を比較します。以下は実行前に定めた基準です。まだ成功結果ではありません。

第一候補は既存WASI Preview 1 shimと専用Workerです。必要ならSharedArrayBufferで入力待ちを接続します。Worker間の共有領域はWASMのpthreadとは区別します。WASIが通らない場合は、理由を記録し、C APIと公式Emscripten経路を比較してから方式を判断します。

| 検査 | 必須条件 |
|---|---|
| 固定条件 | P1提出版`cc9657307197bbc9e23d0129d0dd7058e57a94a3`から開始。正式反復の前には実装を別の清浄なcommitに固定し、全バイナリー・patch・SDKのhashを保存 |
| 正常な増分通信 | 複数check-sat、push/pop、get-valueとモデル検査、bit-vectorとarray。nativeとWASMで論理結果が100%一致 |
| 輸送 | 分割したread/write、長い応答、stdout/stderr分離、EOF、終了後のwrite、backpressureを全て確認。入力や出力の切り捨ては0件 |
| 異常系 | 不正なSMT、unknown、timeout、cancel、crash、壊れたWASM・hash不一致を100%非成功へ分類。cancel後の古い応答の採用は0件 |
| 資源と配布 | solver線形メモリー512 MiB以内、ログ8 MiB以内を初期上限とする。配信資材は各25 MiB未満。時間・メモリー・圧縮量・ビルド時間を記録 |
| 計測器 | 正式反復前にA/Aを2回と、期待値・入力・出力を壊した負の対照を確認 |
| 正式反復 | 清浄な同一commit・同一binaryで各条件5回以上。正常系だけで最小・中央値・最大を計算し、生CSVの状態を含む全列を監査 |

初期profileはYices2のMCSAT・thread safetyなし、Z3の単一thread・GMPなし・polling timerです。固定pinは[ソースと配布条件](../research/formal-sources.md)とRESEARCHの表から導き、別の版をコードへ複製しません。GMPは元の6.3.0 archiveとそのライセンスを使います。上流checkoutは編集せず、必要な変更だけをpatchとして保存します。

## 初回予備ビルドの記録

正式な5回反復の前に、[予備試行の生CSV](S15-solver-build-preliminary.csv)へ初回7試行と、その後の14件を保存しました。最初の7件はすべてビルドまたは計測器の失敗です。その後の行は手動link、実行、単体検査、単独objectの対照を区別しており、solverの速度比較や成功率には使いません。空欄は未取得です。`exit_status`は記録した外部commandの値であり、driver全体の成功ではありません。Yices2 nativeはmakeが0で終了しても、その後の成果物探索が失敗しています。

初回はP1提出commit `cc9657307197bbc9e23d0129d0dd7058e57a94a3`に未コミットの予備driverとstdin変更を加えた調査用checkoutで実行しました。清浄な提出commitを検証した結果ではありません。環境はUbuntu 22.04.5、Linux x86_64、2 CPU、GCCとg++ 11.4.0、Node v24.21.0、WASI SDK 34です。過去の別実験のUbuntu 26.04・GCC 15という値を、この試行の環境として流用しません。

初回driverのSHA-256は`07907fcd66daf85b776bfaa5df7583bc21e314d2760fe3f7e769dda0f401db0f`です。終了した初回driverを`build/S15/p2-build-solver-probe-original.py`に保全し、CSVに各metadata・logのhashを記録しました。各試行のdirectoryとlogは削除していません。新しいdriverを使う再試行は別の出力先へ保存します。

| 試行 | 非成功の理由 |
|---|---|
| Yices2 native 1 | 原本のmakeは成功したが、driverが`yices-smt2`を探し、実体の`static_bin/yices_smt2`を見つけなかった。さらに版表示が親repoのrevisionを拾った |
| Yices2 WASI 1 | 固定GMPのbuild後、Yices configureの別の`-lgmp`検査で検索先が不足 |
| Z3 native 1 | 実際のC++ compilerはg++ 11.4。原本が要求する`<format>`がない |
| Z3 WASI target 1 | 実行ファイルの出力名`z3`と、CMakeのtarget名`shell`を取り違えた |
| Z3 WASI shell 1 | 正しいtargetで、SDKにない3つの浮動小数点丸め定数がコンパイルエラー |
| Yices2 WASI make 2 | GMP検索先を直したconfigureは成功。makeがnative archの設定を探して停止 |
| Yices2 WASI cross 2 | makeへWASI archを渡すと進行したが、元のtimerの`alarm`が未宣言で停止 |

調査の採否と原典は[ソルバーの方式比較](../research/formal-solvers.md)へまとめます。現在は、固定sourceだけをGit archiveから展開する処理、正しい成果物名、GMP検索先、makeのarch、C++ compilerと使用環境の記録を予備driverへ追加しています。WASI alarmを要求したら明示的に拒否する候補patchと、固定revision・日時で版表示を生成する候補patchも用意しました。再試行中のscriptは編集しません。

## 予備ビルドと制約

Yices2 WASI 3では、候補patchを使うと本体のコンパイルを通りましたが、`__wasm_longjmp`などの未解決symbolでlinkが停止しました。SDK同梱の`libsetjmp.a`を確認し、別ログを使って`-lsetjmp`を追加した再linkを行うと、CLIを生成できました。同じSDKの実装をリンクしたものであり、setjmp/longjmpを独自に模倣していません。

これは未コミットの予備driverと手動再linkによる結果です。清浄なcommitからの再build、nativeとの比較、正式な反復は残っています。最初の手動再linkでは環境変数を渡し忘れ、現在日付の版表示を生成したため、`LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=0`を明示して再linkしました。初回の失敗metadata・compile log・再link logを区別して保持します。

輸送の基盤には、容量を制限したSPSC byte pipeを追加しました。共有bufferは循環構造で、readerとwriterを各1つに限定し、EOF前の残りのbyteを読み切ります。cancelとcloseは待機を解除し、終了後のwrite・並行する同じendpointのread/write・無効なdescriptorを拒否します。workerは同期、hostは非同期のAtomicsで待ち、Nodeの実workerを含む11件を検査しました。この検査ではNodeのfixtureでisolation flagを設定しており、ブラウザーのCOOP/COEPを検証した結果ではありません。

solver workerの基盤も追加し、SHA-256照合、壊れたWASM、trap、協調しない無限ループの期限超過、cancel、worker crash、終了通知の欠落、古いjob IDを検査しました。追加した標準WASIの小さな検査用WASMでは、528,384 byteの分割出力、別のstderr、非ゼロ終了、trap前の診断保持、stdoutとstderr合計の上限超過、consumerの例外と停止も検査しました。計16件が成功し、Web全体は225件が成功しました。終了通知とstdout/stderr双方のEOFを要求し、processの終了を論理的な証明成功とは扱いません。SMT応答のframing、正式反復と製品UIへの接続は残件です。

Yices2の予備WASMは1,970,068 byte、SHA-256は`911dd45e24c6a15ff6e4114ecb2b4b1d07f72739d216856bc672bd1d21e48360`です。版表示の固定日付・revision、単純なSMT判定と値取得、`--timeout=1`での診断付き終了19を確認しました。さらにNode実workerで、7 byteのpipeと5 byteずつの入力を使い、check-sat、get-value、push/pop後の複数check-satとEOFを順に通しました。stdoutは`sat\n((x #b0001))\nunsat\nsat\n`、stderrは空、終了は0、線形メモリーは33,554,432 byteでした。Nodeのfixtureでは起動元の`--input-type=module`、続いてtest runnerのworkerへ渡せない起動引数の引き継ぎで失敗しました。fixtureのworker引数は空の配列へ固定し、失敗ログも保持します。実行スクリプトの固定とnative比較を終えるまでは正式結果に採用しません。

初回の予備ビルドは正式反復ではありません。WASI SDKのsetjmpヘッダーは、例外処理を使う`-mllvm -wasm-enable-sjlj`を要求します。Yices2の元のparser・contextにはsetjmp/longjmpがあるため、この機能を使って適合性を調べます。例外処理を省いて成功扱いにはしません。上流のalarmやsignalを黙って成功させる代用品も作りません。

## 応答の字句境界とnative参照版の追加調査

`web/lib/smt-response-framer.mjs`はSMT-LIB 2.6系の応答をbyte列から区切ります。括弧の深さ、文字列の二重引用符、縦棒付きsymbol、行末までのcommentだけを扱い、SMT構文や式の意味、sat・unsatの妥当性は判定しません。根拠は固定Yices2の`src/frontend/smt2/smt2_lexer.c`の`smt2_read_string_var`と`next_smt2_token`です。旧SMT-LIB 2.0のbackslashによる引用符escapeは、このprofileの対象外です。

分割したUTF-8は検証を継続し、不正な列、閉じていない括弧・引用、制御byteを拒否します。文字列は次のbyteまたはEOFで引用符の二重化を判別します。応答ごと・全体のbyte数、深さ、応答数にも上限を設け、失敗後やEOF後の再利用を拒否します。既定の上限は8 MiB、深さ512、4096応答です。元の文字列とcommentは応答内に保持します。

単体12件では、全byte境界の分割、1 byteずつの入力、日本語、二重引用符、長いmodel、上限、破損、途中欠落、EOFを検査しました。これは字句境界の単体検査です。実solverのnative/WASM比較、5回反復、実ブラウザーでの確認やSMTの意味検証とは区別します。正常な応答を先に受け取っても、その後の破損やprocess異常を無視して成功にしてはいけません。

Z3の`p2-z3-native-2`は、全compile後のlinkで`std::length_error`のdestructorが未解決となり、libc++abiが`DSO missing from command line`で停止しました。失敗ログ・元のdriver・metadataを残し、生CSVへ追加しました。compile用のincludeとlink用の標準ライブラリー設定を混在させた警告も保持します。`std::format`と例外の小さな対照では、同じobjectを明示ABIなしでlinkすると失敗し、`-lc++abi -lunwind`付きではlinkと実行が成功し、`format:21`を出力しました。これはZ3本体の成功ではありません。

driverに`--cxx-link-flags`と`--cxx-libraries`を加え、CMakeの実行ファイルlink設定と標準ライブラリーへ分けて渡します。Yices2 WASIは、上流のMakefileがobjectの後ろへ置く`LIBS`にSDKの`-lsetjmp`を渡します。GMPの設定と上流のコードは変えません。このdriverでのclean buildと正式比較は、まだ完了していません。再検査は次のコマンドです。

```sh
node --test tests/web/smt-response-framer.test.mjs
python3 -m py_compile scripts/build-solver-probe.py
python3 scripts/build-solver-probe.py --help
```

### 清浄なbuildの追加結果

Z3 WASIの継続buildは全コンパイル後のlinkで失敗しました。SDKの例外libraryとWASIのfork登録を切り分けた[link診断の記録](S15-z3-wasi-link.md)へ、失敗logのhash、patchの理由、手動診断18条件、clean buildの再実行を保存します。正式なnative/WASI比較が未完了という結論は変えません。

その後、`537a140b4ba4e233af6606a78071e80e08ce858b`の清浄なcheckoutで、Yices2のnativeとWASI、Z3 nativeのbuildが完了しました。手動の再linkではなく、記録したdriverを最後まで実行した結果です。各binaryのhash・Z3 nativeの実compilerとbuild時間・実応答の予備結果は[比較の記録](S15-solver-protocol.md)に分けます。Z3 WASIのbuildは続いており、正式反復の成功ではありません。

Z3 nativeの再実行にはClang 21.1.8、隔離したlibc++ 21とCMake 3.31.10を使います。`HOST_CXX_ROOT`はlibc++のpackageを展開したdirectory、`CMAKE`はそのCMake実行ファイルを指すものとします。取得元・packageのhash・実際のargvは元のmetadataと予備証拠に残します。

```sh
CXX=clang++-21 python3 scripts/build-solver-probe.py \
  --solver z3 --runtime native --jobs 2 --cmake "$CMAKE" \
  --cxx-flags="-nostdinc++ -isystem $HOST_CXX_ROOT/usr/include/c++/v1" \
  --cxx-link-flags="-stdlib=libc++ -L$HOST_CXX_ROOT/usr/lib/llvm-21/lib -Wl,-rpath,$HOST_CXX_ROOT/usr/lib/llvm-21/lib" \
  --cxx-libraries="-lc++abi -lunwind" --out build/S15/replay-z3-native
```

## 予備試行の証拠と再実行

CSVの全21行13列を読み、全行のlog hashを再計算して一致を確認しました。完了した83ファイルの[path・byte数・SHA-256の目録](S15-solver-preliminary-files.csv)も保存しました。証拠ZIPは`S15-solver-preliminary-evidence-v3.zip`、432,778 byte、SHA-256は`2a116affce900ef17efc36d290953e81b4695b54d8473fcd0299c85ef8a4f100`です。ZIP内の全目録項目を再読して、byte数とhashを照合しました。初回のdriver、失敗したcompile・link・worker、修正後の対照、適用したpatchを含みます。実行中のZ3 native再buildのlogとmetadataは、変わり続けるため含めていません。

予備driverは固定pinを確認し、Git archiveから別のsourceへ展開します。既存の出力先は拒否します。以下はsetjmpのlink不足に至る予備試行を、新しい出力先で再生成する例です。依存ソースと固定WASI SDKのcacheを用意してから実行します。SDK archiveのhash、sourceのcommit、実際のcompiler、commandと環境は出力先の`metadata.json`へ残ります。

```sh
python3 scripts/build-solver-probe.py --solver yices2 --runtime wasi --jobs 1 \
  --patch patches/yices2/reproducible-version.patch \
  --patch patches/yices2/unsupported-wasi-alarm.patch \
  --out build/S15/replay-yices-wasi
```

手動の再linkは、同じGMP include・archiveとSDKを維持したまま、metadataの`build` commandの環境の`LDFLAGS`へ`-lsetjmp`を追加して実行しました。最初は固定日時の環境を渡し忘れたため、`LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=0`を明示した別の再link logも保存しています。link段階には、compile用の`-wasm-enable-sjlj`を使わないというwarningがあり、これもログに保持します。正式driverへの取り込みとwarningの分離は残件です。

Z3の丸め拒否候補は、目録の`p2-z3-hwf-guard-2/metadata.json`に単独compileと原本の対照のargv、SDK archiveとpatchのhash、objectのhashを記録しています。固定sourceを別のdirectoryへ展開して候補patchを適用し、SDKのC++20・WebAssembly例外・`SINGLE_THREAD`・`_MP_INTERNAL`・`_EXTERNAL_RELEASE`で`hwf.cpp`をcompileしました。`p2-z3-hwf-guard`は定義不足による初回失敗で、対照成功とは扱いません。個別compileはsolver全体のbuildや実行時の拒否を検証したものではありません。

提出時にはpatchの空白contextの書式だけを整えました。実際にcompileした版は目録の`p2-z3-hwf-guard-applied.patch`に保持し、修正後のpatchを別のコピーへ適用した`hwf.cpp`も全byte一致しました。目録のcontext検査logで追えます。Web配布物の組立の初回は、PATH上のZstandard 1.4.8と既存資材の1.5.7の不一致を検出して停止しました。固定sourceから別のdirectoryへCLIを作り、1.5.7を使うと組立は成功しています。metadataの書き換えや検査の迂回は行っていません。

workerと既存shimの回帰は、以下で再実行できます。Nodeのfixtureはブラウザーのisolationを模擬しているため、ブラウザーのCOOP/COEP・画面操作の検証とは分けます。

```sh
node --test tests/web/solver-process.test.mjs
node --test tests/web/*.test.mjs
node --test tests/synth/wasi-p1.test.mjs
```

SBYとyosys-smtbmcの原本への接続はP3、製品のschema・画面への接続はP5です。P2の比較だけで形式検証製品の完成や、唐突なsolverの既定変更を主張しません。Tang Nano実機は本リポジトリでは試していません。
