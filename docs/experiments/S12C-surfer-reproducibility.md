# S12C Surfer の親リポジトリーに依存しない再現ビルド

- 状態: 完了
- 日付: 2026-11-12
- 関連: [実験一覧](README.md)、[S12 の同一 revision 比較](S12-surfer-wasm.md)

## 目的と仮説

同じ Surfer の pin でも、午後のFPGA の commit が変わると WASM が変わる原因を調べます。
コピー時に `.git` を除いた Surfer の build script が親の Git を参照し、
`VERGEN_GIT_DESCRIBE` に午後のFPGA の commit を埋め込むと予想します。
既存の `SOURCE_DATE_EPOCH` も親 commit 由来のため、日をまたぐ場合を調べます。

## 採否の基準（測定前）

- pin とツールを変えず、別々の空の Cargo target から2回ビルドし、
  `surfer_bg.wasm` と `index.html` の SHA-256 が全件一致すること。
- 親の Git commit と日付を変えても Surfer 用の metadata は一致すること。
- 出典がない、壊れた metadata や pin 不一致を拒否すること。
- 配布物の書き換えや upstream source の直接編集を行わないこと。

重い全ビルドは依頼の基準どおり2回とし、metadata の正常・異常系は単体テストで補います。

## 原因の切り分け

比較した成功 run は [43226933480](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43226933480) と
[43231312841](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43231312841) です。
対応する `pages-update/7b69d65ec298d16c0415bd77c11498f20f947353` と
`pages-update/519634df6ccd00e43af62f81f4c052fdef16c4c8` の全配布物の差は Surfer の2ファイルだけでした。

WASM は両方とも12,867,021 bytes です。異なるのは0始まりの offset
12,006,933～12,006,939 と12,006,965～12,006,971 の計14 bytes で、
文字列 `7b69d65` と `519634d` が2か所に入っています。
他の全 bytes は一致するため、この差を wasm-opt のランダムな出力とする仮説は棄却します。
`index.html` は WASM 用の `sha384-...` だけが違い、両方とも実際の WASM の SHA-384 と一致しました。

到達経路は次のとおりです。

1. `scripts/build-surfer.sh` が source をコピーして `.git` を除去します。
2. `surfer/Cargo.toml` と `libsurfer/Cargo.toml` は、それぞれ `build.rs` を指定しています。
   両 build script は `GitclBuilder::all().describe(true, true, None)` を呼びます。
3. Cargo.lock の vergen-gitcl 9.1.0 は作業ディレクトリーで `git describe --always --tags` を実行します。
   コピー元の `.git` がないため、Git は上位にある午後のFPGA の `.git` に到達します。
4. `libsurfer/src/help.rs` の `env!("VERGEN_GIT_DESCRIBE")` と `env!("VERGEN_BUILD_DATE")` が
   その値を版表示に使い、WASM に入れます。旧 script の epoch も午後のFPGA の HEAD 由来でした。
5. Trunk は生成した WASM から SRI を作るため、HTML にも差が伝わります。

経路3は実際にコンパイルした upstream の build-script executable で再現しました。
`tests/fixtures/surfer-metadata-probe.py` は5つの親 Git commit と5日分の日付で、旧環境と修正後を交互に実行します。
旧環境の版・日付は5通りに変わり、修正後は全5回が同じ pin・日付になりました。
プローブが使った `libsurfer/build.rs` は vendor とコピー先で同じ SHA-256
`5c2d938f322b566ab819ba533ebf908995ddea1a86e50cbf1d8de18b9ee0dbda` です。

## 修正

`surfer-build-metadata.py` が Surfer 自身の Git commit 日時を取得します。
`SOURCE_DATE_EPOCH`、`VERGEN_BUILD_DATE`、`VERGEN_GIT_DESCRIBE` を Surfer の pin に合わせ、
外側のビルドの日付・版の指定も置き換えます。版は省略しない40文字の SHA、日付は UTC の source commit 日です。
今回の epoch は `1777295209`、日付は `2026-04-27` です。日付をコードへ固定していません。

source archive では `package-release.sh` が `.gitcommit-timestamp` を `.gitcommit` と一緒に出力します。
Git も marker もない場合、pin 不一致、空・不正な日時は失敗とし、親の Git に戻りません。
`RELEASE-SOURCE.json` の schema は変えていません。既存の配布物の加工や vendor の直接編集もありません。

## 固定条件と再実行

| 項目 | 値 |
|---|---|
| 基準の午後のFPGA commit | `94648b5de602bc771d7581c7865ca50d875d45a1` |
| ホスト | Linux 6.8.0-1060-aws、2 CPU、8,328,228,864 bytes memory |
| Surfer | `bd749b1f786c1c62cd67893ca71346cbe6983915`、v0.7.0 |
| nested submodules | f128 `e60de395f0d6454c1dc546b87f06a6358425b6b6`、instruction-decoder `02bdcbfd5663a72e4a0b1b9d54519412d417fab1` |
| 実バイナリーの版 | rustc 1.99.1 (`58cf8f9c3`)、Trunk 0.21.14、wasm-bindgen 0.2.118、wasm-opt version 123 |
| Cargo | locked、release、accesskit、incremental 無効、2 jobs |
| 作り直したもの | source copy、Cargo target、dist。A と B の target は別の空のディレクトリー |
| 再利用 | 検証済み tool archives と Cargo の download cache のみ |

専用の同じ shell で実行します。`RUST_LOG=info` が残る環境では、Trunk の `--verbose` と衝突するため外します。

```sh
unset RUST_LOG
SURFER_BUILD_ROOT=build/S12C/clean-a CARGO_BUILD_JOBS=2 scripts/build-surfer.sh
SURFER_BUILD_ROOT=build/S12C/clean-b SOURCE_DATE_EPOCH=1 \
  VERGEN_GIT_DESCRIBE=unrelated-parent VERGEN_BUILD_DATE=1970-01-01 \
  CARGO_BUILD_JOBS=2 scripts/build-surfer.sh
sha256sum build/S12C/clean-{a,b}/dist/{surfer_bg.wasm,index.html}
diff -qr build/S12C/clean-a/dist build/S12C/clean-b/dist

probe=$(find build/S12C/clean-a/target/release/build \
  -path '*/libsurfer-*/build-script-build' -type f)
python3 tests/fixtures/surfer-metadata-probe.py --build-script "$probe" \
  --source vendor/surfer --commit bd749b1f786c1c62cd67893ca71346cbe6983915 \
  --start-date 2026-11-12 --output build/S12C/metadata-probe
```

空の出力先を使ってください。プローブは出力先が既にあれば停止し、上書きしません。

## 失敗した試行と警告

- 最初は compile 前に停止しました。ローカルの vendor checkout の `.git` はディレクトリーで、
  旧 `rm -f` はファイルしか除去できませんでした。コピー先だけを `rm -rf --` で除去するようにしました。
- 次は環境の `RUST_LOG=info` と Trunk の verbose 指定が衝突しました。
  shell を終了すると環境が戻るため、B の最初の試行も同じ理由で compile 前に停止しました。
  専用の対話 shell で一度解除し、解除した状態を表示してから再実行しました。
- build log の vergen の `VERGEN_GIT_DESCRIBE overidden` は指定した override の通知です。
  upstream の未使用 import、macro の末尾 semicolon、非推奨定数などの警告は残しています。

## 結果と未確認の範囲

生の値は [CSV](S12C-surfer-reproducibility.csv) に記録しました。
元の成功 CI の異なる SHA-256 と、5組の metadata の差で比較器の反応を確認しました。
修正後の同一物だけを比較して成功としたわけではありません。

| run | Trunk 所要時間 | 全 script 所要時間 | WASM bytes | HTML bytes |
|---|---:|---:|---:|---:|
| clean-a | 468 s | 470 s | 12,867,178 | 5,827 |
| clean-b | 467 s | 470 s | 12,867,178 | 5,827 |

2回の Trunk 所要時間は最小467 s、中央値467.5 s、最大468 s、全 script は3値とも470 sです。
WASM は報告された旧 CI の成果物より157 bytes 大きくなりました。
版を40文字にした影響を含みます。最適化や runtime source を変えた速度改善とは扱いません。

両 build の SHA-256 は次のとおりです。

```text
2815da8beb253221d957c5e6626c6cec4865466ff2b9ea14f759e36fdf1c9cc7  clean-a/surfer_bg.wasm
2815da8beb253221d957c5e6626c6cec4865466ff2b9ea14f759e36fdf1c9cc7  clean-b/surfer_bg.wasm
3d3f19ee748041056c58786effbe8635cc2cdb4a3d34cff871b904f57dff0d81  clean-a/index.html
3d3f19ee748041056c58786effbe8635cc2cdb4a3d34cff871b904f57dff0d81  clean-b/index.html
```

`diff -qr` も exit 0 でした。2ファイルだけでなく全453ファイル、15,383,311 bytes の配布ツリーが一致し、事前基準を満たしました。
B の外側の epoch・日付・版を変えても、log は A と同じ `SURFER_SOURCE_METADATA` を示しています。
プローブは引数不足、反復数1、既存の出力先を拒否し、既存 CSV の bytes も保ちました。

全ビルドの log は大きいため追跡しません。上記のコマンドの stdout/stderr を保存すると再取得できます。
今回の log の SHA-256 は次のとおりです。

| log | SHA-256 |
|---|---|
| clean-a | `5307c9d17b156c6bc27b3a760684b2e2801f92458e74a951c3ec510b3f733b41` |
| clean-b | `4a9a74b58a915a737d8f4a4fb31d11a0d0f24e5d000464f5dc79ef1332414628` |
| metadata probe | `465b746b880d8f0245c7bb73d546e50e3e7d1cce1bfc4819e32b99b4ebffbb2d` |

既存の S12 の同一 revision 比較は誤りではありませんが、親の commit が異なる比較を含んでいませんでした。
今回はその適用範囲を補います。Cloudflare の設定や publish script は変更しません。
実機の Tang Nano と画面の目視確認は本実験では行いません。
異なるホスト間の修正後の hash 比較、全 Release の梱包、ブラウザーでの再実行も未確認です。
