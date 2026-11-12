# 形式検証ソルバーのビルドと実行方式

[調査の索引](../../RESEARCH.md#7-分割した調査) / [形式検証の原本](formal-verification.md) / [S15 P2の実験記録](../experiments/S15-solver-build-and-transport.md)

## 方式の比較と現在の制約

全候補の選択肢と無効理由、Bitwuzla・Boolectorの追加依存とprocess境界は、[候補と有効化条件](formal-capabilities.md)に整理しています。実測したYices2・Z3と、ソース登録だけの候補、モデル生成・診断用のbackendを区別します。

固定したYices2とZ3のCLIをWASI Preview 1で動かし、既存のshimへ双方向入力を接続する方式を先に調べています。SMT-LIBの意味、parser、判定処理をJavaScriptへ移植しません。原本のC APIと公式のEmscripten経路も比較候補ですが、まだ製品の既定方式を変更していません。

その後、Z3 WASIのclean buildも完了し、両solverのnative/WASIを同じ清浄な比較器commitで各5回・A/A 2回実行しました。全329行31列と294負の対照の独立監査が通っています。[正式条件・生CSV・資源・失敗と証拠](../experiments/S15-solver-native-wasi.md)を分けて保存します。上流CLIと既存workerの方式をP2で継続しますが、solverの既定は決めておらず、SBYや製品画面も未完了です。以下の「未確認」は各予備試行時点の制約を保持したものです。

P2の初回予備ビルドでは以下の制約を確認しました。その後のYices2は、SDKの`libsetjmp.a`もリンクすると、予備WASMで単純なSMT入力の判定と値の取得を通りました。清浄なcommitからの再build、native比較と正式反復は残っており、形式検証機能の完成を示す結果ではありません。

| 対象 | 確認した制約 | 対応と未確認の範囲 |
|---|---|---|
| Yices2のGMP | static archive指定だけでは、configureの別の`-lgmp`検査が検索先を見つけない | 同じ固定GMPのincludeとlibrary検索先も明示する。別のGMPへ置き換えない |
| Yices2のcross build | configureはWASIのhostを受け付けるが、引数なしのmakeは実行ホストの設定名を探す | makeにも`ARCH=wasm32-unknown-wasi`を渡す。SDKのcompiler・arch・最終linkをログで監査する |
| Yices2のtimer | WASI SDKには`alarm`の宣言がなく、元の`timeout.c`のコンパイルが停止する | solver内のalarmを黙って無効化しない。WASIでtimer APIが呼ばれたら診断と非ゼロ終了で拒否する候補patchを作成。worker側の期限・cancelは別に検証する |
| Yices2の版表示 | `make_source_version`がGit情報のない作業コピーの親Gitを拾い、別repoのrevisionを表示する | 固定ソースの`.gitcommit`と`SOURCE_DATE_EPOCH`を使う候補patchを作成。誤表示した初回は正常な検証結果として採用しない |
| Yices2のsetjmp/longjmp | 本体のコンパイル後、例外処理のsymbolが未解決でlinkが停止する | SDK同梱の`libsetjmp.a`を追加すると予備CLIを生成できた。独自の例外処理は実装せず、SDKのruntimeと`-fwasm-exceptions`・`-wasm-enable-sjlj`を併用する |
| Z3の浮動小数点 | SDKの`fenv.h`には`FE_UPWARD`・`FE_DOWNWARD`・`FE_TOWARDZERO`がなく、`hwf.cpp`が停止する | 定数の偽装や`fesetround`の無条件成功は行わない。C APIを選ぶだけでこのソース依存が消えるとも仮定しない |
| Z3のnative参照版 | 初回に選ばれたg++ 11.4には、原本が要求する`<format>`がない | ソースを古いC++へ書き換えず、隔離したClang 21とlibc++ 21で再調査する。実際のC++ compilerをmetadataに記録する |

原典は固定版の[Yices2 configure](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/configure.ac)、[Makefile](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/Makefile)、[timer](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/src/utils/timeout.c)、[版の生成](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/utils/make_source_version)、[Z3のhwf.cpp](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/util/hwf.cpp)、[array_decl_plugin.cpp](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/ast/array_decl_plugin.cpp)です。

## timerと浮動小数点を区別する理由

その後のZ3 WASIは全コンパイル後に例外libraryとfork登録の未解決で停止しました。SDKのlibunwind・setjmpを明示し、WASIのfork登録だけを除外すると隔離した手動linkが通りました。既存shimへ単一threadのyieldを加えた予備18条件も通っています。清浄なbuildと正式比較の成功ではありません。[link失敗・patchの理由・再実行の記録](../experiments/S15-z3-wasi-link.md)へ詳細を残します。

timerはworkerの強制終了で期限を守れる可能性がありますが、その仕組みを確認するまではtimeout対応済みとしません。上流timerが使えないときに成功を返す代用品は作りません。WASI timerの拒否と、hostが期限超過を分類して古いjobの応答を捨てることを、別の負の対照で調べます。

一方、浮動小数点の丸めは数値計算の意味に関わります。ブラウザーにない丸めモードを定義するだけでは正しい実装になりません。Z3の[scoped_timer.cpp](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/util/scoped_timer.cpp)にもthread実装が残りますが、WASIの初回コンパイルはその前に停止しました。未到達の箇所を実際のビルド失敗として記録しません。公式WASMの設定とC APIの比較条件は[先例の調査](formal-verification.md#z3の公式wasm先例)へ戻れます。

## 公式Emscriptenとhardware浮動小数点の制約

使用中のEmscripten 6.0.13では、muslの`fenv.c`の`fegetround`は常に最近接を返し、`__fesetround`は引数のモードへ変更せず0を返します。ヘッダーの3定数が存在してコンパイルを通っても、WASIの不足を意味が等しい実装で補ったとは言えません。C APIを使っても、このC++実装のコンパイル・リンクと丸めの問題は残ります。

Z3の原本では、`hwf_manager::set_rounding_mode`が実際の丸め変更を要求します。このmanagerは`subpaving` tacticの`numeral=hwf`などで使われ、一般のSMT浮動小数点理論と同一ではありません。WebAssemblyだけこのmethodを例外付きで拒否する候補patchを用意しました。これは定数や丸め関数のno-opを足す方法ではなく、未対応のhardware演算を成功させないための境界です。

固定sourceの同じファイルをSDKで個別にコンパイルすると、無修正では3定数の不足で失敗し、候補patchを適用したものは成功しました。初回は検査用の定義が足りず、GMPヘッダーの不足で停止しました。この失敗と修正後の対照ログも保存します。これは単一のobjectのコンパイル検査です。bit-vectorやarrayを含めた全solver buildと実行比較、非対応要求の明示的な拒否の実行確認はまだ残っており、採用済みとは扱いません。

原典: [Emscriptenのfenv実装](https://github.com/emscripten-core/emscripten/blob/6.0.13/system/lib/libc/musl/src/fenv/fenv.c)、[同じ版のfenv定数](https://github.com/emscripten-core/emscripten/blob/6.0.13/system/lib/libc/musl/arch/emscripten/bits/fenv.h)、固定Z3の`src/util/hwf.cpp`と`src/math/subpaving/tactic/subpaving_tactic.cpp`。

## native参照版のlinkと応答の字句境界

隔離したClang 21とlibc++ 21でZ3をコンパイルした予備試行は、最後のlinkでlibc++abiの明示指定が足りず失敗しました。標準ライブラリーのincludeとlinkを分離し、CMakeの`CMAKE_EXE_LINKER_FLAGS`と`CMAKE_CXX_STANDARD_LIBRARIES`で指定する候補へ変えます。`std::format`と例外の小さな対照は、ABI指定なしで失敗、`-lc++abi -lunwind`付きで成功しました。Z3本体のclean buildやWASMの成功ではなく、失敗と対処候補を[S15 P2](../experiments/S15-solver-build-and-transport.md)へ記録しています。

SMT-LIB 2.6系の応答を区切る基盤も追加しました。固定Yices2の`smt2_read_string_var`とcomment処理に合わせ、文字列の二重引用符、縦棒付きsymbol、括弧、UTF-8の分割、途中欠落と上限を検査します。式の解析・意味判定は上流solverに任せ、字句境界が閉じたことを成功や証明としません。旧2.0のbackslash escapeは対象外です。単体12件は成功しましたが、実solverの正式比較・反復と画面統合は未完了です。

### Z3 nativeのbuild完了と独立した監査

その後、明示したABI linkを含む清浄なbuildが完了し、Z3 nativeの実binaryから5.3.3の版表示を得ました。bit-vector・array・長い値・構文エラー・応答の欠落・unknownの6条件と、通常のSMT浮動小数点、hardware丸めのnative対照、計算要求後の期限切れと取消が予備検査で成功しました。hardware対照は`subpaving :numeral hwf`がgoalを返すことの検査であり、証明ではありません。WASIのbuildと両系の比較は未完了です。binaryのhashと実際のC++ compiler、CMake、build時間は[実応答の記録](../experiments/S15-solver-protocol.md)へ残します。

Yices2 WASIでも入力待ちとは別に、80変数を79種類の値へ割り当てる計算要求を送り、期限切れと取消を確認しました。CSVの全31列をraw log・結果JSON・build metadataへ照合する独立したPython監査器も追加しました。正常出力の全byte比較、行の欠落・重複、A/A、source snapshot、失敗分類、負の対照と欠測を含む資源集計を検査します。予備21実行の監査は成功しましたが、正式5回反復の完了やT6全体の完成とは扱いません。

## 正式比較と圧縮配信の制約

その後、Z3のclean buildを終え、両solverのnative/WASIを清浄な`3ea717e`の比較器で各5回・A/A 2回実行しました。全329行31列と294負の対照を監査し、正常3条件の全byte一致と異常分類を確認しました。欠測をnullに保つ資源、生CSV、全buildの由来と警告、証拠ZIPは[正式比較](../experiments/S15-solver-native-wasi.md)、予備21実行などの履歴は[実応答記録](../experiments/S15-solver-protocol.md)へ分けます。Z3 WASIはZstandardで5,246,594 byteとなり、host展開後のhashも元と一致しました。ブラウザーの展開、SBYと製品画面、既定solverの選定は未完了です。

## 標準入力と輸送の境界

### 実Yices2の応答で確認した境界

その後、固定sourceから作ったnativeとWASIのYices2を、実stdin/stdoutと字句framerへ接続しました。bit-vector、arrayのpush/pop、値とmodel、32,768 bitの長い値を予備比較し、同じsolverの両系で応答の全byteが一致しました。5回反復、Z3との比較、SBYと画面の接続はまだ未完了です。[実応答比較の記録](../experiments/S15-solver-protocol.md)へ条件と初回の失敗を分けて残します。

重要な制約は、Yices2が構文エラーを`(error ...)`で返しても終了コード0になることです。固定原本の[parse loopと正常終了](https://github.com/SRI-CSL/yices2/blob/85cf17e44eac76b5d14b297c09fc9bfecf47ef65/src/frontend/yices_smt2.c#L1182-L1221)でも、構文エラーでloopを抜けた後に`YICES_EXIT_SUCCESS`を返します。framerの正常終了やprocessの終了コードだけを、論理判定の成功・証明の成立としません。P3では上流yosys-smtbmcの応答検査を再利用し、SMTの意味解析をJavaScriptへ複製しません。

Yices2の値の表示では、問い合わせたarrayの式は入力の`#x2`を保持し、評価値は`#b0111`になりました。長い値には上流printerの改行も入ります。最初の検査器は両方を誤って予想して失敗しました。出力を正規化せず、固定CLIの表示をそのまま比較します。また、`(exit)`を分割して送ると、最後の改行を送る前にsolverが終了してwriteが拒否される場合があります。正常終了の検査はstdinのEOFで行い、終了後のwrite拒否とは分けます。

既存shimはstdinを常にEOFにしていたため、同期の`stdin(length)` callbackを追加しました。戻り値は要求長以下の`Uint8Array`に限り、Promise、過大な値、閉じたdescriptor、無効なmemoryを拒否します。短いreadで次のiovecを待たず、既定のEOFも維持します。これはbyte輸送の基盤であって、SMTのresponse framingやsolverの成功判定ではありません。

容量を制限した共有bufferの基盤を追加し、EOF、終了後のwrite、cancel、backpressureをNodeの実workerを含む11件で検査しました。`crossOriginIsolated`と非同期Atomicsが使えなければ開始を拒否します。Nodeのfixtureではisolation flagを設定しており、ブラウザーのヘッダーを検証したものではありません。

その後、専用workerの期限・終了管理とjob IDの照合を追加しました。古いjobの終了通知は無視し、現在のjobのSHA-256照合と終了通知、stdoutとstderr双方のEOFを要求します。破損、trap、timeout、cancel、crash、出力上限、consumerの停止を非成功へ分類し、528,384 byteの分割出力も検査しました。これはSMTの意味判定とは別のprocessの管理です。SMT framing、nativeとWASMの正式なsolver比較・反復は残っています。hostの共有bufferと、WASMのpthreadは区別します。ブラウザーの画面操作・実機確認・P3のSBY接続は、この予備調査では試していません。
