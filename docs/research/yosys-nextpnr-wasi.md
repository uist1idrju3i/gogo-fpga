# Yosys・nextpnrのWASIビルドとnative比較

[調査索引](../../RESEARCH.md#7-分割した調査)へ戻る。

合成・配置配線のビルド設定と比較規則、過去の測定・失敗・その後の修正をまとめます。RESEARCH.mdの旧見出しは案内として残し、固定値の表は移動しません。以下の測定は当時の条件の記録であり、現在の版を新たに測定した結果ではありません。

## Yosys v0.70 と WASI SDK

Yosys v0.70 は CMake でビルドします。upstream の [`CMakeLists.txt`](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/CMakeLists.txt#L159-L169) は `CMAKE_SYSTEM_NAME` が `WASI` の場合の設定を持ちますが、Emscripten 用の分岐はありません。このため、合成・配置配線ツールには WASI SDK を使い、書き込み部の Emscripten と使い分けます。

upstream の [`kernel/yosys.cc`](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/kernel/yosys.cc#L601-L605) は WASM 実行時の share ディレクトリーを `/share/` として扱います。`synth_gowin` が参照する techlibs を含むビルド時の `share` を、WASI 実行環境の `/share` に割り当てます。Slang を無効にしても、ABC と CMake が使う `libs/cxxopts`、`libs/fmt`、`libs/tomlplusplus`、`libs/boost_regex`、`libs/symfpu` の submodule は必要です。

S1 の合成 JSON は `creator` にコンパイラー情報、`attributes.src` に techlib の実行時パスを記録します。native は `build/native/share`、WASI は `/share` を使うため、比較では `creator` の Yosys gitlink 由来 prefix を確認し、`attributes.src` にある native share path だけを `/share` に置き換えます。それ以外の値とキー順は変換せず比較します。

WASI SDK 34.0 の Linux x86_64 アーカイブ名、URL、SHA-256 はRESEARCH.mdの固定値表に置き、pin checker が更新を監視します。ビルドスクリプトは同じ表を読み、値を重複して持ちません。

## nextpnr-himbaechel（Gowin）と WASI SDK

nextpnr は `nextpnr-0.11.1` の gitlink に固定します。upstream の [`himbaechel/CMakeLists.txt`](https://github.com/YosysHQ/nextpnr/blob/62e659ed6748e9f60b2a4aa25dd4fe79a9605881/himbaechel/CMakeLists.txt#L1-L22) では `HIMBAECHEL_SPLIT=ON` により microarchitecture ごとに実行ファイルを分けます。Gowin の [`CMakeLists.txt`](https://github.com/YosysHQ/nextpnr/blob/62e659ed6748e9f60b2a4aa25dd4fe79a9605881/himbaechel/uarch/gowin/CMakeLists.txt#L28-L57) は `HIMBAECHEL_GOWIN_DEVICES` に列挙した device ごとに chipdb を生成します。対象 family は `web/lib/boards.mjs` の4ボードから導き、`GW1NZ-1`、`GW1NS-4`、`GW1N-9C`、`GW2A-18C` 以外が入る場合はビルドを停止します。device 名も同じファイルの board 定義をテストで使います。

nextpnr は CMake の `STATIC_BUILD` を使い、Boost 1.92.0 の `program_options` と `iostreams` のみを静的リンクします。Boost は WASI SDK の clang で構築し、Eigen 5.0.1 はヘッダーとして参照します。Boost 1.92.0 の `iostreams` には例外構文を使うソースがあるため、`-fno-exceptions` ではビルドできません。WASI SDK 34 の WebAssembly 例外と `libunwind` を使い、Boost と nextpnr を `-fwasm-exceptions` で構築します。Apycula は `requirements-nextpnr.txt` のハッシュ付き固定版を使ってチップデータを生成します。依存の版、取得元、checksum は pin checker が検査するRESEARCH.mdの固定値表と lock file から読み、ビルドスクリプトに重複して持ちません。

nextpnr は native build で `bbasm` を用意し、WASI build の `BBA_IMPORT` に渡す方式です。upstream の [`CMakeLists.txt`](https://github.com/YosysHQ/nextpnr/blob/62e659ed6748e9f60b2a4aa25dd4fe79a9605881/CMakeLists.txt#L268-L271) と [`BBAsm.cmake`](https://github.com/YosysHQ/nextpnr/blob/62e659ed6748e9f60b2a4aa25dd4fe79a9605881/cmake/BBAsm.cmake#L70-L130) の構成に合わせ、native helper で chipdb を生成します。独立生成した `.bba` と chipdb には差があったため、WASI build には native build の `.bba` を読み込みます。4 family の chipdb が一致することはテストで確認済みです。WASI 実行時の外部 chipdb は `/share/himbaechel/gowin/` から読み、WASM と別に配置します。native build 用の実行時パスも設定済みです。Threads は無効、WASM の stack は 8 MiB です。

S2 の P&R テストは各ボードの Verilog テンプレートを WASI Yosys で合成し、`generateCst` の制約と同じ `--seed` を使って native と WASI nextpnr に渡します。出力 JSON はパース後に比較し、実測で差が現れ、ツールまたはパスの metadata と確認できた値だけを狭く置き換えます。配置などの差は許容しません。比較規則には置換数の確認と、非 metadata 値を変える負の対照を設けます。

nextpnr は ISC、Boost は Boost Software License 1.0、Eigen は主に MPL-2.0 で、一部に BSD など互換ライセンスのコードがあります。Apycula は MIT のライセンスです。S2 の chipdb 生成では Apicula と Python 依存をビルド時だけ使い、S3 では `gowin_pack` を実行する Apicula wheel と Pyodide runtime を web build / Release に追加します。ライセンス本文は `licenses/` と配布 zip に含めます。

T5 の UART で見つかった native / WASI の配置差には、同じ座標のセルの入力順を保持するパッチをビルド時に適用します。製品用の8代表回路×4ボードを各実行系で5回ずつ比較し、全320回の配置 JSON が一致しました。A/A 20回と負例10回、資源・時間・メモリー・ビルドの根拠は [S13 の記録と生 CSV](../experiments/S13-nextpnr-determinism.md) に残します。回路や JSON のキー順の正規化で差を隠していません。実機は本リポジトリでは試していません。

CPU 7候補のプログラム実行、負の対照、4ボードでの比較は [S14](../experiments/S14-cpu-library-matrix.md) に採否の基準を先に定め、実装を進めています。6候補の正常系と5種類の負の対照は予備検証済みです。SERV の4K は分散 RAM への割当を避ける上流の `-nolutram` で bitstream まで一致しました。1K の容量不足と9K・20K の配線差は別に記録し、差のあるボードを確認済みにはしていません。正式な性能測定とボードの昇格は未実施です。

上記は正式反復より前の状態です。その後、パッチ0004の同一grid keyの順序固定と `EIGEN_DONT_VECTORIZE` を製品用ビルドへ適用し、[CPUの正式反復](../experiments/S14-production-cpu.md)を完走しました。28組は配置配線成功18・容量超過6・frontend非対応4です。成功した18組の生JSONと資源は両系で各5回一致し、該当ボードをconfirmedへ更新しました。残る2分類は選択できない理由を保持します。元の差を正規化で隠したり、初回の失敗を成功に書き換えたりしていません。

その後、GCC 15のFMAを使う環境でSERV / 20Kの差が見つかりました。[S14Aの固定artifact・fast / off対照](../experiments/S14A-pnr-fp-contract.md)でheap placerの演算の縮約へ切り分け、その翻訳単位だけに `-ffp-contract=off` を追加します。6条件の各系5回、全60実行とA/A、値・キー順の負の対照、全列CSVを記録しました。compilerとchipdbの根拠を保持し、JSONやcreatorの置換で差を隠していません。[修正commitの全60組回帰](../experiments/S14A-final-regression.md)ではHDL32組とCPU18組が成功し、CPU6組の容量超過と4組のfrontend非対応を区別しました。全7,700セル、警告、出力、終了状態と、SERV / 20Kの追加反復20実行を監査しています。全60組の各5回反復や修正後CIの成功を主張するものではありません。

Apycula 0.35 と `requirements-nextpnr.txt` の固定依存で、4 family の chipdb 生成と P&R が成功しました。他の Apycula 版は試していません。native と WASI で別々に生成した `.bba` と chipdb は一致しなかったため、native build の `.bba` を WASI build に取り込みます。これにより、両実行形式が同じ chipdb を使うことをテストで byte 単位に確認します。

Boost 1.92.0 は `-fwasm-exceptions` と `libunwind` を使って WASI 向けにビルドできました。別の Boost 版は試していません。nextpnr WASM は 34,141,610 bytes、native binary は 55,324,696 bytes です。ビルド時間は初回の WASI が 5 分 5.890 秒、native が 2 分 44.644 秒でした。chipdb 生成を共有する変更後の再ビルドは、既存のビルドを再利用して WASI が 10.957 秒、native が 4.575 秒でした。
