# S18 依存更新の回帰（2026-11）

- 対象: [依存更新通知 #21](https://github.com/uist1idrju3i/gogo-fpga/issues/21)
- 実装: [PR #71](https://github.com/uist1idrju3i/gogo-fpga/pull/71)
- 各依存の変更履歴と採否: [調査記録](../research/issue21-dependency-update.md#2026-11-22-の更新)
- 戻り先: [実験索引](README.md)

## 目的と基準

15件の依存を更新した前後で、書き込み部の再現ビルド、形式検証solver、仮想USB、fixtureの一貫性を確かめます。S17と同じく、複数の依存を一度に変えたため時間差を特定の依存の改善とは扱いません。

## 環境

ホストはx86_64のLinux、Node.js v24.22.3、Emscripten 7.0.1（releases-9146b21a）、WASI SDK 34.0を使います。候補はcommit `fbc016b`の状態です。Tang Nano実機は本リポジトリでは試していません。仮想USBでの時間は実機の値ではありません。

## 書き込み部の再現ビルド

`BUILD_ROOT`を変えて`scripts/build-wasm.sh`を2回実行しました。両方の出力のSHA-256が一致し、再現性を確認しました。

| 資材 | byte数 | SHA-256 |
|---|---:|---|
| openFPGALoader.wasm | 1,682,617 | `90a20bce971dae5340caa97edf43a875369ddb912c54a44bc2391112aca7685c` |
| openFPGALoader.mjs | 100,369 | `24ab174e13807073140d6d0de66d3b9e8259f91ad2010311cae1a7741928627a` |

WASMをgzipした比較用のbyte数は584,595です。emsdk 7.0.1のJSPI既定（Chrome 137・Firefox 153・Safari 27・Node 24）は既存の要件と一致しています。

## 形式検証solver

Yices2 2.8.0をWASIへビルドし、`build-formal-solvers.py verify`が成功しました（2,041,855 B、SHA-256 `af03f88cd4434a9dc6eddd4e0f24ace48a0266d130feef0e2065ad20f2a72fd2`）。検証は配布と同じパッチ入力で再実行しています。upstreamが`utils/make_source_version`を書き換え、`YICES_SOURCE_REVISION`の環境変数とwork tree境界のgit検査を備えたため、`patches/yices2/reproducible-version.patch`は新しい構造に合わせて書き直しました。`SOURCE_DATE_EPOCH`の日付化と`.gitcommit`フォールバックを保持し、`patch --fuzz=0`での適用を確かめました。`unsupported-wasi-alarm.patch`はオフセット-14でそのまま適用されます。

Bitwuzla 0.11.0は入力ソースの更新のみで、隔離診断のままです。製品の既定solverはYices2のままです。

## 仮想USBとfixture

`WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs`が43件すべて成功しました。

yowasp-yosys 0.71で生成し直した4ボードの`.fs`は、内容が0.70生成物と異なり、`.fs`由来の設定チェックサムと、仮想デバイスがeflashから算出するusercodeが変わりました。`tests/sim`の期待値を実測値（設定チェックサム`0x13ce・0x7485・0xed57`、usercode`0x000014ce`）へ更新しました。

検出と書き込みの観測値です。構成は仮想FT2232とGOWIN TAPです。

- 検出（各ボード5回）: 約122-153 ms
- SRAM書き込み（各ボード5回）: 約194-331 ms
- 内蔵flash書き込み（各ボード5回）: 約1.6-4.5 s
- 外部flash書き込み: 1Kなし、4K約92 s、9K約155 s（検証込み）
- 負の対照（CRC破壊・IDCODE不一致・busy上限・切断）はすべて期待どおり拒否

## 画面とpack

`tests/web`のうち画面の部品は542件成功しました。`decompress`と`site-distribution`は組み立て済みの`public_html`を要求するため、このホストでは未実行です。`scripts/build-web.sh`の全資材生成と`npx playwright test`はCIのビルド・E2Eジョブで検査します。

Pyodide 314.0.8は修正版で、`pyodide-lock.json`のPython 3.14.2・NumPy 2.4.6・msgspec 0.20.0・micropip 0.11.1は不変です。pack資材は新しいlockで検証・配置済みです。`gowin_pack`のPyodide/native比較は`tests/synth/gowin-pack.test.mjs`がCIで実行します。314.0.8はiOS 18.0から18.5の対応を終了しました。ビットストリーム生成とPython版の形式検証に影響するため、対象端末の記載を調査記録に残します。
