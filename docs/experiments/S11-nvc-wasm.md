# S11 NVC r1.23.1 の WASM 化

- 状態: 中止（Emscripten NVC はリンクしたが、Node の counter testbench が elaboration で失敗）
- 日付: 2026-10-31
- 関連: [凍結基準](S11-nvc-wasm-criteria.md)

## 目的と仮説

NVC r1.23.1 を LLVM なしで WASM にし、ブラウザーと Node から実行できるか調べます。方式 1 の WASI SDK 34.0 を先に試し、ucontext または pthread が利用できないことを configure log で確認した場合に限り、方式 2 の Emscripten に切り替えます。

## 採否の基準

最初の branch commit `70d4160a3e51a5bc13f6376f7a16f99177f3a8a4` に固定した[凍結基準](S11-nvc-wasm-criteria.md)に従います。ビルド、2回の clean build の同一性、native/WASM parity、negative control、5回連続のテストのすべてが合格条件です。方式 3 の打ち切り条件に当たった場合は実装を続けません。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `026a7f5aef88521b5fc98a1a7d7e70d714404430` |
| NVC | tag `r1.23.1`、peeled commit `fab54a9e96964b431050d837e163c22282a1df6c` |
| ホスト | Linux 7.0.0-42-generic、x86_64、12 logical CPU、30 GiB RAM |
| WASI SDK | 34.0、Linux x86_64 archive SHA-256 `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4` |
| Emscripten | emsdk 6.0.13、emcc revision `e13ee988ce3d87a738dd8f3661d02223308c412a` |
| Node.js | emsdk 同梱 Node v24.19.0。counter testbench は elaboration 中に失敗 |
| zstd | pinned `vendor/zstd` commit `f8745da6ff1ad1e7bab384bd1f9d742439278e99` を Emscripten/native 両方の build に使用 |
| NVC submodule | cutoff path のため `vendor/nvc` は追加せず |
| 出力先 | `build/S11/`。NVC の Emscripten JavaScript/WASM は生成したが、Node の counter testbench が失敗 |
| 変える条件 | WASI から Emscripten へ移行。両方で `--disable-llvm` |
| 固定した設定 | NVC r1.23.1、Emscripten では `-pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false`。試験 artifact は Node raw filesystem mode の JavaScript/WASM |

NVC の `NEWS.md` の r1.23.1 release section を確認しました。`README.md` は NVC を GPL-3.0-or-later とし、VITAL library のライセンス状態が不明なため厳格な配布では `--disable-vital` を勧めています。`COPYING` の全条文は GPL version 3 です。初期の configure probe では `--disable-vital` を指定しましたが、最終 native/Emscripten build の `config.status --config` にはこの option がなく、VITAL library を無効にした build ではありません。配布物は作らず、license bundle も追加していません。

## 手順

以下は初回の configure 失敗を再現する手順です。後段では backtrace と interpreter-only patch を適用した NVC を build し、Node counter testbench を試しました。SDK はリポジトリーの固定版一覧で版と hash を確認し、`vendor/zstd` は記載した commit を使います。

```sh
git clone --depth 1 --branch r1.23.1 https://github.com/nickg/nvc.git build/S11/nvc-source
(cd build/S11/nvc-source && autoreconf --force --install -I m4)

mkdir -p build/S11/wasi-configure
cd build/S11/wasi-configure
CC="$PWD/../../wasi-sdk-34.0-x86_64-linux/bin/clang" \
CXX="$PWD/../../wasi-sdk-34.0-x86_64-linux/bin/clang++" \
CFLAGS="-O2 -g0" \
CXXFLAGS="-O2 -g0 -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false" \
LDFLAGS="-fwasm-exceptions -lunwind" \
../nvc-source/configure --build=x86_64-pc-linux-gnu \
  --host=wasm32-wasi --disable-llvm --disable-tcl --disable-vital
```

WASI configure は `ucontext.h` と `sys/ucontext.h` がなく、`-pthread` と `-lpthread` の両 probe が失敗して停止しました。これを記録した後、凍結基準どおり Emscripten へ切り替えました。

Emscripten configure に先立ち、pinned zstd を static library として build しました。以下の configure にはその install prefix の `pkg-config` metadata を渡します。

```sh
source build/emsdk-6.0.13/emsdk_env.sh
emcmake cmake -S vendor/zstd/build/cmake -B build/S11/zstd-emscripten \
  -DCMAKE_INSTALL_PREFIX="$PWD/build/S11/emscripten-deps" \
  -DZSTD_BUILD_SHARED=OFF -DZSTD_BUILD_STATIC=ON
cmake --build build/S11/zstd-emscripten --target install --parallel 1

mkdir -p build/S11/emscripten-configure
cd build/S11/emscripten-configure
export PKG_CONFIG_PATH="$PWD/../emscripten-deps/lib/pkgconfig"
export CPPFLAGS="-I$PWD/../emscripten-deps/include"
export LDFLAGS="-L$PWD/../emscripten-deps/lib -pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -sSTANDALONE_WASM -lunwind"
CC=emcc CXX=em++ \
  CFLAGS="-O2 -g0 -pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -sSTANDALONE_WASM" \
  CXXFLAGS="-O2 -g0 -pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -sSTANDALONE_WASM" \
  ../nvc-source/configure --build=x86_64-pc-linux-gnu \
  --host=wasm32-unknown-emscripten --disable-llvm --disable-tcl --disable-vital
```

The requested Emscripten form included `-fwasm-exceptions` and `-sSTANDALONE_WASM`. `-lunwind` was also tried. An additional probe with `-sWASM_EXCEPTIONS=1` stopped because emsdk 6.0.13 reports that setting as internal and disallows setting it from the command line.

## counter testbench

計測器は使用していません。生成した VHDL template と counter testbench を native NVC と Emscripten NVC で実行しました。native は 40 ns で停止し VCD を出力しました。WASM は analyze まで成功しましたが、elaboration が Node の indirect-call trap で失敗し、simulation と parity には進めませんでした。

## 結果

| Frozen criterion | Result |
|---|---|
| 1. Build succeeds | **Pass**。Emscripten NVC executable/WASM を link し、`--version` も実行できた。Emscripten `make` は不要な標準ライブラリー再生成で失敗したが、凍結基準に従い native NVC で標準ライブラリーを生成して WASM test に渡した |
| 2. Two clean builds are byte-identical | Not run |
| 3. Native/WASM report and waveform parity | Not met. Native template test passed; WASM trapped during elaboration before simulation |
| 4. Syntax, undefined entity, severity failure, corrupted-WASM controls | Not run |
| 5. Five consecutive passing tests | Not run |

WASI configure のログは次のとおりです。

```text
checking for ucontext.h... no
checking for sys/ucontext.h... no
checking whether pthreads work with "-pthread" and "-lpthread"... no
checking whether pthreads work with -pthread... no
configure: error: pthread not found
```

Emscripten configure は zstd dependency の用意後、必須の `_Unwind_Backtrace` probe まで進みました。

```text
checking for unwind.h... yes
checking for library containing _Unwind_Backtrace... no
wasm-ld: error: ... undefined symbol: _Unwind_Backtrace
configure: error: cannot find library for _Unwind_Backtrace
```

The link command tried `-lunwind`, `-lc++abi`, and `-lpthread`; its Emscripten library selection used `libunwind-mt-legacyexcept.a` and `libc++abi-mt-legacyexcept.a`. This initial configure check for the stack unwinder used by `src/debug.c` failed. The later extension added `emscripten-disable-backtrace.patch`, after which configure and the NVC executable/WASM link succeeded. The initial probe failure did not establish whether the final artifact would run; the Node test result is recorded below.

## 捨てた試行と経緯

The first Emscripten configure stopped earlier because libzstd was not found. Building pinned zstd for Emscripten got past that dependency check. Adding `-lunwind` did not resolve `_Unwind_Backtrace`. A separate `-sWASM_EXCEPTIONS=1` attempt failed because the setting is internal to emsdk 6.0.13. Retrying with the requested `-fwasm-exceptions`, `-mllvm -wasm-use-legacy-eh=false`, `-sSTANDALONE_WASM`, and `-lunwind` still failed at the same link probe.

## 結論と未確認事項

方式 1 は ucontext と pthread の不在により使えませんでした。方式 2 の最初の configure は required `_Unwind_Backtrace` link probe を通過しませんでしたが、backtrace patch で解消し、NVC WASM の link まで進みました。最初の打ち切り判断は誤りであり、ユーザーの指摘後に再開しました。再開後の実際の打ち切りは次節に記録します。

NVC r1.23.1 以外の changelog、NVC WASM の import list、Chromium runtime、VITAL library の配布条件、実機 FPGA は本リポジトリーでは試していません。Node v24.19.0 では後述の counter testbench を試し、elaboration で trap になりました。

## 延長試行

開始は `2026-10-31T00:38:14Z`、打ち切りは `2026-10-31T00:44:05Z` です。経過時間は **5 分 51 秒**で、4 時間の上限には達していません。延長基準は `36a1afe` で固定し、その前に #37 の head を取り込む merge commit `c9a301b913a2661da81c17aa776d0745fea44971` を作成しました。最初の基準 1〜5 は変更していません。

`build/S11/wasi-source` の既存 NVC ソースを使いました。この展開物には Git metadata がないため、この試行ではその commit を独立に再確認できません。以前の記録では r1.23.1 の peeled commit を `fab54a9e96964b431050d837e163c22282a1df6c` と確認しています。

`patches/nvc/emscripten-disable-backtrace.patch` の 1 ファイルを適用しました。Emscripten では configure の unwinder 検査を省き、`src/debug.c` の backtrace、unwind 情報、`dlfcn.h` の参照を無効にします。元の `configure.ac` と `src/debug.c` に対する patch であり、vendor source は編集していません。

Emscripten 6.0.13 の configure はこの patch で成功しました。probe は `ucontext.h` と `sys/ucontext.h` を検出し、`getcontext` は検出しませんでした。`-pthread` と `-lpthread` の probe は成功しました。NVC source には `swapcontext`、`makecontext`、`setcontext` による coroutine 切り替えが見つからず、`ucontext_t` の参照は signal/stop-world の状態取得に使われていました。このため、coroutine 置換 patch は作成していません。

configure は system `pkg-config` 経由で libffi を検出しましたが、build では `src/jit/jit-ffi.c` の `<ffi.h>` が見つからず停止しました。同時に、`src/jit/jit-code.c` の `code_emit_trampoline` でも WASM32 向けの `veneer` がないため compile error が発生しました。当時は小さな `__EMSCRIPTEN__` guard で直せる compile error を、addendum の上限条件に当たる cutoff と誤認しました。ユーザーの指摘後に作業を再開し、interpreter-only dispatch の根拠を確認して guard と libffi stub を追加しました。最初の打ち切り判断は誤適用として記録します。

再現時は repository root から、固定済み SDK の Emscripten environment と以下の configure/build command を使います。`PKG_CONFIG_PATH` と `CPPFLAGS` は既存の pinned zstd prefix を指します。Emscripten の JS と WASM 出力を許可する延長基準に従い、この試行では `-sSTANDALONE_WASM` を指定していません。

```sh
source build/emsdk-6.0.13/emsdk_env.sh
export PKG_CONFIG_PATH="$PWD/build/S11/emscripten-deps/lib/pkgconfig"
export CPPFLAGS="-I$PWD/build/S11/emscripten-deps/include"
export LDFLAGS="-L$PWD/build/S11/emscripten-deps/lib -pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false"
export CFLAGS="-O2 -g0 -pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false"
export CXXFLAGS="-O2 -g0 -pthread -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false"

(cd build/S11/wasi-source && autoreconf --force --install -I m4)
(cd build/S11/emscripten-configure-backtrace && \
  CC=emcc CXX=em++ ../wasi-source/configure \
    --build=x86_64-pc-linux-gnu --host=wasm32-unknown-emscripten \
    --disable-llvm --disable-tcl --disable-vital)
make -C build/S11/emscripten-configure-backtrace -j4
```

| 延長後の基準 | 結果 |
|---|---|
| 1. Build succeeds | Pass。Emscripten NVC executable/WASM を link し、`--version` を実行した。Emscripten `make` の標準ライブラリー生成は失敗したが、必要な native standard libraries を生成して使用した |
| 2. 2 回の clean build が byte-identical | 未実施 |
| 3. native/WASM の report と waveform parity | 未達。後述の関数ポインター cast emulation で WASM の分析と elaboration は通過したが、simulation は完走せず、report と waveform の parity は確認できていない |
| 4. syntax/entity/severity failure と破損 WASM の負の対照 | 未実施 |
| 5. 5 回連続テスト | 未実施 |

extension の失敗ログは `build/S11/` に保持しています。

| Log | SHA-256 | 結果 |
|---|---|---|
| `build/S11/autoreconf-emscripten-backtrace.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | autoreconf 成功、出力なし |
| `build/S11/emscripten-configure-backtrace.log` | `4bc98a4473c6bf857da1b590bc762f5a8cd9376b50e185d186314839e30ef027` | backtrace patch 適用後の Emscripten configure 成功 |
| `build/S11/emscripten-build-backtrace.log` | `ad0202be949752b7f8749b10eab89ffcfd455257354de6a127d7618f28590aeb` | `jit-code.c` の `veneer` と `jit-ffi.c` の `ffi.h` で compile 失敗 |

最初の打ち切り時点では `vendor/nvc`、build script、host、fixtures、tests、CI job、license bundle を追加していませんでした。この判断を誤りとして訂正し、再開後は実際の打ち切りに必要な patch と test fixture のみを記録対象にしました。

## 再開後の検証と打ち切り地点

延長試行の時計は `2026-10-31T00:38:14Z` から継続しました。最初の停止 `00:44:05Z` は `jit-code.c` の guard を backend replacement と取り違えた誤適用でした。修正指示後、`2026-10-31T01:32:23Z` に tracked counter testbench が Node で失敗したことを確認し、停止しました。経過時間は **54 分 09 秒**で、4 時間の上限には達していません。

ユーザーの判断により、試行を `2026-10-31T01:53:45Z` に再開しました。これまでに使った54分09秒を4時間の予算から差し引くと、再開時の残りは **3時間05分51秒**です。ユーザー決定による逸脱として、Addendum の「counter testbench が Node で最後まで動かない」という cutoff は、残り時間内に testbench を完走させられない場合に適用すると解釈します。凍結基準ファイルは変更していません。

### interpreter-only dispatch の根拠

NVC には実行時に native JIT を切り替える環境変数や CLI option は見つかりませんでした。`--disable-llvm` を指定すると `nvc.c` の LLVM 登録は compile-time gate で除外されます。native plugin の登録 branch も `ARCH_X86_64 && 0` で無効です（NVC r1.23.1 の [`src/nvc.c:846-854`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/nvc.c#L846-L854)）。

`jit_new()` は zero-initialize した `jit_t` を返し、tier list は空のままです（[`src/jit/jit-core.c:142-167`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/jit/jit-core.c#L142-L167)）。`jit_compile()` は intrinsic がなければ entry を `jit_interp` にし、`next_tier` に空の tier list を保存します（[`src/jit/jit-core.c:258-267`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/jit/jit-core.c#L258-L267)）。thunk entry も `jit_interp` に直接設定されます（[`src/jit/jit-core.c:736-745`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/jit/jit-core.c#L736-L745)）。interpreter は `next_tier` がある場合にだけ tier-up します（[`src/jit/jit-interp.c:1129-1142`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/jit/jit-interp.c#L1129-L1142)）。この静的 dispatch 経路は確認しましたが、counter testbench は elaboration 中に失敗したため、interpreter 実行が最後まで動くことは確認できていません。`jit-code.c` の Emscripten guard は native trampoline emission を明示的に拒否します。

`jit-ffi.c` は Emscripten で libffi を参照せず、foreign library load と foreign subprogram call に明示的な error を返す stub に置き換えました（[`emscripten-interpreter-only.patch`](../../patches/nvc/emscripten-interpreter-only.patch)）。この stub を含む Emscripten executable の link は通過しましたが、foreign subprogram negative control は実行していません。

### build と counter testbench

system に `libzstd` development package がなかったため、pinned `vendor/zstd` commit `f8745da6ff1ad1e7bab384bd1f9d742439278e99` から native static library を out-of-tree で build しました。その pkg-config path を渡した native NVC configure が通り、`--disable-llvm --disable-tcl` の serial `make -j1` で NVC と standard libraries を生成しました。

Emscripten 6.0.13 の `bin/nvc` と `bin/nvc.wasm` を link しました。WASM は **2,668,745 bytes**、SHA-256 `e81ea25def8d77ba8f72af75adcc5456755fff42aa22144c644c534e75eaea76` です。この試行の executable は Node raw filesystem mode であり、browser artifact ではありません。全体の Emscripten `make -j1` は標準ライブラリー `IEEE.FIXED_PKG` の生成時に `RuntimeError: null function or function signature mismatch` で失敗しました。方式 1 の固定基準に従い、その後は native NVC で標準ライブラリーを生成して WASM NVC に渡しました。

board blink template の VHDL は `createBlinkTemplate()` の全 board ID で同じ `vhdlTemplate()` を返します（[`web/lib/templates.mjs:114-143`](../../web/lib/templates.mjs#L114-L143)）。native NVC ではその VHDL と [`tests/fixtures/nvc/template_counter_tb.vhd`](../../tests/fixtures/nvc/template_counter_tb.vhd) の組み合わせが 40 ns で停止し、`led='0'` を report して VCD を生成しました。Node v24.19.0 の WASM NVC では `-a` が成功し、`-e template_counter_tb` で次の trap が発生しました。

```text
RuntimeError: null function or function signature mismatch
    at wasm://wasm/00a2e326:wasm-function[872]:0x8ff98
    at wasm://wasm/00a2e326:wasm-function[504]:0x59a2a
    at wasm://wasm/00a2e326:wasm-function[638]:0x691b7
    at wasm://wasm/00a2e326:wasm-function[634]:0x68a6e
    at callMain (.../bin/nvc:2:104265)
Node.js v24.19.0
```

`WORK.TEMPLATE_COUNTER_TB.elab` と VCD は作られず、simulation は始まりませんでした。`nvc-wasm-counter-test.log` でも別の小さな counter testbench が同じ trap になりました。これは「link しても counter testbench が Node で最後まで動かない」という実際の addendum cutoff でした。最初の停止時点では root cause を特定できませんでしたが、再開後の debug build による調査で関数ポインターの戻り値型不一致を確認しました（次節）。board 別に4回繰り返す test loop は始めていません。VHDL source は全 board ID で同一であることを確認しましたが、4 board の full test は未実施です。

再現用には、`createBlinkTemplate("tangnano1k", "vhdl")` が返す `src/top.vhd` と同一であることを確認した source を `build/S11/top.vhd` に用意し、tracked testbench と次のコマンドを使いました。

```sh
source build/emsdk-6.0.13/emsdk_env.sh
export NVC_LIBPATH="$PWD/build/S11/nvc-native-build/lib"
node --version
mkdir -p build/S11/wasm-template-counter-test
cd build/S11/wasm-template-counter-test
"$OLDPWD/build/S11/nvc-build-noderawfs-fixed/bin/nvc" \
  --std=2008 -L "$NVC_LIBPATH" --work=work -a \
  "$OLDPWD/build/S11/top.vhd" \
  "$OLDPWD/tests/fixtures/nvc/template_counter_tb.vhd"
"$OLDPWD/build/S11/nvc-build-noderawfs-fixed/bin/nvc" \
  --std=2008 -L "$NVC_LIBPATH" --work=work -e template_counter_tb
```

The first command succeeds; the second exits nonzero with the recorded Node trap. Run this command from the repository root with emsdk Node on PATH to regenerate the template input.

```sh
node --input-type=module -e 'import { createBlinkTemplate } from "./web/lib/templates.mjs"; process.stdout.write(createBlinkTemplate("tangnano1k", "vhdl").files.get("src/top.vhd"));' > build/S11/top.vhd
```

### 追加診断と実際の cutoff

ユーザー判断で試行を `2026-10-31T01:53:45Z` に再開し、残り予算は3時間05分51秒でした。Node v24.19.0 用に `-O0 -g --profiling-funcs -sASSERTIONS=2 -sSAFE_HEAP=1` で serial build したところ、analysis は成功し、elaboration は `object_copy_finish` で `RuntimeError: null function or function signature mismatch` になりました。stack は `object_copy_finish` → `tree_copy_finish` → `vhdl_architecture_instance` → `elab_architecture` を示します。`wasm-dis` で `object_copy_finish` を逆アセンブルすると `call_indirect` は1箇所だけでした。

原因は NVC r1.23.1 の callback 型です。[`src/object.h:171`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/object.h#L171) の `object_copy_fn_t` は `bool` を返す一方、[`src/tree.h:638-639`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/tree.h#L638-L639) の `tree_copy_fn_t` と `type_copy_fn_t` は `void` を返します。[`src/tree.c:1405-1406`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/tree.c#L1405-L1406) は後者を `object_copy_fn_t` に cast して保存し、counter testbench の elaboration で実行される `vhdl_architecture_instance` は `tree_copy_cb` と `type_copy_cb` を渡します（[`src/vhdl/vhdl-inst.c:43-57,370-377`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/vhdl/vhdl-inst.c#L43-L57)）。[`src/object.c:1201-1205`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/object.c#L1201-L1205) はその callback を `object_copy_fn_t` として間接呼び出しします。よって、実際に到達した Wasm `call_indirect` が `bool` 戻り値を期待する一方、実体は `void` 戻り値であり、function signature mismatch を発生させます。これは null の JIT/VHPI hook ではなく、関数ポインターの戻り値型不一致です。

`-sEMULATE_FUNCTION_POINTER_CASTS=1` を追加すると、元の elaboration trap は回避できました。しかし、この flag-only workaround では testbench を完走できませんでした。`-sSAFE_HEAP=1` の診断実行では `interp_exit` 中の alignment fault、SAFE_HEAP を外した `-sASSERTIONS=2` 実行では stack cookie overwrite、さらに `-sASSERTIONS=0 -sSTACK_OVERFLOW_CHECK=0` の実行では analysis と elaboration が成功した後、simulation が `** Fatal: (init): missing body for (null)` で停止し、330 bytes の不完全な VCD が残りました。後者の診断ログは `nvc-emulate-noassert-counter-run.log` です。[`src/jit/jit-core.c:299-357`](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/src/jit/jit-core.c#L299-L357) はこの診断を、`jit_fill_irbuf` が対象 MIR unit を得られないときに出しますが、`f->name` が null になる根本原因は未確認です。この二つ目の失敗を最初の function signature mismatch と同一原因とは断定しません。

正しい callback signature に直すには、`src/object.h` の `object_copy_fn_t` を `void` 戻り値に変更する必要があります。これは exempt でない NVC source の6ファイル目となるため、修正には着手できません。指定された `EMULATE_FUNCTION_POINTER_CASTS` でも runtime parity は得られず、build-flag だけでは criteria 3 を達成できないため、file-count cutoff として停止します。NVC patch は従来の2ファイル、out-of-scope NVC source は5ファイルのままで、6ファイル目は変更していません。凍結基準1は link 済み debug artifact については pass のままですが、2、3、4、5は未達または未実施です。成功経路の submodule、build script、host、tests、CI、license、pin は追加していません。

追加診断は `2026-10-31T02:03:23Z` に打ち切りました。再開後の経過は **9分38秒**、延長試行全体の累計は **1時間03分47秒**で、残り予算は **2時間56分13秒**でした。

追加ログと artifact は次のとおりです。

| Path | SHA-256 | 結果 |
|---|---|---|
| `build/S11/nvc-debug-build-2.log` | `a0e8d41547afba1f48fe1049540d7a4dc23670013507867759744ee4140c56d6` | `-g --profiling-funcs -sASSERTIONS=2 -sSAFE_HEAP=1` の build 成功 |
| `build/S11/nvc-debug-counter-elaboration-2.log` | `0e4a7ab3afe72dd60c33155cc91fb9a5de5a4ba3e284a624752777379a8e92bb` | `object_copy_finish` の named stack trace |
| `build/S11/nvc-debug-emulate-casts-link.log` | `21e7387aa5b1ef35065c72c8251b0943cb61cb3c872282f8917ae97c2a4d5acf` | function-pointer-cast emulation を有効にした link 成功 |
| `build/S11/nvc-emulate-no-safeheap-counter-run.log` | `37bf0ad1c04d54cc1dbbfb8559e877ac292d9b1e8736e21a0362cd65e87a0668` | assertion build の stack cookie overwrite |
| `build/S11/nvc-emulate-noassert-counter-run.log` | `036c65f8facc9c4efcd6393776266eb2aab07ece271b1b868e0aee9731523b12` | `missing body for (null)` で simulation 停止 |
| `build/S11/wasm-template-counter-emulate-noassert/counter.vcd` | `d395001cdd7d2d09871d96f621eee57b144284a9aec654e6fa0329422445958d` | 330-byte の不完全な VCD |

### 変更範囲と成果物

patch は2ファイルで、NVC の patch が触れる固有ファイルは9つです。addendum の exempt file（`src/debug.c`、`src/thread.c`、`src/jit/jit-ffi.c`、`configure.ac`、`Makefile`）を除くと、out-of-scope file は5つになります。該当するファイルは `src/jit/jit-code.c`、`src/jit/jit-intrin.c`、`src/vhpi/vhpi_user.h`、`thirdparty/cpustate.c`、`src/util.c` です。上限の「5つより多い」には当たりません。

再現に必要な patch と counter testbench fixture は残しました。counter testbench の失敗を cutoff としたため、`vendor/nvc` submodule、build script、host、test runner、CI job、license bundle、pin checker 更新は実装していません。二つの clean WASM build、positive fixture 全件の parity、negative control、5回連続実行は未実施です。

| Log | SHA-256 | 内容 |
|---|---|---|
| `build/S11/emscripten-build-noderawfs-memory3.log` | `080ce3a42cbda303a37e77d7e480ede65621866616ff0bd94e1fe54b134fe0fd` | Emscripten `make -j1`、standard library 生成中に失敗 |
| `build/S11/native-build.log` | `7ddd2de8e4e00b0cf42f215a8ddba2ba99722f69069efb46b1904f6b1dfcc84d` | native NVC と standard library の build 成功 |
| `build/S11/nvc-native-template-counter-test.log` | `3165d18e72ae0a0df35785b1aabf4e6633b20b10e366f5b8b68b84167b9487b5` | native template counter testbench 成功 |
| `build/S11/native-template-counter-test/counter.vcd` | `afa4fd76cd1d6a903555ce3994b5f428b5ed92dacf46a92be38ccbad3cf62565` | native template counter VCD |
| `build/S11/nvc-wasm-template-counter-test.log` | `b3b35353869c7e05a98ff49737dcc3df23f9c8fe01229b9d352a90ba6f6e8768` | WASM template counter testbench、elaboration trap |
| `build/S11/nvc-native-counter-test.log` | `5d7bc7d0d63b6326eb487870f410b373748f539405d7bad25d86bb2aae49ba9e` | native numeric_std counter testbench 成功 |
| `build/S11/nvc-wasm-counter-test.log` | `b3b35353869c7e05a98ff49737dcc3df23f9c8fe01229b9d352a90ba6f6e8768` | WASM numeric_std counter testbench、elaboration trap |

## 最終判断

6 ファイル目（`src/object.h`）の変更を認めて続けるか、ここで打ち切るかをユーザーに尋ね、ユーザーは打ち切りを選びました。残り予算（2時間56分13秒）は使いません。S11 の結論は「NVC の WASM 化は採用しない」です。このため、ブラウザーでの VHDL のシミュレーションは提供しません。VHDL は GHDL による合成だけを扱い、シミュレーションは Icarus Verilog（Verilog）で行います。

## ログ

ログは `build/S11/` に保持しています。以下の hash は各ファイル全体の SHA-256 です。大きな build log はコミットしていません。

| Log | SHA-256 | 内容 |
|---|---|---|
| `build/S11/wasi-configure-probe.log` | `8d1c4d623c98605048a43d8ca1e7d3e91ed0dc8217891c766ff599e2dd87c890` | WASI ucontext / pthread failure |
| `build/S11/emscripten-configure-probe.log` | `c15f3bb45b4732fdda75329799150859cb0a6faead7350cd6b6bab2266cc8797` | Initial Emscripten configure; zstd missing |
| `build/S11/zstd-emscripten-build.log` | `a03462e50b7d2cd6e9d4f55873caaf1c11d694e54387b62a3ca823d7d6cbb2e3` | Pinned zstd Emscripten static build |
| `build/S11/emscripten-configure-zstd.log` | `6821a5197b0743d52c0cede1898f1ca9a407f783d8bae64fba6c00264c061a8d` | Emscripten `_Unwind_Backtrace` failure after zstd build |
| `build/S11/emscripten-configure-unwind.log` | `6821a5197b0743d52c0cede1898f1ca9a407f783d8bae64fba6c00264c061a8d` | Retry with `-lunwind`; same configure output |
| `build/S11/emscripten-configure-wasm-eh.log` | `ff273569bb556b007a098efa9138f5be7f4bdfc8f424b400452c9d4a04cd1133` | `-sWASM_EXCEPTIONS=1` rejected as an internal setting |
| `build/S11/emscripten-configure-native-eh.log` | `6821a5197b0743d52c0cede1898f1ca9a407f783d8bae64fba6c00264c061a8d` | Retry with legacy EH disabled; same configure output |
| `build/S11/emscripten-configure/config.log` | `1dce8fc66bb50bfc4d55f3b7c823a910dd74e26dcdace579eab9865ef314d8fb` | Full final Emscripten link probe and compiler command |
