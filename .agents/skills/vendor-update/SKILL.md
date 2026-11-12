---
name: vendor-update
description: 午後のFPGA Web Toolchain の依存（vendor/ と third_party/ の submodule、emsdk、GitHub Actions、npm、fixture 用の pip パッケージ）を追加・更新するときや、Dependabot の PR、「固定版の更新確認」で見つかった更新を確かめるときに使う。変更履歴をすべて読み、採否、ライセンス、ビルドの再現性、仮想 USB と E2E の回帰を更新前後で比べる。
---

# vendor-update（依存関係の更新）

依存を追加・更新するときは、対象の変更履歴とライセンスを確認し、更新前後の結果を比べます。Dependabot が作成した PR と「固定版の更新確認」で見つかった更新も同じ手順で確認してから、人間がマージします。

## 対象と変更履歴の参照先

| 依存 | 現在値の確認方法 | 変更履歴の参照先 | 注意 |
|---|---|---|---|
| openFPGALoader | `git -C vendor/openFPGALoader describe --tags` | release と `git log <old>..<new> -- src/gowin.cpp src/gowin.hpp src/main.cpp src/board.hpp src/part.hpp src/ftdi*.cpp src/spiFlash.cpp CMakeLists.txt` | RESEARCH.md の行番号の引用と「高度な設定」の適用条件を照らし合わせ直す。ずれたら直す |
| libusb | `git -C vendor/libusb describe --tags` | `ChangeLog` と `libusb/os/emscripten_webusb.cpp`、`libusb/os/events_posix.c` の差分 | WebUSB バックエンドと、共有メモリーの要否が変わっていないかを確かめる |
| libftdi | `git -C vendor/libftdi rev-parse HEAD`（gitlink） | `.gitmodules` の URL と branch（既定は upstream の `HEAD`）の log と `ChangeLog` | Dependabot は `developer.intra2net.com` に接続できないため、「固定版の更新確認」が branch 先端を監視する。`git://` の URL を維持する |
| zlib | `git -C vendor/zlib describe --tags` | `ChangeLog` | タグのオブジェクトではなく、commit の SHA を記録する |
| emsdk / Emscripten | `git -C vendor/emsdk describe --tags --exact-match` | Emscripten の `ChangeLog.md`（間にある版をすべて）。JSPI、例外、pthread、`settings.js` の廃止・既定値の変更 | タグは版の順（`--sort=-v:refname`）で比べる。廃止された設定は外す（例: `WASM_BIGINT`） |
| Yosys | `git -C vendor/yosys describe --tags --exact-match` | `CHANGELOG` と CMake、ABC 統合、Slang 無効時の依存 | v0.70 は CMake ビルド。ABC と必要な `libs/*` のみ初期化し、合成結果をネイティブ版と比較する |
| nextpnr | `git -C vendor/nextpnr describe --tags --exact-match` | release と `git log <old>..<new> -- CMakeLists.txt cmake/BBAsm.cmake himbaechel/` | Gowin chipdb 生成、WASI の BBA import、外部 chipdb パスを確認し、native と WASI の配置配線 JSON を比較する |
| Boost / Eigen | `RESEARCH.md` のアーカイブ固定値表 | 各 release notes とアーカイブに含まれる変更履歴 | Boost は WASI で必要な2 component のみを静的ビルドし、Eigen はヘッダーのみ参照する。両方の SHA-256 を確認する |
| Apycula | `requirements-nextpnr.txt` | PyPI の release と Apycula の変更履歴 | 0.35 を先に試し、chipdb 生成または P&R が失敗した場合だけ、動作する最新の版へ切り替える。試行版とエラーを RESEARCH.md に記録する |
| Pyodide / NumPy / msgspec | `package.json`、`package-lock.json`、Pyodide の `pyodide-lock.json` | Pyodide、NumPy、msgspec の release notes とライセンス | Pyodide は npm の exact pin とし、NumPy / msgspec の版と SHA-256 はロックファイルから導く。配布 asset の hash と native `gowin_pack` との `.fs` 一致を検証する |
| wasi-sdk | `RESEARCH.md` の WASI SDK 固定値表 | [wasi-sdk releases](https://github.com/WebAssembly/wasi-sdk/releases) とリリースアセット | Linux x86_64 アーカイブの SHA-256 を確認し、wasi-libc の配布ライセンスも確認する |
| yomiyasu | `git -C vendor/yomiyasu rev-parse HEAD` | https://github.com/nanaism/yomiyasu の commit と release | `.agents/skills/yomiyasu` のリンク先が残っていることを確かめる |
| npm（`@playwright/test`） | `package.json` と `package-lock.json` | Playwright の release notes | Chromium の版が変わる。JSPI と WebUSB の動作を E2E で確かめる |
| fixture 用 pip | `tests/fixtures/requirements.txt` | Apycula、yowasp-yosys、yowasp-nextpnr-himbaechel-gowin の release | nextpnr の wheel が指定する Apycula の版に合わせる。合わない版にすると 20K の `.fs` が作れない |
| GitHub Actions | workflow の `uses:` にある commit SHA と `# vX.Y.Z` | 各 action の release。後続の major も確かめ、`runs.using` の Node.js がサポート対象か調べる | full commit SHA と `# vX.Y.Z` を併記する |

タグで固定した submodule（openFPGALoader、libusb、zlib、emsdk、Yosys、nextpnr）は Dependabot の対象外です。WASI SDK、Boost・Eigen のアーカイブ、Apycula も「固定版の更新確認」ワークフローで監視します。Apycula の hash lock は Dependabot pip 対象です。libftdi も取得元に接続できないため Dependabot の対象外とし、`.gitmodules` の URL と branch から求めた upstream 先端を同じワークフローが監視します。更新情報は Issue を使って共有する運用です。

## 更新手順

1. 作業ブランチで、更新前の基準を記録します。`build-info.json` の WASM・`.mjs` の SHA-256 と大きさ（gzip 後も）、単体・仮想 USB・Playwright の件数と結果、仮想 USB での書き込み時間を残します。
2. 更新する版の間にある変更履歴をすべて読みます。履歴が shallow clone に含まれない場合は必要な範囲を fetch するか、upstream の compare や release のページで補います。`.gitmodules` の `shallow = true` は維持します。
3. 変更点を次の四つに分けて記録します。新機能は安定性、セキュリティ、速度の順に採否と理由を判断します。
   - 破壊的な変更と、こちらで必要な対応
   - セキュリティ修正と対象範囲
   - 使える新機能と採否の理由（Emscripten の新しいオプションは「experiment-record」で比べる）
   - ライセンスまたはライセンス条件の変更
4. 更新します。submodule は `git -C vendor/<name> fetch --depth 1 origin <tag-or-commit>` の後に `git -C vendor/<name> checkout FETCH_HEAD` を使います。vendor のファイルは編集しません。
5. 更新後に回帰テストを行い、更新前の基準と比べます。
   - `scripts/build-wasm.sh` と `scripts/build-web.sh`。別の `BUILD_ROOT` で 2 回ビルドし、成果物の SHA-256 が一致すること
   - `node --test tests/web/*.test.mjs`
   - Yosys・nextpnr の WASI/native 合成・配置配線比較と負の対照
   - Pyodide 上の Apicula `gowin_pack` と native 版の `.fs` 比較、および asset hash 検証
   - `WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs`（負の対照を含む）
   - `npx playwright test`
   - WASM の大きさと、仮想 USB での書き込み時間
6. `RESEARCH.md` の依存関係の表を更新します。PR 本文に、依存ごとの旧版 → 新版、変更履歴のリンク、四分類の記録、回帰テストの比較結果を書きます。実機では試していないことも書きます。
