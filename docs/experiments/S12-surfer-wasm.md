# S12 Surfer v0.7.0 の WASM 化

- 状態: 完了。同一 revision のローカル2回と CI の全453ファイルが一致
- 日付: 2026-10-31
- 関連: [凍結基準](S12-surfer-wasm-criteria.md)

## 目的

Surfer v0.7.0 を upstream source から `wasm32-unknown-unknown` 向けにビルドし、`dist/surfer/` と Release に含めます。ビルドの再現性、依存 crate のライセンス、同一 origin iframe での VCD 読み込みを検証します。Surfer をアプリの UI に統合する作業は T4 Stack step 2 で行うため、この記録には含めません。

## 固定条件

| 項目 | 値 |
|---|---|
| 凍結基準 | `3c7ed8a` の `docs/experiments/S12-surfer-wasm-criteria.md` |
| upstream | Surfer v0.7.0、peeled commit `bd749b1f786c1c62cd67893ca71346cbe6983915` |
| source URL | `https://gitlab.com/surfer-project/surfer.git` |
| nested submodules | f128 `e60de395f0d6454c1dc546b87f06a6358425b6b6`、instruction-decoder `02bdcbfd5663a72e4a0b1b9d54519412d417fab1` |
| license | EUPL-1.2 |
| Rust | 1.99.1、target `wasm32-unknown-unknown` |
| Trunk | 0.21.14、archive SHA-256 `f2b4680cd239693a646a2795e4633c625328d7b2a044fbe749fa3a2fe9e7036b` |
| wasm-bindgen-cli | 0.2.118、archive SHA-256 `00b519c9fc2d6e087265da1a00f29160bfcc6a823993482bc2e691910287427b` |
| Binaryen | version_123、archive SHA-256 `e959f2170af4c20c552e9de3a0253704d6a9d2766e8fdb88e4d6ac4bae9388fe` |
| Cargo | `--locked --release --features accesskit` |
| public URL | `./` |
| build output | `build/surfer/dist/` |

## build 環境と再現性

実行環境は Linux x86_64、kernel 7.0.0-42-generic、12 CPU threads、約 30 GiB memory です。Surfer submodule は v0.7.0 の peeled commit、nested submodules は f128 `e60de395f0d6454c1dc546b87f06a6358425b6b6` と instruction-decoder `02bdcbfd5663a72e4a0b1b9d54519412d417fab1` です。

clean build は `build/S12/clean-a` と `build/surfer` の別々の Cargo target directory で実行しました。両方とも source copy を作り直し、nested submodule を shallow fetch してから同じ patch を適用しました。Trunk の log は `offline=true` を示し、PATH 上の wasm-bindgen 0.2.118 と wasm-opt version_123 を選択したため、Trunk による tool download はありません。

| run | 開始時刻 UTC | 完了時刻 UTC | build script 所要時間 | Trunk 所要時間 |
|---|---|---|---:|---:|
| clean-a | 2026-10-31 02:47:49 | 2026-10-31 02:51:54 | 245 s | 240 s |
| clean-b | 2026-10-31 02:51:58 | 2026-10-31 02:56:01 | 243 s | 240 s |

両 build の manifest は 453 files で、relative path、size、SHA-256 が全件一致しました。WASM は 12,867,044 bytes、SHA-256 `3846ca2ab603a9bd544618740725f19228a1d56198fdf40cbe0c058e027c0ae4` です。全配布物は 15,383,177 raw bytes です。圧縮値は再現可能な tar stream に対し gzip `-n -9`、zstd `-19 -T1`、WASM 単体に同じ圧縮設定を使いました。

| data | raw bytes | gzip bytes | zstd bytes |
|---|---:|---:|---:|
| `surfer_bg.wasm` | 12,867,044 | 4,347,085 | 3,207,899 |
| distribution tar | 15,383,177 | 4,485,758 | 3,257,513 |

全成果物の path、size、SHA-256 は `build/S12/clean-a-retry.log` と `build/S12/clean-b.log` に記録しました。集計値は `build/S12/size-metrics.txt` にあります。

## 事前の browser probe

次の事実は事前 probe で得た値を採用し、この build では再測定しません。

- 同一 origin の iframe で Surfer を開き、親 frame から blob URL の VCD を送ると読み込みます。console に `LoadWaveformFileFromUrl` と `FileDownloaded` が出て、scope `logic` が現れました。
- 外部 origin への request はありませんでした。in-origin の favicon 404 は発生しました。
- text VCD は読み込みますが、binary FST は読み込みませんでした。
- WebGL が必要です。headless Chromium では `DISPLAY` を unset し、`--use-angle=swiftshader --enable-unsafe-swiftshader` を使うと描画できました。
- accesskit の build への影響と byte-identical build は事前 probe では未確認でした。

## 先行試行

事前の trial build は accesskit feature を有効にせず、4分15秒で 12,870,570 bytes の WASM を生成しました。gzip は 4,346,277 bytes でしたが、記録された hash に不一致があったため、この成果物は採用せず、今回の build artifact にも再利用しません。

今回の最初の clean build は patch file の hunk 行数が合わず、`patch` が `malformed patch at line 19` で停止しました。hunk を upstream の `surfer/index.html` に合わせ、Service Worker 登録部分だけを削除する patch に直して再試行しました。失敗 log は `build/S12/clean-a.log`、再試行 log は `build/S12/clean-a-retry.log` です。

emsdk の tag を含まない shallow clone では、`build-info.py` が使う `git describe --tags --exact-match` が `fatal: No names found, cannot describe anything.` で失敗しました。再現 log は `build/S12/emsdk-no-tags-describe.log` と `build/S12/emsdk-no-tags-clone.log` です。Build job には `scripts/build-wasm.sh` の前に tag を取得する既存 step があるため、この branch で追加された重複 fetch は削除し、既存 step は残しました。

## build と配布

`scripts/build-surfer.sh` は、pinned tool archive の SHA-256 を検証し、vendor source と nested submodule を `build/surfer-src/` にコピーして Service Worker 登録だけを patch した後、Trunk を offline mode で実行します。PATH 上の pinned wasm-bindgen と wasm-opt を使い、`build/surfer/dist/` に作成した全ファイルの relative path、size、SHA-256 を log へ記録します。

`scripts/collect-surfer-licenses.py` は Cargo metadata の `wasm32-unknown-unknown` graph から Surfer の normal runtime dependencies をたどり、crate 名、版、license expression、source とライセンスファイルを記録します。dev/build dependency は含めず、license expression と license file の両方がない crate があれば停止します。

`libsurfer/Cargo.toml` の `egui_skia_renderer` は `[dev-dependencies]` にあり、WASM runtime dependency graph の外です。依頼にあった dev dependency を除外する条件を優先し、配布 license table には含めていません。upstream の Git source と revision は Cargo.lock に固定されています。

`scripts/build-web.sh` は成功し、Surfer を `dist/surfer/` に配置しました。Surfer を含む各配布ファイルの 25 MiB 上限と、`/surfer/*` を含む COOP/COEP header 設定も build 内で検査されました。log は `build/S12/build-web-final.log` です。

最初の E2E 起動は Surfer の spec より前に、既存の synthesis harness が要求する native nextpnr、Apycula packer、native GHDL が worktree にないため停止しました。Surfer 以外の検証資材を用意して再実行し、同じ Surfer distribution に対する spec を完了しました。既存の Surfer trial distribution は使用していません。

local/CI hash 比較は push 後の CI handoff で行うため、この時点では未確認です。

## 結果

| 基準 | 結果 |
|---|---|
| 1. 2 回の clean build の全ファイルが一致 | **Pass**。453 files の相対 path、size、SHA-256 が一致 |
| 2. local / CI hash 比較 | **未確認**。同じ commit の CI log との比較を後続の CI handoff で行う |
| 3. build 時間と raw / gzip / zstd size | **Pass**。2 回の所要時間と圧縮値を上記に記録 |
| 4. Surfer E2E を5回連続実行 | **Pass**。Chromium で 15/15 tests passed。positive test は `waves_loaded()` と `index_of_name("logic.clk")` で読み込みと signal を確認 |
| 5. 負の対照 | **Pass**。破損 VCD の `Failed to parse wave file`、未読込状態、Service Worker 登録の不在、`manifest.json` と `sw.js` の不在を確認 |

Surfer v0.7.0 の `index_of_name()` は、読み込んだ波形のうち timeline に追加された item を検索します。読み込み直後は timeline が空なので、positive test は exported `inject_message()` で scope `logic` を追加してから `index_of_name("logic.clk")` が非負になることを確認します。これにより `FileDownloaded` の console message に含まれる VCD bytes を signal の存在と誤認しません。破損 VCD の test は `Failed to parse wave file` を確認した後、1秒間 `waves_loaded() === false` を poll します。

positive test に破損 VCD を一度だけ与えた mutation check は、`waves_loaded() === true` の assertion で期待どおり失敗しました。その後 fixture を復元し、最終の5回実行を行いました。mutation log は `build/S12/surfer-mutation-check-final.log`、最終 E2E log は `build/S12/surfer-e2e-reviewed-5x-final.log` です。

E2E は `DISPLAY` を unset し、`--use-angle=swiftshader --enable-unsafe-swiftshader` で実行しました。port 8000 は既存プロセスが使用中だったため、`PLAYWRIGHT_PORT=8798` を指定しました。CI の結果はこの push の完了後には待たず、後続の CI handoff で確認します。

## 2026-11-01 の再調査: 同一 revision での CI 比較

上記は2026-10-31の実施時点の記録です。引き継ぎ時の追加比較では、旧 local build と main の CI は453件中451件が一致し、次の2件が不一致でした。source revision が異なるため、この比較だけでは再現性の合否を決められませんでした。

| ファイル | 旧 local bytes / SHA-256 | main CI bytes / SHA-256 |
|---|---|---|
| `index.html` | 5827 / `03be7c03b8100a3fe2768816249ed7c254c45028671bb21801895de291b0a024` | 5827 / `089364a4523d2e32d8781d870f7e0cd83376d01836e19fff6fcf182ac70d0ab9` |
| `surfer_bg.wasm` | 12867044 / `3846ca2ab603a9bd544618740725f19228a1d56198fdf40cbe0c058e027c0ae4` | 12867021 / `9fd9b25a45cb43e20bf12eef70d8d09050f68dd3fd07b0f19acf84f9ed46b049` |

### 固定条件と手順

凍結基準の第1・2項に従い、main の `7c8623010f0895bca651a297fa45123d6d338bcf` を基準に、空の Cargo target directory 2つからビルドし直しました。性能の採否を比較する実験ではないため、反復は凍結基準どおり2回です。source、pin、patch、feature、最適化は変えていません。

| 項目 | 値 |
|---|---|
| ホスト | Linux x86_64、kernel 6.8.0-1061-aws、2 CPU、7,941 MiB memory、swapなし |
| source epoch | `1793507111`（基準 commit の `%ct`） |
| Rust / Trunk / wasm-bindgen / Binaryen | 実行したバイナリーで 1.99.1 / 0.21.14 / 0.2.118 / version_123 を確認 |
| upstream / nested submodules | 上記の固定条件と同じ3つの commit |
| Cargo | `--locked --release --features accesskit`、`CARGO_BUILD_JOBS=2`、`CARGO_INCREMENTAL=0` |
| cache | Cargo registry と取得済み tool archive は共有。Cargo target と配布先は2回とも別の空 directory |
| CI | [run 41273028148](https://github.com/gogo-fpga/toolchain/actions/runs/41273028148)、[Surfer job](https://github.com/gogo-fpga/toolchain/actions/runs/41273028148/job/124749532054)、artifact `ci-surfer-wasm-41273028148`（ID `13069543578`） |

ビルド中は root repository の HEAD と追跡ファイルを変えませんでした。最初の試行は環境の `RUST_LOG=info` と Trunk の `--verbose` が競合し、Cargo build 前に終了コード2で停止しました。失敗ログを保存し、以後は `RUST_LOG` を外して実行しました。script の変更や版の更新はしていません。

再実行は基準 commit の clean checkout で行います。次の出力先に既存の成果物があれば、先に証拠を保全し、別の空の出力先を選びます。

```sh
env -u RUST_LOG CARGO_BUILD_JOBS=2 scripts/build-surfer.sh
env -u RUST_LOG CARGO_BUILD_JOBS=2 SURFER_BUILD_ROOT=build/S12B-clean-b scripts/build-surfer.sh
gh run download 41273028148 --repo gogo-fpga/toolchain \
  --name ci-surfer-wasm-41273028148 --dir build/S12B-ci
```

比較した全ファイルの値は [S12-surfer-wasm-ci-comparison.csv](S12-surfer-wasm-ci-comparison.csv) に残します。比較では path、bytes、SHA-256 のすべてを使い、空の配布先と既存 CSV の上書きを拒否します。比較器にも、不足、余剰、同じサイズの内容変更、サイズ変更の負の対照を与え、4つとも不一致を検出することを確認しました。

```python
import csv
import hashlib
from pathlib import Path

roots = [Path("build/surfer/dist"), Path("build/S12B-clean-b/dist"), Path("build/S12B-ci")]
output = Path("docs/experiments/S12-surfer-wasm-ci-comparison.csv")

def manifest(root):
    values = {
        str(path.relative_to(root)): (path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
        for path in root.rglob("*") if path.is_file()
    }
    if not values:
        raise RuntimeError(f"Empty or missing distribution: {root}")
    return values

reference = {"a": (1, "hash-a")}
controls = [{}, {**reference, "b": (1, "hash-b")}, {"a": (1, "hash-b")}, {"a": (2, "hash-a")}]
if any(candidate == reference for candidate in controls):
    raise RuntimeError("Negative control failed")
manifests = [manifest(root) for root in roots]
if any(candidate != manifests[0] for candidate in manifests[1:]):
    raise RuntimeError("Distribution mismatch")
with output.open("x", newline="", encoding="utf-8") as stream:
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(["path", "local_a_bytes", "local_a_sha256", "local_b_bytes", "local_b_sha256", "ci_bytes", "ci_sha256"])
    for path in sorted(manifests[0]):
        writer.writerow([path, *(value for values in manifests for value in values[path])])
print(f"Matched {len(manifests[0])} files across all three distributions")
```

### 結果と原因の切り分け

| run | 開始 UTC | script / Trunk 秒 | ファイル数 | 合計 raw bytes | CIとの差分 |
|---|---|---:|---:|---:|---:|
| local-a | 2026-11-01 05:26:27 | 245 / 244 | 453 | 15,383,154 | 0 |
| local-b | 2026-11-01 05:31:01 | 249 / 247 | 453 | 15,383,154 | 0 |
| CI | 上記の job | 今回の時間比較には不使用 | 453 | 15,383,154 | 基準 |

**凍結基準の第2項は Pass です。** local 2回と CI の全453ファイルで相対 path、bytes、SHA-256 が一致しました。WASM は3者とも12,867,021 bytes、SHA-256 `9fd9b25a45cb43e20bf12eef70d8d09050f68dd3fd07b0f19acf84f9ed46b049`、HTML も上表の CI の値と一致しました。

Surfer の `surfer/build.rs` と `libsurfer/build.rs` は `vergen_gitcl` で build date と Git description を生成します。source copy の `.git` を取り除いても、`build/surfer-src/` は root repository の下にあるため、Git は親の repository を見つけます。今回の Cargo build output と WASM には `VERGEN_GIT_DESCRIBE=7c86230` と `VERGEN_BUILD_DATE=2026-11-01` があり、CI WASM の表示用文字列とも一致しました。`SOURCE_DATE_EPOCH` も root の commit に由来します。HTML は WASM の SHA-384 integrity を含むため、WASM が変われば HTML も変わります。

したがって、異なる root revision の出力をそのまま比べると、upstream の pin が同じでも埋込情報が比較条件に混ざります。同一 revision にそろえた今回の2回では不一致を再現しませんでした。旧 WASM 本体は引き継ぎ資料に残っていないため、旧2件の差分を埋込情報だけに帰属させるバイナリー比較は行っていません。Git のない source archive、別の revision、別の toolchain まで一致すると確認したものでもありません。

今回 UI は変更せず、ブラウザーの E2E は再実行していません。旧5回の E2E とその負の対照は当時の artifact の記録のままです。T4 WIP の画面、accesskit の有無、zstd 配信の採否、実機 Tang Nano は今回の検証範囲外です。本リポジトリでは実機を試していません。

### ログの SHA-256

ログ全体は証拠とともに保全し、リポジトリには全ファイルの機械比較 CSV と再生成手順を残します。

| ログ・取得物 | SHA-256 |
|---|---|
| local-a build log | `0c8d4ce3efe60a6ebffa7a6f5e4f070dd97cdd52e1a693b3d7f12592d1d79bfc` |
| local-b build log | `a13aafcf061db819fb543ec93834e91cf8d7889ec9c725cc16037f4af10ed91e` |
| RUST_LOG 競合で失敗した log | `1538de58f52d7777836fc1b30db5c52560e2c385a78a2c47cbcd9686a21a27d2` |
| 取得した CI artifact ZIP | `f5ec12549584ddc1064f7763ba08b21122e2eb85fbed4905d10f8ae2b93f44f7` |
