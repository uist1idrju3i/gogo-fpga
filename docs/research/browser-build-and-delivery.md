# ブラウザー内ビルドと静的配信の調査

[調査の入口](../../RESEARCH.md)から、ブラウザー内ビルドと配信に関する記録を分けました。測定値と当時の判断は変更していません。

## S4: ブラウザー内の Verilog から .fs 生成

`@yowasp/runtime` 11.0.72 は jco 変換済み module の WASI Preview 2 component import を実装し、README で内部用途と説明されています。Yosys と nextpnr は Preview 1 import を使うため、本リポジトリーでは Preview 1 shim を実装し、未対応 import は `LinkError` で拒否します。

shim が公開する import は `args_get`、`args_sizes_get`、`clock_time_get`、`environ_get`、`environ_sizes_get`、`fd_close`、`fd_fdstat_get`、`fd_fdstat_set_flags`、`fd_filestat_get`、`fd_filestat_set_size`、`fd_pread`、`fd_prestat_dir_name`、`fd_prestat_get`、`fd_read`、`fd_readdir`、`fd_renumber`、`fd_seek`、`fd_write`、`path_create_directory`、`path_filestat_get`、`path_open`、`path_readlink`、`path_remove_directory`、`path_rename`、`path_unlink_file`、`proc_exit`、`random_get` の27個です。仮想ファイルは growable `Uint8Array` とし、Yosys と nextpnr は共有 workspace と `/tmp` を preopen します。Yosys share は deterministic USTAR を読み込みます。

ブラウザーでは module Worker が manifest の size と SHA-256 を検証してから、VHDL、Yosys、nextpnr を順に実行し、選択した family の chipdb だけを配置します。VHDL source は case-insensitive な依存関係順に並べ、GHDL の出力を `build/vhdl/` に置いて Verilog と一緒に Yosys へ渡します。VHDL entity を top にした合成と、Verilog top が VHDL entity を使う混在合成を扱います。VHDL top が Verilog blackbox を使うときは、元の Verilog を読み込んだ後、生成した VHDL Verilog を `read_verilog -nooverwrite` で追加し、重複する blackbox 宣言を無視します。VHDL source がある project だけで GHDL assets を取得します。VHDL-2008 が既定で、2008 と 2019 を選べ、標準は project と ZIP に保存します。GHDL host は呼び出しごとに新しい WASM instance と WASI memory tree を使います。`.fs` を project に保存し、成功後に書き込み対象として選びます。

T3-2 の Playwright は 37/37 成功しました。4 board の VHDL template から作った `.fs` は、native GHDL、native Yosys、native nextpnr、native `gowin_pack` の期待値と byte-identical です。混在の両方向、VHDL-2019、`keep` の正例と負例、構文・意味エラー、file ordering error、GHDL asset の欠落・破損・破損 cache の検出も確認しました。GHDL WASM は 2,001,408 bytes（SHA-256 `5c8df2a9102f9bdd577df7e250739876cc29642f8dd7fa0c9844799b0a817c80`）、deterministic `libraries.tar` は 3,901,440 bytes（SHA-256 `5f08af4dd4ecb42959faf2286b1dba0055ae0b6642c906e60e3688b7ecd04e07`）です。詳細な parity hash、asset manifest、診断結果は [S0 GHDL build-and-smoke 記録](../../docs/experiments/S0-ghdl-wasm.md) を参照してください。画面 capture は `build/T3-2/screenshots/` にあります。実機での合成・書き込みは本リポジトリでは試していない。

Playwright の preflight は `build/synth` と `dist/synth` の相対 file set と各 file の byte 列を比較します。E2E の期待値は Node WASI Yosys、Node WASI nextpnr、native `gowin_pack` で生成し、ブラウザー成果物と比較します。測定値は Chromium と VM の値として記録し、実機の性能値とは扱いません。

全4ボードで5回ずつ、Chromium内の出力が期待する`.fs`とbyte-identicalであること、IDCODE、fake USBによるSRAM書込みを確認しました。20回分の段階別時間と各toolの`memoryBytes`、出力sizeは [S4A実験記録](../../docs/experiments/S4A-browser-build.md) とCSVに記録しています。中央値はVM/Chromium上で合成1,533–1,563 ms、配置配線468–1,079 ms、ビットストリーム318–1,423 msです。各boardの最初のビットストリーム計測はPyodide初期化を含みます。これらの測定値をTang Nano実機の性能として扱いません。

| Family | Native / WASI chipdb bytes |
|---|---:|
| GW1N-9C | 12,846,661 |
| GW1NS-4 | 10,193,030 |
| GW1NZ-1 | 5,922,288 |
| GW2A-18C | 17,493,847 |

固定 seed を使った P&R JSON の比較は4ボードすべて成功しました。以下の時間は native / WASI の順です。ピーク RSS は各ボードのテスト時に計測したプロセスの最大値です。

| Board | P&R time (ms) | Peak RSS (KiB) |
|---|---:|---:|
| Tang Nano 1K | 161.0 / 433.6 | 410,628 |
| Tang Nano 4K | 189.6 / 299.3 | 427,336 |
| Tang Nano 9K | 244.2 / 405.9 | 429,188 |
| Tang Nano 20K | 441.5 / 813.2 | 453,740 |

存在しない pin の負例は native と WASI の両方で有用なエラーと非ゼロ終了を返し、chipdb を欠落させた WASI 実行も非ゼロで終了しました。

Yosys v0.69 から v0.70 では `alumacc -macc-only`、`optbarriers`、`flatten` と `prep` の `-barriers`、`mcm`、`rmports -purge`、`ltp -select`、色付きログが追加され、`read_xaiger2` が削除されました。`vendor/yosys/CHANGELOG` の該当節を確認しました。今回の `read_verilog` と `synth_gowin` を使う経路ではどの変更も必要ないため、追加のオプションやパスは採用しません。WASI SDK 34 の release notes では CMake toolchain の調整、wasi-libc の更新、WASI Preview 3 対応の作業が挙げられています。Preview 1 の同期実行を使う本段階では追加の対応を行いません。

### 固定版Yosysのビルド情報の比較

固定したYosys v0.70のCI成果物では、同じcommitでもcreatorに `0.70+` が入り、タグ付きの手元ビルドの `0.70` と異なりました。上流の[YosysVersion.cmake](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/cmake/YosysVersion.cmake)はGitのタグからの距離とcheckout情報を組み立て、Gitなしのソースでは `.gitcommit` を参照します。版の接尾辞だけで、異なる回路やcommitとは判定しません。

共通の比較器はpin checkerが読む版とgitlinkの一致を必須にし、接尾辞は空、`+`、`+post` に限定します。revisionは固定commitの9桁表記または全40桁と、直後の区切りまで照合します。別の版・commit、余分なcommit文字、`-dirty`、`+1` は負の対照で拒否します。creatorとshareのsource属性以外は正規化せず、回路、値、JSONのキー順の差を失敗とします。メタデータの模擬入力に加え、製品用のnative/WASIで4ボードの合成結果と構文エラーを比較しました。GitなしのソースからのYosys再ビルドを、この比較だけで確認済みとはしません。

## 圧縮した WASM 資材の復号

`zstd` v1.5.7 の `CHANGELOG` では圧縮 API の追加、圧縮速度の改善、32-bit 圧縮処理の修正などを確認しました。今回使うのは standalone decoder の `ZSTD_decompress` だけで、複数 frame を連結した入力も扱えます。生成 C はビルド時に `combine.py` で作り、BSD-3-Clause の条件を選びます。

`xz-embedded` v20240322 では、v20240124 以降の decoder、CRC、build 設定の変更と、0BSD への切り替えを確認しました。採用する `linux/lib/xz/` の CRC32、CRC64、stream、LZMA2 decoder は 0BSD です。CRC64 を有効にし、`XZ_SINGLE` で一つの stream を復号します。BCJ decoder は使いません。変更履歴は [v20240124 から v20240322 の比較](https://github.com/tukaani-project/xz-embedded/compare/v20240124...v20240322)を参照してください。

`gzip` は `DecompressionStream` で処理し、`zstd` と `xz` は WASI reactor の decoder を使います。decoder は `dist/lib/decoders/` に配置しますが、この段階では既存の資材取得経路を変更しません。

## 配信の大きさと配信先

開発初期には初回に読み込む資材を約 104〜115 MB（圧縮前）と見積もりました。この値は当時の未計測の概算として残し、2026-10-28 に Playwright の冷たい browser context で初回ビルド・書き込み時の成功 GET 応答本文を実測しています。配信先の候補の制限については、2026-10-27 に公式資料で確認しました。

| 配信先 | 1 ファイルの上限 | ヘッダーの設定 | 根拠 |
|---|---|---|---|
| Cloudflare Pages | 25 MiB（Free は 20,000 ファイル） | `_headers` で可 | [Limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Cloudflare Workers Static Assets | 25 MiB | Worker で可 | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cloudflare R2 | 5 TiB（`r2.dev` は試験用で、本番はカスタムドメイン） | Transform Rules など | [Limits](https://developers.cloudflare.com/r2/platform/limits/) |
| GitHub Pages | 資料に記載なし。サイト全体は 1 GB、帯域は月 100 GB（目安） | 不可 | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| Vercel | 静的ファイルのアップロード合計が Hobby 100 MB、Pro 1 GB | `vercel.json` で可 | [Limits](https://vercel.com/docs/limits) |
| Firebase Hosting | 2 GB | `firebase.json` で可 | [FAQ](https://firebase.google.com/docs/hosting/faq-and-troubleshooting) |
| Netlify | 公式資料に記載なし（サポートの回答では 10 MB 以下を推奨） | `_headers` で可 | 未確認 |

`yosys.wasm`（52,926,660 bytes）と `nextpnr-himbaechel-gowin.wasm`（34,172,028 bytes）は、圧縮しないと Cloudflare Pages の 25 MiB を超えます。Cloudflare の自動圧縮は gzip、Brotli、zstd を返せ、`application/wasm` も対象です（[Compression](https://developers.cloudflare.com/speed/optimization/content/compression/)）。ただし対象は決まった Content-Type だけで、chipdb の `.bin` と tar は入りません。zstd は Compression Rules で有効にする必要があります。2026-10-27 に応答ヘッダーを確かめたところ、Cloudflare で配信している fpga.moe は zstd を優先して要求しても br を返し、GitHub Pages で配信している muromi.moe は gzip だけを返しました。GitHub Pages はヘッダーを設定できないため、書き込み部に必要な COOP/COEP は Service Worker で付けることになります。

配信先の自動圧縮に任せず、圧縮した資材を配ってブラウザーで展開する方式を [S4B](../../docs/experiments/S4B-compressed-assets.md) で比べました。gzip と互換の高圧縮では、libdeflate の最高レベルでも gzip -9 より約 5% 小さいだけでした。Zopfli も同じくらいの大きさで、圧縮に時間がかかります。zstd -19 は 20K の大きい 5 つの資材を 28.5 MB（gzip -9）から 19.2 MB に縮めます。Chromium 156 での展開は合計 359 ms で、gzip の `DecompressionStream`（673 ms）より速くなりました。xz -9e は zstd より 10% 小さいものの、展開に 2.2 秒かかります。50 Mbps での推定時間は gzip 5.23 秒、xz 4.98 秒、zstd 3.43 秒で、事前に決めた基準により zstd を採ります。Brotli は Chromium 156 の `DecompressionStream` で展開できないため、配信時の `Content-Encoding` にしか使えません。S4B の時点では配信先は未定でしたが、後続の S4C では Cloudflare Pages を目標にします。

S6 では zstd・xz 展開器の最適化を比較しました。OsLTO が最速でしたが、B より 3.224% の短縮にとどまり、凍結した 5% 基準を満たす候補はありませんでした。そのため B を維持し、既定 build は変更していません。LTO の zstd・xz WASM は `wasi_snapshot_preview1.random_get` を import するため、将来 LTO を既定にする場合は本番展開器にも対応が必要です。詳細は [S6 実験記録](../../docs/experiments/S6-decoder-build-options.md) を参照してください。

この実装では `manifest.json` を除く `dist/synth/` の資材を zstd 形式で配信する構成にしました。manifest の各項目には展開後の `size` と `sha256` に加えて `encoding: "zstd"`、`compressed_size`、`compressed_sha256` を記録します。ビルド Worker は圧縮前後のサイズと SHA-256 を検証し、展開後のデータを Cache Storage `gogo-fpga-synth-v1` に `new URL(path + "?sha256=" + sha256, synthURL)` のキーで保存します。実際のビルドで得た圧縮サイズの合計は、共有する 3 資材と各ボードの chipdb を合わせて Tang Nano 1K が 16,003,246 bytes、4K が 16,155,020 bytes、9K が 16,164,593 bytes、20K が 16,256,883 bytes です。最大の圧縮ファイルは `yosys.wasm.zst` の 9,448,361 bytes でした。

冷たい browser context で初回のビルドと fake USB 書き込みを行う Playwright 計測では、同一 origin の成功 GET 応答本文を集計しました。各ボードで 43 個の異なる要求パスがあり、合計は Tang Nano 1K が 33,408,160 bytes、4K が 33,559,934 bytes、9K が 33,569,507 bytes、20K が 33,661,797 bytes でした。内訳は次のとおりです。

| ボード | 要求パス数 | synth (bytes) | pack (bytes) | その他 (bytes) | 合計 (bytes) |
|---|---:|---:|---:|---:|---:|
| Tang Nano 1K | 43 | 16,016,710 | 14,219,198 | 3,172,252 | 33,408,160 |
| Tang Nano 4K | 43 | 16,168,484 | 14,219,198 | 3,172,252 | 33,559,934 |
| Tang Nano 9K | 43 | 16,178,057 | 14,219,198 | 3,172,252 | 33,569,507 |
| Tang Nano 20K | 43 | 16,270,347 | 14,219,198 | 3,172,252 | 33,661,797 |

合計にはページ、ビルド Worker、書き込み用資材とライブラリーも含みます。分類別の内訳は synth が manifest と zstd 資材、pack が manifest・圧縮資材・raw 資材、その他が画面と書き込み資材です。pack の配信では Pyodide の WASM と lock JSON を zstd にし、その他は raw のままにします。pack も shared verified loader で検証し、展開後の資材を Cache Storage `gogo-fpga-pack-v1` に SHA-256 を含むキーで保存します。実機では未確認で、配信先の目標は Cloudflare Pages です。ユーザーによる実機確認後に公開します。計測の詳細と集計値は [S4C](../../docs/experiments/S4C-cold-load-bytes.md) に記録しました。デプロイは行っていません。

NVC r1.23.1 の確認元は[configure.ac](https://github.com/nickg/nvc/blob/fab54a9e96964b431050d837e163c22282a1df6c/configure.ac)です。S11 は WASI SDK 34.0 の configure で pthread が検出されず、Emscripten 6.0.13 の初回 configure では `_Unwind_Backtrace` の link probe が失敗しました。backtrace patch で configure を通し、最初の cutoff 判断は誤適用としてユーザーの指摘後に再開しました。`jit-code.c` には小さな `__EMSCRIPTEN__` compile guard を置き、LLVM と native plugin の登録がない構成では `jit_interp` が default entry になることを NVC r1.23.1 の `src/nvc.c:846-854`、`src/jit/jit-core.c:142-167,258-267,736-745`、`src/jit/jit-interp.c:1129-1142` で確認しました。Emscripten NVC は link し、native NVC で standard libraries も生成しました。最初に報告した `RuntimeError: null function or function signature mismatch` の原因は、`src/object.h:171` の `object_copy_fn_t` が `bool` を返す一方、`src/tree.h:638-639` の tree/type callback は `void` を返し、`src/tree.c:1405-1406` が異なる戻り値型を cast して `src/object.c:1201-1205` で間接呼び出すことだと確認しました。debug stack は counter testbench の elaboration から `object_copy_finish`、`tree_copy_finish`、`vhdl_architecture_instance` への実行を示し、Wasm disassembly では同関数内の indirect call は1箇所でした。`-sEMULATE_FUNCTION_POINTER_CASTS=1` で analysis/elaboration は通るものの、simulation は `missing body for (null)` で停止し、function-pointer-cast workaround だけでは criteria 3 を満たしません。`jit-core.c` の `jit_missing_unit` に到達したことは確認しましたが、null unit name の発生原因は未確定です。正しい signature 修正には exempt でない `src/object.h` を6ファイル目として変更する必要があるため、5-file limit により停止しました。追加診断の打ち切りは `2026-10-31T02:03:23Z`（再開後9分38秒、累計1時間03分47秒）です。NVC patch の out-of-scope files は5です。詳細は [S11 実験記録](../../docs/experiments/S11-nvc-wasm.md) を参照してください。
