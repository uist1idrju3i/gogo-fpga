# S15: Yosys SAT 形式検証の正式5回反復

## 目的と仮説

タスク34 P6。T6 最終認定のうち、正式な5回反復が無かった Yosys 組込み SAT（`sat -tempinduct` と bounded `sat`）の bmc/prove 経路を、固定 commit・固定 binary で反復する。SMT/SBY の反例再実行は [元Verilog再実行](S15-smt-verilog-replay.md)・[元VHDL/PSL再実行](S15-smt-vhdl-replay.md)・[SBY正式反復](S15-sby-repeated.md) で正式反復済みであり、この記録の対象外である。

仮説: native と WASI の Yosys が同じ判定・終了コード・反例を返し、反例は Icarus（native と WASI）で独立に再実行でき、witness を 1 bit 変えた負の対照は必ず拒否される。結果は反復の間で、経過時刻と実行順を除いて一致する。

## 固定する条件

- 条件は `tests/synth/formal-sat-cases.mjs` の 12 件である。verdict 8 件（`identity`・`broken-identity`・`depth3`・`depth4`・`depth5`・`induction`・`false-induction`・`contradictory-assumes`）と error 4 件（`zero-properties`・`wrong-clock`・`wrong-edge`・`unsupported-syntax`）からなる。監査器 `scripts/audit-sat-formal.py` は、この表とは別に書いた条件表と期待値（error は phase・終了コード・理由の文まで）を持つ。
- 1 回分は 12 条件 × native/WASI の 24 行。A/A 2 回と正式 5 回で計 168 行になる。実行順は回の偶奇で native-first と wasm-first を入れ替える。
- 計測 commit は `a4209427efa8511690899192c23d8a42a79cba20`（[PR #86](https://github.com/gogo-fpga/toolchain/pull/86) の merge 後の main）で、作業ツリーは清浄である。計測器は各コマンドの前後で清浄さを確かめ、使った script 7 件の SHA-256 を `plan.json` に、その複製を `snapshots/` に保存する。
- host は Linux `6.8.0-1061-aws`、x64、2 CPU。Node `v24.21.0`、Icarus Verilog `13.0 (stable) (v13_0)`。Yosys は v0.70（`28ba3cb9…`）を WASI SDK 34.0 でビルドしたものである。binary の SHA-256 は[証拠概要](S15-sat-formal-evidence.json)にある。

## 事前の採否基準

- verdict 条件: native と WASI の `actual` が期待値と一致する。終了コードは counterexample の proof phase だけ 1、それ以外は 0。WASM linear memory は 65,536 の倍数。phase は prepare・presat（必要なら proof）の順。
- 反例: `createSatReplay` で Verilog の testbench を作り、Icarus native と WASI で再実行する。`verifySatReplay` が 2 回とも verified を返し、witness を 1 bit 反転させた再実行が rejected になる。replay の stdout・WASM 実行結果・正規化 VCD・`replay.v` の hash が反復の間で一致する。
- error 条件: 成功に数えず、phase・終了コード・理由の文が固定の期待値と一致する。SAT まで進んだ場合や replay を作った場合は失敗とする。
- 反復: `elapsedMs` と `runtimeIndex` を除く全行・replay・failure の内容が、A/A と正式の全回で一致する。
- 証拠: 保存したログから監査器が判定を独立に再導出し、行の値と一致する。

## 再実行コマンド

```sh
python3 scripts/measure-sat-formal.py --out build/S15/sat-formal-formal-01
python3 scripts/negative-sat-formal.py build/S15/sat-formal-formal-01 --out build/S15/sat-formal-formal-neg-01
python3 scripts/package-extra-formal.py --campaign build/S15/sat-formal-formal-01 --output <zip> --include <追加証拠>
python3 scripts/package-extra-formal.py --restore --output <zip> --campaign <未作成の復元先>
```

計測器は `node scripts/probe-sat-formal.mjs --kind verdict|error --order native-first|wasm-first --out <dir>` を回ごとに呼び、終わると `--audit-only` で全体を再監査する。

## 予備結果と失敗試行

- probe が case ディレクトリーを先に作ると、下位の executor が `mkdirSync` で EEXIST になった。事前作成をやめた。
- 組合せ回路の `broken-identity` には depth が無く、`createSatReplay` が "Invalid replay top or depth" で止まった。既定 depth 8 を渡すようにした。
- ログの tree hash が probe と監査器で一致しなかった。原因は並び順で、JS の `sort()` は文字列順、Python の `sorted(Path)` は Path 比較である。監査器を `key=str` にした。
- 反例 4 条件で `logSha256` が反復の間で一致しなかった。Icarus 再実行の `ivl.json` 等が絶対パスの cwd を含み、`work/design.vvp` は ASLR の scope アドレスを含む。`*-replay` ディレクトリーを log hash から外し、再実行の同一性は replay 列と replay 出力の hash で別に照合する形にした。
- 予備計測（commit `e8d1da9f…`）は 168 行で pass、CSV の SHA-256 は `d17ba90a…`。その証拠への改変対照 100 件はすべて拒否された。
- CI 配布物での照合の初回は、記録用 CSV を作業ツリーに置いたまま実行したため、probe が清浄でない checkout を拒否した。CSV を退避して再実行した。

## 正式結果

[生CSV](S15-sat-formal-audit.csv)は 24 列、全 168 行（A/A 48・正式 120）で、SHA-256 は `1c274a53e013a84f9103ac973a0f33632feb988250c64e4e2e16ce4cc17a39a1` である。計測器の集計は `status=pass` で、14 回の監査（A/A 4、正式 10）はすべて pass した。

- 判定: counterexample 56、bounded-safe 28、proved 14、inconsistent-assumptions 14、error 56。すべて期待値と一致した。
- 反例の独立再実行は 56 件。Icarus native/WASI の両方で verified、witness 改変は rejected だった。
- [時間集計CSV](S15-sat-formal-timings.csv)には、24 条件それぞれについて正式 5 回の最小・中央値・最大を保存した。A/A は含まない。参照環境と WASM の時間であり、実機の値ではない。

## 配布物との同一性

計測に使った WASI Yosys（35,038,261 bytes、`85812d62…`）は、この VM でビルドしたものである。CI の Web 成果物にある `yosys.wasm`（35,038,277 bytes、`0c8db523…`）とは、埋め込まれたコンパイラーのパスと版表示（`0.70` と `0.70+`）だけが違う。この CI 成果物の build 入力（ビルドスクリプト・submodule・workflow）は計測 commit と同じである。

CI 版に差し替えて verdict と error を 1 回ずつ流したところ、全行・replay・failure の内容は正式 run-1 と一致した（経過時刻・binary hash・配布サイズ・log hash を除く）。log hash の差は版表示の 1 行だけに由来する。内容に差があった 33 ファイルは、この行を正規化するとすべて byte 一致した。

## 正式証拠への改変対照

`scripts/negative-sat-formal.py` で正式証拠を 100 通りに改変し、監査器がすべて非 0 で拒否することを確かめた（`{"status": "pass", "controls": 100}`）。改変の対象は、CSV 全 24 列、行の各列、replay と負の対照、metadata・plan・commands・summary・audits・snapshot、時間とメモリーの値、型、行の欠落・重複・入れ替え、判定を反転させるログ改変、error の理由・phase・終了コード、重複キーと NaN である。

## ZIPと復元後監査

`scripts/package-extra-formal.py` に `sat-formal-campaign-v1` の収録種別を追加した。ZIP には正式証拠のほか、予備計測、両方の改変対照、CI 配布物での照合、各ログを含める。13,387 files（重複除去後 882 objects）、951,744 bytes、SHA-256 は `ab8651373469fb3d08958617c3a29e8b51ae3531a912eb38755e3ac3d7f1fc50`、manifest は `4afaafcfb2ec0f4c20e9b3f32f659ad6ef1116120457408d7b7ba5cb8aec1200` である。

未作成の復元先へ全 files を戻し、保存した監査器で再監査して pass した（commit `a420942`）。

## 配布 closure と回帰

commit `a420942` で、T4/T5 の回帰と配布の制約を確かめました。

| 検査 | 結果 |
|---|---|
| `tests/sim/*.test.mjs`（`WASM_BUILD_ROOT=build`、直列） | 43 pass / 0 fail |
| `tests/web/*.test.mjs`（直列） | 351 pass / 0 fail。最初の実行は、この VM に `build/wasi/decoders` と `build/jspi-pthread/build-info.json` が無く 2 件で失敗した。資材を補って再実行した |
| `tests/synth/*.test.mjs`（直列） | 261 pass / 0 fail、約49.5分。資材を補った後の1回の実行である |
| 25 MiB 制約 | CI の Web 成果物（`toolchain-web-<sha>`）に含まれる各ファイルは 25 MiB 未満。最大は `surfer/surfer_bg.wasm` の 12,867,021 bytes |
| ソース closure | 形式検証ソース（vendor/sby・yices2・z3・boolector・bitwuzla・click、yosys・iverilog・ghdl）の gitlink と `scripts/prepare-formal-sources.py`・`licenses/` は、[S15 P0 の配布ソース照合](S15-formal-source-closure.md)（`c41e5c5`）から `a420942` まで変わっていない。S14 の監査器と単体検査もそのまま使える |
| NOTICE と license | Web 成果物の `dist/licenses/` には、`THIRD_PARTY_NOTICES.md` が参照するライセンス本文のうち 28 件（Yosys・ABC・Zstd・openFPGALoader・Emscripten 系など）が無い。完全な集合は Release の zip にだけ入る。これは本記録の範囲では未解決で、方針を決めてから直す |

回帰に使った資材のうち、この VM のスナップショットには無かったものを、CI の成果物とローカルのビルドで補いました。次のとおりです。

- Yosys の WASI 用 `share` と、zstd・xz の decoder の WASM
- nextpnr の WASM と native（`scripts/build-pnr-wasm.sh`）
- `scripts/build-synth-assets.py` が作る合成資材の manifest（zstd CLI 1.5.7 と GHDL の `libraries.tar.gz` が必要。GHDL は CI の成果物から取得）
- `scripts/build-pack-assets.sh` の出力
- `vendor/yosys/abc` をローカルでビルドした native の `yosys-abc`。CI の native binary は、この VM の glibc より新しい glibc を要求するため使えない
- `tests/fixtures/build-fs.sh` が作る 4 ボードの `.fs`
- `scripts/build-wasm.sh` でビルドした openFPGALoader の WASM。`build-info.json` を必要とするテストのために使う

`scripts/build-web.sh` が作る `dist/` は、Surfer の WASM をローカルでビルドしていないため、この VM では組み立てていません。したがって、Release の zip の組立（`scripts/package-release.sh`）と、その中の完全な license 集合の検査は、CI か Release の経路で確かめる範囲に残ります。

## 残件

- 実機の Tang Nano では試していない。
- 製品画面からの SAT 実行は、反例を「利用不可」と表示し、「反例検証済み」とは表示しない。画面での再実行層の接続と、formal 資材のオフライン同梱は後続のタスク11で扱う。
- `dist/` に完全なライセンス集合が無い件（上表）は、方針を決めたうえで別の変更として直す。
