# 書き込み部の初期調査記録

[調査索引に戻る](../../RESEARCH.md)

旧書き込みアプリの最終版 `dcbeb673f7bc6053901ce6816696406d0ecc1642` の調査記録です。以下の方針と未確認事項は当時の記録で、現在の対応状況は [README](../../README.md) を参照してください。

## 目的と前提

Sipeed Tang Nano 1K・4K・9K・20K に、GOWIN 製 FPGA のビットストリーム（`.fs`）を Web ブラウザーから書き込むアプリを作ります。対象の 4 ボードは、搭載している FPGA の品番に R が付いているものから選びました。

### 決定済みの方針

- Web 版だけを作ります。CLI は作りません。
- 書き込み処理は自分で移植せず、upstream の openFPGALoader を Emscripten で WASM にして使います。USB には libusb の WebUSB バックエンドを、FTDI の制御には libftdi を使います。
- 配信先は決めていません。CI の成果物と Release の zip（静的ファイル一式）で配ります。GitHub Pages には出しません。
- 実機は手元にないので、仮想の FT2232 と GOWIN TAP で動作を確かめます。実機では試していません。

## 対象ボード

| ボード | FPGA | openFPGALoader のボード名 | IDCODE | 書き込み先 |
|---|---|---|---|---|
| Tang Nano 1K | GW1NZ-1 | `tangnano1k` | `0x0100681B` | SRAM、内蔵フラッシュ |
| Tang Nano 4K | GW1NSR-4C | `tangnano4k` | `0x0100981B` | SRAM、内蔵フラッシュ |
| Tang Nano 9K | GW1NR-9C | `tangnano9k` | `0x0100481B`（`0x0100581B` の個体もある） | SRAM、内蔵フラッシュ |
| Tang Nano 20K | GW2AR-18C | `tangnano20k` | `0x0000081B` | SRAM、外付け SPI フラッシュ |

4 ボードとも、オンボードのデバッガーは FT2232 互換（VID `0x0403`、PID `0x6010`、インターフェース A、MPSSE による JTAG）として見えます。根拠は openFPGALoader v1.2.0 の `src/board.hpp`（`JTAG_BOARD("tangnano9k", "", "ft2232", ...)` など）と `src/part.hpp` です。

ビットストリームの IDCODE と実機の IDCODE の照合は、openFPGALoader の `src/gowin.cpp` が行います（`mismatch between target's idcode and bitstream idcode`）。画面でも事前に警告しますが、最終的な判定は openFPGALoader に任せます。

## 方式の比較

| 方式 | 内容 | 採否 |
|---|---|---|
| Rust で GOWIN の手順を移植（nusb で WebUSB） | 1 つのコアから CLI と Web を作る | 不採用。手順を自分で移植すると、実機で試せない分の不確かさが大きい |
| openFPGALoader を Emscripten でそのまま WASM 化 | upstream のコードを変えずに使う | 採用 |

openFPGALoader を WASM 化した既存の例です。

| 例 | 構成 | 備考 |
|---|---|---|
| [trabucayre/openFPGALoader_webUSB](https://github.com/trabucayre/openFPGALoader_webUSB) | openFPGALoader の作者による。emsdk 3.1.51、ASYNCIFY + pthread、ソースは無変更 | Apache-2.0。https://ofl.trabucayre.com で公開 |
| [YoWASP/openFPGALoader-web](https://github.com/YoWASP/openFPGALoader-web) | pthread を使用 | アーカイブ済み |
| [sylefeb/openFPGALoader-online](https://github.com/sylefeb/openFPGALoader-online) | pthread なし | libusb のフォークが必要（2025 年 3 月時点） |

## 依存関係

すべて `vendor/` に shallow submodule として置き、版の順（semver）で最新を確かめて固定しました（2026-10-25）。

| 依存 | 版 | commit | 取得元 |
|---|---|---|---|
| openFPGALoader | v1.2.0 | `befbab4f` | https://github.com/trabucayre/openFPGALoader |
| libusb | v1.0.30 | `87a55632` | https://github.com/libusb/libusb |
| libftdi | master | `92d657bc` | `git://developer.intra2net.com/libftdi` |
| zlib | v1.3.2 | `da607da7` | https://github.com/madler/zlib |
| emsdk | 6.0.13 | `35659964` | https://github.com/emscripten-core/emsdk |
| yomiyasu | main | `552c12c4` | https://github.com/nanaism/yomiyasu |

- 当初、タグを文字列の順で並べたため emsdk の最新を 6.0.9 と誤りました。`git ls-remote --tags --sort=-v:refname` で版の順に並べ直し、6.0.13 に直しました。
- libftdi の http の取得元（`http://developer.intra2net.com/git/libftdi`）は dumb http のため shallow clone ができません（`dumb http transport does not support shallow capabilities`）。smart protocol の `git://` を使います。git:// は暗号化されませんが、superproject が固定する commit の SHA で中身を確かめられます。

## CI の action と監査ツール

- `actions/setup-node` v7.1.0 は `mise.toml` と絶対パスの `node-version-file` に対応し、Node.js 版の検証と manifest 再取得の再試行を加えました。ESM への移行と `NODE_AUTH_TOKEN` の動作も変更しました。この workflow は Node.js major を明示し、cache、`node-version-file`、認証 token を使わないため、追加設定は不要です。action の runtime は Node.js 24 です。
- `actions/upload-artifact` v7.0.2 は HTTP 429 の再試行と `Retry-After` の処理を改善しました。成功時の Web 成果物と失敗時の Playwright 資料の保存に使います。
- `actions/cache` v6.1.0 (`55cc8345863c7cc4c66a329aec7e433d2d1c52a9`) は読み取り専用 token での cache 書き込み失敗を扱う修正を含みます。v6.0.0 からの差分と release note を確認しました。emsdk の展開物と Python 版ごとの fixture を別々の key で restore/save します。週次 schedule と `workflow_dispatch` の `cache=false` では両方を使いません。
- `actions/download-artifact` v8.0.2 (`9000827ccba6bdab643e8b6fd33ac0654aef8333`) は HTTP 429 の再試行と `Retry-After` の処理を改善し、`@actions/artifact` 6.3.1 を取り込みました。action manifest は Node.js 24 runtime で、digest 不一致時の既定動作は error です。3 つの simulator shard と E2E job は、同じ run の build artifact を取得します。
- emsdk と fixture だけを cache し、ライブラリーの build 結果は run 間で cache しません。C/C++ の成果物は submodule commit、emsdk、build option の組み合わせに依存し、広い cache key では古い出力を再利用する危険があるためです。ライブラリーは build job で一度だけ作り、sim と E2E には短期 artifact として渡します。Playwright browser は install が約 18 秒で、主な時間を占める OS 依存 package も cache されないため、browser cache は追加しません。
- build workflow は path filter で文書などの変更を除外し、1 つの build artifact を 3 つの simulator shard と Playwright に渡します。shard の割り当ては `ae0fc01` の per-test duration を使った LPT で均等化し、TAP report で shard の失敗と網羅性を別 job から検査します。詳細と事前登録した測定条件は [S3 の記録](../../docs/experiments/S3-ci-speed.md) にあります。
- E2E job は emsdk や vendor submodule を取得せずに artifact を使うため、`BUILD_INFO_CHECK=artifacts` で確認します。Build job では SDK と checkout を使う完全な `check` を実行済みです。E2E 側はそのメタデータ、superproject の gitlink、build script と WASM/JS の hash を照合します。
- actionlint v1.7.12 は `on.schedule.timezone`、deployment environment、`macos-26-intel` の検査に対応し、webhook event 一覧と popular-action データも更新しました。Go 1.26 対応と Windows arm64 の CI は upstream の開発環境の変更です。この workflow は timezone と deployment environment を指定せず、Ubuntu runner を使うため、新しい設定項目は不要です。
- zizmor 1.31.0 は pre-commit、self-hosted runner、危険な trigger、cache 設定、PowerShell の監査を改善し、`image_version` trigger に対応しました。また、誤検出の精度、submodule/worktree 内の設定探索、version comment の解析、pre-commit 入力、PowerShell の信頼済み publishing 検査を修正しました。この workflow 群は pre-commit、self-hosted runner、`image_version`、`issue_comment`、PowerShell、cache を使わず、標準の action version comment を使います。1.31.1 は `dangerous-triggers` の抑制コメントが適用されない回帰を修正しました。finding の抑制は設定しません。
- 追加した actionlint、setup-node、cache、download-artifact、upload-artifact、zizmor のライセンスは MIT です。これらの GitHub Actions は Dependabot の週次監視対象です。zizmor の 1.31.1 wheel に Python の追加依存はなく、`.github/zizmor-requirements.txt` は公開配布物の SHA-256 を固定します。

## Emscripten のビルドオプション

### 出典

- Emscripten 公式文書：Asyncify（JSPI を含む）、Optimizing Code、Pthreads、C++ exceptions、`src/settings.js`（6.0.13）、`ChangeLog.md`
- openFPGALoader の作者による `openFPGALoader_webUSB` の `build.sh`
- libusb v1.0.30 の `configure.ac`、`tests/Makefile.am`、`libusb/os/emscripten_webusb.cpp`
- OpenBlink（openblink-webide）の `Makefile`（mruby/c を `-O3 -flto` と ASYNCIFY でビルド）
- Chrome の JSPI 対応（Chrome 137 から既定で有効）

### 作者の構成（基準）

```sh
-s STRICT=1 -s ENVIRONMENT=worker -s ASYNCIFY=1 -s INVOKE_RUN=0 -s EXIT_RUNTIME=1
-s MALLOC=emmalloc -s INITIAL_MEMORY=33554432
-s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall
-s EXPORTED_FUNCTIONS=_main,_fflush -s MODULARIZE=1 -s EXPORT_NAME=instantiate
-s EXPORT_ES6=1 -s USE_ES6_IMPORT_META=1 -s WASM_BIGINT=1 -s TEXTDECODER=1
-s DISABLE_EXCEPTION_CATCHING=0
# コンパイル: -pthread -fexceptions、リンク: -lembind
```

### 6.0.x の変更で関係するもの（`ChangeLog.md` より）

- 6.0.8：`JSPI` が実験的な扱いでなくなった（#27559）。`WASM_BIGINT` は非推奨になり、既定で有効（#27558）。そのため `-s WASM_BIGINT=1` は外しました。
- 6.0.7：最も古い対応 Safari が 15.0 に上がり、bulk-memory などを前提にできるようになった（#27542）。
- 6.0.6：C++ のリンクには `em++` が必要になった（`DEFAULT_TO_CXX` が既定で無効、#11121）。
- 6.0.12：`emscripten_epoll_listener_add` が追加された（実験的）。libusb は使っていないので関係しません。
- `MODULARIZE` のファクトリー関数は常に Promise を返す。出力の拡張子が `.mjs` なら `EXPORT_ES6` は自動で有効になる（`settings.js`）。

### 検討したオプション

| 分類 | 候補 | 調べた内容 | 結論 |
|---|---|---|---|
| 非同期 | `ASYNCIFY=1` | 全体を書き換えるので、大きさと速度にかなりの負担がある（公式）。`-O2` 以上が必要 | 段階 1 で測定 |
| 非同期 | `JSPI=1` | WASM を書き換えない。Chrome・Edge 137 以降、Node 24 で使える。libusb の `val::await()` はどちらでも動く（`_emval_await__async: 'auto'`） | 段階 1 で測定 |
| 非同期 | `ASYNCIFY_IGNORE_INDIRECT`、`ASYNCIFY_ONLY`、`ASYNCIFY_REMOVE` | 計装の範囲を絞る。openFPGALoader は仮想関数が多く、誤ると壊れる | `ASYNCIFY_ADVISE` で調べ、安全と示せたときだけ |
| 非同期 | `ASYNCIFY_STACK_SIZE` | 既定 4096。OpenBlink は 65536 | ASYNCIFY を採るときに測定 |
| スレッド | `-pthread` | 作者の構成。COOP/COEP ヘッダーと SharedArrayBuffer が必要 | 段階 0・1 で比較 |
| スレッド | なし | upstream の libusb は共有メモリーと pthread の関数を必要とし、リンクまたは実行で失敗（段階 0） | 不採用 |
| スレッド | `PROXY_TO_PTHREAD` | main を別スレッドで動かす。libusb のテストが使う | Worker で動かすので必要性を測定 |
| 最適化 | `-O2`、`-O3`、`-Os`、`-Oz` | 速度と大きさの兼ね合い | 段階 1 で測定 |
| 最適化 | `-flto` | 依存を含む全体か、本体だけか。OpenBlink は全体 | 段階 1 で測定 |
| 例外 | `-fexceptions`（JS 方式） | 作者の構成。JSPI とは組み合わせられない（段階 0） | ASYNCIFY でだけ使う |
| 例外 | `-fwasm-exceptions` | wasm ネイティブの例外。6.0.13 の既定は旧方式（`WASM_LEGACY_EXCEPTIONS=1`）。`=0` で標準方式 | JSPI では必須。旧方式と標準方式を段階 1 で比較 |
| メモリー | `INITIAL_MEMORY` 固定、`ALLOW_MEMORY_GROWTH`、`MAXIMUM_MEMORY` | `.fs` は最大で数 MB | 段階 1 で測定 |
| メモリー | `MALLOC=emmalloc`、`dlmalloc`、`mimalloc` | 作者は emmalloc。mimalloc はスレッド向け | 段階 1 で測定 |
| JS | `--closure 1` | JS の縮小。`pre-js` との相性を確かめる | 段階 1 で測定 |
| JS | `ENVIRONMENT=worker,node` | Worker で動かし、Node でテストする。OpenBlink の PR #68 でも、Worker で動かすために `worker` を足した | 採用 |
| 起動 | `EVAL_CTORS` | 静的コンストラクターの事前評価。`=2` は main の引数を無視する前提なので使わない | `=1` を測定 |
| そのほか | `TEXTDECODER=2`、`DYNAMIC_EXECUTION=0`、`INCOMING_MODULE_JS_API`、`FILESYSTEM`（MEMFS が必要）、SIMD | — | 段階 1 で確認 |

### 段階 0 で分かったこと

- libusb v1.0.30 の `configure` は、`-pthread` が使えれば必ず `THREAD_CFLAGS=-pthread` を付けます。pthread なしで作るときは、`make` のときに `THREAD_CFLAGS=` で上書きします。
- 上書きすると、6.0.13 では `events_posix.c` のコンパイルが `'__builtin_wasm_memory_atomic_notify' needs target feature atomics` で止まります。`-pthread` を付けずに `-matomics` を付けて回避しました。
- JSPI と JS 方式の C++ 例外（`-fexceptions` と `DISABLE_EXCEPTION_CATCHING=0`）を組み合わせると、起動時に `SuspendError: trying to suspend without WebAssembly.promising` で止まりました。JS 方式の例外は、JS の中継関数 `invoke_*` を使います。6.0.13 の `tools/link.py` は、`ASYNCIFY_IGNORE_INDIRECT` が無効のとき `invoke_*` を非同期の import に加えるため、中継関数がすべて `WebAssembly.Suspending` で包まれます。そのため、`__wasm_call_ctors` から呼ばれる静的コンストラクターで失敗します。JSPI 版では `-fwasm-exceptions` を使います。
- JSPI 版（pthread なし、JS 方式の例外）のリンクは 1 分 29 秒、最大 RSS は 266 MB でした。WASM は 2,999,631 バイトです。
- `-fwasm-exceptions` に切り替えると `SuspendError` はなくなり、リンクは 48 秒、最大 RSS は 210 MB になりました。その先の USB 検出で `Atomics.waitAsync` が `not a shared typed array` で失敗しました。libusb v1.0.30 の `libusb/os/events_posix.c`（43〜53 行）は、メインスレッドで動くとき WASM のメモリーを `Atomics.waitAsync` で待つため、共有メモリーが必要です。ブラウザーで共有メモリーを使うには COOP/COEP ヘッダーが要るので、libusb にパッチを当てない限り、pthread を使わなくてもヘッダーは必要です。比較の軸は「共有メモリーのみ（`-sSHARED_MEMORY`）」と「pthread」に改めました。
- 共有メモリーだけを有効にして pthread を使わない構成（`-sSHARED_MEMORY=1`）は、libusb の `core.o` が pthread の関数（`pthread_mutex_lock` など）を参照するため、リンクできませんでした。Emscripten のスタブを足すと、`emscripten_futex_wake` が二重に定義されました。libc に手を入れる必要があるので、この構成は候補から外し、pthread を使う構成だけを比べます。
- JSPI・pthread・`-fwasm-exceptions` の構成はビルドでき、仮想 USB の検出テスト（4 ボード × `-b` の有無 × 5 回、デバイスなし 1 回）にすべて通りました。全体のビルドは 1 分 30 秒、最大 RSS は 243 MB です。WASM は 2,281,255 バイト（gzip で 635,229 バイト）、`.mjs` は 99,393 バイトです。検出 1 回の時間は、読み込みを含めて 84〜125 ms でした。
- ASYNCIFY の最後の最適化（wasm-opt）は、メモリー 7 GB・2 コアの VM で終わりませんでした（SIGKILL、または 1 時間 40 分以上かかって中断）。pthread 版では最大 RSS が 7.4 GB に達してから SIGKILL で止まりました。GitHub の runner（16 GB）で測り直します。詳細は [段階 0 の記録](../../docs/experiments/S0-wasm-build.md) にあります。

### 段階 1a で分かったこと（書き込みの模擬）

yowasp と apicula で作った 4 ボード用の `.fs` を、仮想 USB の SRAM とフラッシュに書き込みました。仮想デバイスが受け取ったデータは、各 5 回とも `.fs` の中身と一致しました。apicula は、`yowasp-nextpnr-himbaechel-gowin` が指定する 0.32 を使います。0.35 と組み合わせると、20K の配置配線が `Speed grade 'ES' not found` で止まりました。

故障を入れたときの openFPGALoader v1.2.0 の振る舞いは次のとおりです。

| 故障 | 振る舞い |
|---|---|
| 9K 用の `.fs` を 1K に書く | IDCODE の不一致で拒否し、0 以外で終わる |
| SRAM の書き込み後に DONE が立たない | `FAIL` を表示するが、0 で終わる |
| 書き込み中に USB が抜ける（`NotFoundError`） | `FAIL` を表示するが、0 で終わる |
| 内蔵フラッシュの消去が終わらない | 100回再試行して `FAIL` を表示するが、0 で終わる。画面は失敗として表示する |
| 外付けフラッシュ（20K）の読み戻しの不一致 | `--verify` で検出し、0 以外で終わる |
| 外付けフラッシュの消去が終わらない | 240 秒待っても終わらない |

終了コードだけでは成否を判定できません。画面では、ログの `FAIL` も失敗として扱い、外付けフラッシュには `--verify` を付け、全体に時間の上限を設けます。内蔵フラッシュの busy は、Fake USB の MPSSE parser を修正する前は誤解析に隠れていました。2026年10月の修正後は、upstream が100回再試行して `FAIL` を表示し、終了コード0で終わることを確認しました。画面は `FAIL` を検出して失敗と表示します。

GW1N の `Gowin::skip_checksum` は、`gowin.cpp` のコンストラクターで初期化されず、`detectFamily()` の GW1N 分岐でも値が設定されません。`writeFLASH()` の333〜336行では `!skip_checksum && data` のとき CRC を確認します。この未初期化値により、内部フラッシュ書き込み後の CRC 確認は、残っているヒープ内容によって実行されたり省略されたりします。ローカルでは確認が省略され、CI では実行されました。実機の Tang Nano では試していません。vendor code は変更せず、upstream への Issue は起票しません。詳細は [段階 1a の記録](../../docs/experiments/S1a-program-sim.md) と [段階 2 の記録](../../docs/experiments/S2-ci-sim-environment.md) にあります。

2026-10-26: 利用者は upstream への Issue を起票しないと決めました。テストは CRC 行の出力を必須にせず、画面はログ中の `FAIL` を失敗として扱います。

### 段階 1b で分かったこと（最適化オプションの比較）

JSPI/pthread の基準 B（`-Os`、LTO なし、legacy の wasm 例外、固定 32 MiB、emmalloc）から、条件を 1 つずつ変えた 17 候補を比べました。どの候補も、仮想 USB の全テストを 5 回続けて通ることを条件にし、書き込み 8 ケースの所要時間を各 7 回測りました。

- 採用の条件は、B より 3% を超えて速く、かつ 8 ケースのうち 5 ケース以上で最小〜最大の範囲が重ならないことです。この条件を満たした候補はありませんでした。採用した構成 C は B と同じです。
- 最も速かったのは全体 LTO（LTOA）で、B より 1.06% 速い程度でした。`-Oz` と `ALLOW_MEMORY_GROWTH` は、それぞれ約 6.9% と約 6.4% 遅くなりました。
- 作れなかった候補、または検査に通らなかった候補は次の 3 つです。
  - `EVAL_CTORS`：`EVAL_CTORS is not compatible with ASYNCIFY` でリンクできませんでした。JSPI も内部で ASYNCIFY の設定を使います。
  - mimalloc：`Aborted(OOM)` で止まりました。
  - `PROXY_TO_PTHREAD`：デバイスがないときに、終了コードが 0 になりました。
- openFPGALoader の CMake は、既定の `ENABLE_OPTIM=ON` で `-O3` を足します。最適化の指定を 1 つにするため、`OFF` にしました。
- 測ったのは Node の仮想 USB での時間です。仮想デバイスの処理が大半を占めるので、オプションの差は小さく出ています。実機での速度は測っていません。

詳細と生の値は [段階 1b の記録](../../docs/experiments/S1b-option-matrix.md) にあります。

## 選び方

1. 安定性で絞る：仮想デバイスのテスト（4 ボード × SRAM／フラッシュ、故障の注入）にすべて通り、5 回以上繰り返しても結果が変わらない組み合わせだけを残す。
2. 残った組み合わせから、書き込みにかかる時間（実時間と CPU 時間）が最も短いものを選ぶ。大きさと起動時間は参考にする。

## ライセンス

| 部品 | ライセンス | 配布で必要なこと |
|---|---|---|
| openFPGALoader | Apache-2.0 | [上流LICENSE](https://github.com/trabucayre/openFPGALoader/blob/befbab4f646207dbaf1daf8b144dd980ad283dd5/LICENSE)、[NOTICE](../../NOTICE)、[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) を同梱 |
| libusb | LGPL-2.1-or-later | 静的リンク。ソースと再リンク方法を [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) に記載 |
| libftdi | LGPL-2.1（ライブラリ部分） | 同上 |
| zlib | zlib | [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) に記載 |
| Emscripten のランタイムと libc | MIT / University of Illinois/NCSA。LLVM 部品は Apache-2.0 with LLVM Exceptions | ライセンス本文と固定版は [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) に記載 |

## 未確認事項

- 実機（4 ボード）での書き込み。
- JSPI 版の、Chrome・Edge の実機の WebUSB での動作。

## 高度な設定と Gowin の動作

以下は `vendor/openFPGALoader` v1.2.0 の Gowin 実装を確認した結果です。既定値は Tang Nano 各ボードを `-b` で指定した場合の値です。

| オプション | 既定値 | 適用対象 | 効果と注意点 | upstream の根拠 | UI |
|---|---|---|---|---|---|
| `-m/--write-sram`、`-f/--write-flash` | SRAM | 書き込み | SRAM は揮発性。フラッシュ書き込みは永続データを消去してから書き込む。1K/4K/9K は内蔵フラッシュ、20K は外付けフラッシュを使う。 | `main.cpp:1005-1022,1135-1148`、`gowin.cpp:196-217,273-320` | 公開。操作と書き込み先で選択 |
| `--external-flash` | 無効 | 4K/9K の外付けフラッシュ書き込みと読み出し | 外付け SPI フラッシュを選択する。20K は Gowin 側が外付けを自動選択するため不要。 | `main.cpp:991-993,1141-1148`、`gowin.cpp:196-217,342-351,1176-1192` | 公開。20K では追加しない |
| `--verify` | 無効 | 外付けフラッシュ書き込み | SPI フラッシュへの書き込み後に読み戻して比較する。SRAM と内蔵フラッシュでは検証されない。 | `main.cpp:1050-1051`、`gowin.cpp:304-305,342-370`、`spiFlash.cpp:559-597` | 公開。外付け書き込みでは既定で有効 |
| `-o/--offset` | 0 バイト | 外付け書き込み、読み出し | 外付けフラッシュの開始位置をバイトで指定する。0 は既定値のため省略する。 | `main.cpp:1021-1022,682-687`、`gowin.cpp:342-367,1176-1192` | 公開。容量と読み書き範囲を検証 |
| `--unprotect-flash` | 無効 | 外付けフラッシュ書き込み | 書き込み前に SPI フラッシュの保護ビットを解除する。保護状態を変えるため、必要な場合だけ使う。 | `main.cpp:1041-1042`、`gowin.cpp:342-351`、`spiFlash.cpp:827-848` | 公開。消去操作では無効 |
| `--bulk-erase` | 無効 | 20K の外付け SPI フラッシュ | チップ全体を消去する。対象の Gowin 実装では GW2A のみ対応。bulk erase 側は `SPIFlash` に unprotect を渡さないため、`--unprotect-flash` と組み合わせても保護を解除できない。 | `main.cpp:980-982,649-652`、`gowin.hpp:44-47`、`flashInterface.cpp:149-177` | 公開。実行前にボード名と全消去を確認 |
| `--dump-flash --file-size N` | 無効、サイズ 0 | 外付け SPI フラッシュの読み出し | `N` バイトを読み出す。4K/9K では `--external-flash` も指定する。出力先は positional file 引数。`--offset` は読み出し開始位置。読み出し後にビットストリームを再ロードする。 | `main.cpp:980,991-996,682-687`、`gowin.cpp:1176-1192` | 公開。全体または指定バイト数を選択し、長さを確認して保存 |
| `--freq <Hz>` | 6 MHz | SRAM、フラッシュ | JTAG の初期周波数を設定する。Gowin はフラッシュ処理中に 2.5 MHz または 10 MHz へ切り替える。 | `main.cpp:73,231-250,1004`、`gowin.cpp:282,1248` | 公開。周波数切替の説明を表示 |
| `-r/--reset` | 無効 | 全操作 | 指定すると `main.cpp` は処理後に `fpga->reset()` を呼ぶ。Gowin の `reset()` は RELOAD/NOOP を送り、外付けフラッシュの読み出し・一括消去では `post_flash_access()` も `reset()` を呼ぶ。 | `main.cpp:690-691,1031-1032`、`gowin.cpp:267-271,1176-1192,1220-1271`、`flashInterface.cpp:149-177` | 公開。書き込み時のみ選択可能。読み出し・消去は処理内で reset を実行するため、追加の reset を選べない。SRAM 書き込み後の影響を警告 |
| `-v/--verbose`、`--verbose-level` | 通常ログ、level 0 | 全操作 | `-v` は詳細ログ、`--verbose-level 2` は debug。プログラム動作自体は変えない。 | `main.cpp:1029-1048` | 公開。既定、詳細、debug を選択 |
| `--mcufw <file>` | 未指定 | 4K、フラッシュ書き込み、内蔵フラッシュ | GW1NSR-4C で MCU ファームウェアを消去領域の `0x380` ページから書き込む。書き込み位置は `writeFLASH()` のページ番号で、実アドレスはページ単位に展開される。 | `gowin.cpp:141-153,290-313,647-658`、`main.cpp:1058-1059` | 公開。4K の内蔵フラッシュ書き込み時のみ有効 |
| `--user-flash <file>` | 未指定 | 9K、フラッシュ書き込み、内蔵フラッシュ | GW1N(R)-9 のユーザーデータを `0x6D0` ページから書き込む。upstream は書き込み時にビット反転を行う。 | `gowin.cpp:155-167,297-320,647-680`、`main.cpp:1068-1069` | 公開。9K の内蔵フラッシュ書き込み時のみ有効 |
| `--protect-flash <len>` | 0（無効） | 対象ボードでは非対応 | Gowin の該当実装は保護要求をエラーにする。 | `main.cpp:1027-1028,654-656`、`gowin.hpp:37-39` | 表示のみ。未対応の理由を示して無効化 |

外付けフラッシュへのアクセスでは、Tang Nano 4K/9K の GW1N と Tang Nano 20K の GW2A のどちらも `prepare_flash_access()` が先に SRAM を消去します。GW1N は続けて設定モードへ入り、GW2A はその切り替えを行いません。読み出しと一括消去は `prepare_flash_access()` と `post_flash_access()` を通ります。後者は両系列で `reset()` を呼び、`reset()` が RELOAD/NOOP を送ります。したがって、操作中は SRAM 上のデザインが停止し、処理後にフラッシュから再ロードされます。根拠は `gowin.cpp:267-271,1176-1192,1220-1271`、`gowin.hpp:44-47`、`flashInterface.cpp:149-177` です。

Tang Nano のフラッシュ容量は次のとおりです。1K は外付けフラッシュを搭載せず、パッドのみです。4K と 9K は 32 Mbit（4 MiB）、20K は 64 Mbit（8 MiB）の SPI フラッシュを搭載し、20K に内蔵フラッシュはありません。

- Sipeed Wiki の比較表（1K/4K/9K/20K）：https://wiki.sipeed.com/hardware/en/tang/Tang-Nano-9K/Nano-9K.html
- Sipeed Wiki の Tang Nano 20K ページ：https://wiki.sipeed.com/hardware/en/tang/Tang-Nano-20K/Nano-20K.html

### Fake の GW1N 外付け SPI 経路

GW1N の `prepare_flash_access()` は SRAM を消去し、IR `0x15` で設定モードに入り、IR `0x3D` に切り替えて SPI アクセスを準備します。以降の8ビット `shiftDR` が BSCAN のピン状態を設定し、6クロックを経て更新されます。`spi_put()` は CS を下げ、MOSI を MSB から送り、SCLK の立ち上がりごとに TDO の DO ビットを読み、最後に CS を上げる関数です。Fake はこの手順をデコードして、20K と共通の NOR コマンドモデルへ渡します。根拠は `gowin.cpp:233-237,455-459,983-986,1053-1083,1220-1250` と、信号マスク `gowin.cpp:63-75,187-194` です。

Tang Nano 4K は `gowin.cpp:187-194` の専用マスク、9K は標準マスク `gowin.cpp:63-69` を使います。Sipeed Wiki は容量を示しますが、フラッシュ部品の品番は記載していません。そのため Fake は実部品を断定せず、4 MiB NOR に汎用 JEDEC ID `0xEF4016`、8 MiB NOR に `0xEF4017` を返します。

FT2232 のケーブル、チャンネル、VID/PID、JTAG chain index はボード定義と既定の接続に任せます。これらは接続先を誤る設定であり、今回の操作固有の設定には含めません。`--skip-reset` と `--skip-load-bridge` は Gowin のコンストラクターへ渡されず、`--spi` は Gowin の JTAG/SPI bridge を通らない別経路のため公開しません。

### Fake での外付けフラッシュ測定

以下は実 fixture を使った Fake USB 上の時間であり、実機の測定値ではありません。全長の書き込みと検証は省略していません。

- 9K の外付け書き込みと `--verify` を単独で実行した場合、テスト時間は約 119.4 秒、wall time は約 119.5 秒でした。
- BSCAN の破損 readback negative control は約 51.5 秒、4K の外付け書き込みと `--verify` は約 65.1 秒でした。
- `program.test.mjs` 全体は、BSCAN 破損ビットの修正後に 27 件すべて成功し、wall time は 418.22 秒でした。内訳の測定値は、9K 検証 122.50 秒、4K 検証 65.10 秒、破損 readback 51.55 秒です。
- `node --test --test-concurrency=1 tests/sim/*.test.mjs` は 40 件すべて成功し、wall time は 428.69 秒でした。

これらはシミュレーションの負荷や Fake の実装に依存する時間です。基板上の書き込み速度や完了時間の予測には使えません。
