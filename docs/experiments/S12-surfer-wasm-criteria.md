# S12 Surfer WASM の凍結基準

- 状態: 計画
- 日付: 2026-10-31
- 担当: Devin
- 関連: T4 Stack step 1

## 目的

Surfer v0.7.0 をソースから WASM にビルドし、配布物へまとめる。CI とブラウザーの負の対照を含め、再現性と配布可能性を確認する。UI への組み込みは Stack step 2 のため、この実験には含めない。

## 採否の基準

1. 異なる空の build root で実行した 2 回の clean build が成功し、`build/surfer/dist/` のすべての出力ファイルの相対パス、サイズ、SHA-256 が一致する。
2. CI build のログに出る全出力ファイルの相対パス、サイズ、SHA-256 が、同じ commit のローカル clean build と一致する。
3. build 時間と成果物のサイズを記録する。各出力ファイルと合計について raw bytes を記録し、`surfer_bg.wasm` と配布物全体について gzip と zstd `-19` の bytes も記録する。
4. Surfer E2E を 5 回連続で実行し、すべて成功する。テストは VCD の読み込み、scope 名 `logic` の表示、同一 origin 外への要求がないことを検証する。
5. 負の対照で、破損 VCD が Surfer の parse error を出すこと、配布した `index.html` に Service Worker 登録がないことを確認する。

## 固定条件

- upstream: Surfer v0.7.0、peeled commit `bd749b1f786c1c62cd67893ca71346cbe6983915`
- source URL: `https://gitlab.com/surfer-project/surfer.git`
- Rust: 1.99.1、target `wasm32-unknown-unknown`
- Trunk: 0.21.14、wasm-bindgen-cli: 0.2.118、Binaryen: version_123
- Cargo profile: `--locked --release --features accesskit`
- 出力: `build/surfer/dist/`
- 2 回の build は別々の clean build root を使い、既存成果物を再利用しない。
- ローカルと CI は同一 commit、同じ pin、patch、build option を使う。
- upstream source は変更せず、patch は `patches/surfer/` だけに置く。
- `sw.js` と `manifest.json` は配布物から除く。
- Chromium は `DISPLAY` を unset し、`--use-angle=swiftshader --enable-unsafe-swiftshader` を使う。
- 各 build の開始・終了時刻、実際に使われた tool version、成果物一覧と SHA-256 を記録する。

## 判定

上記 5 項目のうち未達または未確認があれば、その項目を明記し、成功したものとして扱わない。CI ログとの比較は push 後の CI 実行を要するため、CI handoff で確認する。
