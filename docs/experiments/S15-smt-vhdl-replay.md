# S15: SMT反例を元VHDL/PSLと下位化Verilogで独立に再実行する

## 目的と仮説

タスク54。T6 の smtbmc が残した反例を、upstream の出力とは独立した 2 経路で再実行し、同じ違反が再現できるかを測る。元 Verilog 再実行（`docs/experiments/S15-smt-verilog-replay.md`、タスク56）の VHDL 版。

- 下位化 Verilog: `chformal -cover -remove` emit 後の design を Icarus（native と WASI）で再実行し、`bindLoweredProperties` で property を対応付ける。
- 元 VHDL/PSL: GHDL native + VPI で再実行し、`run.json`/`analyze.json` の引数、違反周期、property の instance path、`formal-ghdl.vcd`、PSL report を照合する。

## 固定する条件

fixture は 16 件（assert・PSL・階層・拒否系）。採否基準は測定前に固定した。

host は Linux `6.8.0-1061-aws`、x64、2 CPU、memory 8,327,725,056 bytes。実版は Node `v24.21.0`、Python `3.12.13`、Pyodide `314.0.7`、Icarus Verilog `13.0 (stable) (v13_0)`、GHDL `6.0.0 (tarball) [Dunoon edition]`。環境変数は `LC_ALL=C`、`TZ=UTC`、`PYTHONDONTWRITEBYTECODE=1`、`PYTHONHASHSEED=0` に固定した。固定 source pin（ghdl `e589c698…`、yices2 `85cf17e4…`）と全 binary の SHA-256 は[証拠概要](S15-smt-vhdl-replay-evidence.json)にある。

## 事前の採否基準

- 受理: 元 source・model・記録 hash を保持。最初の違反周期と property 位置が元 VHDL/PSL と下位化 Verilog で一致。全 port の値が一致。独立した VCD がある。完走。
- 拒否（理由付き、成功に数えない）: 未初期化、未知値、複数 clock、非対応 memory、assert なし、空の前提。
- 上流エラー（rc 16 など）は別扱い（solver 側 tool-error 行、ログ保存）。
- native/Pyodide で記録 bytes が一致し、原本成果物は経過時刻を除いて全 bytes 一致。
- 反復の間で identity と意味的 hash が一致。

## 再実行コマンド

baseline は `node scripts/probe-upstream-formal.mjs --formal --suite vhdl-replay --solver <s> --probes build/smt-vhdl-probes.json --out <native>`、再実行は `node scripts/probe-smt-vhdl-replay-cases.mjs --formal --solver <s> --probes build/smt-vhdl-probes.json --sources <assets> --baseline <native> --out <replay>`。計測器 `scripts/measure-smt-vhdl-replay.py` が A/A 2 回 + 正式 5 回を清浄な同一 commit で流し、監査器 `scripts/audit-smt-vhdl-replay.py` が 25 列を独立再構成して照合する。

## 予備結果と失敗試行

- prove モードのエンジン log は `logfile_basecase.txt`/`logfile_induction.txt` で、bmc の `logfile.txt` と違い、probe が ENOENT で落ちた。reference にあるエンジン log をすべて保存する形に probe/監査器を直した。
- `probe-upstream-formal.mjs` は error 行があれば終了コード 1 を返す。z3 の正規エラー行（smtbmc クラッシュ 13 件）で計測器が中断したため、結果 JSON が完走している場合だけ完走として扱うよう修正した（commit `7eae7ea`）。
- 負の対照で GHDL の VCD 時刻パターン（fs 単位）が違い、時刻行の改変が見つからず失敗した。監査が実際に読む port の値行を改変対象に修正した。
- GHDL下位化では `-icells` がないと下位化 `$assert` を読めず、concurrent assume は使えず PSL コメントと `-fpsl` が必要で、違反は組み合わせ評価のため 1 周期早く出る。smt2 モデルの束縛されない合成 net は solver が任意に決めるため、内部観測は状態要素の出力名に限定した。

## 正式結果

[生CSV](S15-smt-vhdl-replay-audit.csv)は `series`・`iteration` と個別の 25 列の計 27 列で、全 1,785 行（A/A 510・正式 1,275）、SHA-256 は `62177dd23517e0f26de2b09f401920a3777472d9bff39969b48c217d4f58fcbe` である。計測器の集計結果は `status=pass` だった。行数は yices2・bitwuzla・boolector 各 79 行/回、z3 18 行/回（255 行/回）。

**z3 は採用不可**: GHDL 下位化モデルで smtbmc が `print_failed_asserts` の smtio 解析でクラッシュ（rc=16、13 FAIL 件すべて）し、counterexample を生成できない。記録は solver 側 tool-error 行として保存した。採用候補は yices2・bitwuzla・boolector。

[時間集計CSV](S15-smt-vhdl-replay-timings.csv)は 255 条件それぞれの正式 5 回の最小・中央値・最大を保存した（A/A は含まない）。参照環境と WASM の時間であり、実機 FPGA の値ではない。

## 正式証拠への改変対照

`scripts/negative-smt-vhdl-replay.py` で証拠を改変し、監査器が非 0 で拒否することを確認した。yices2・bitwuzla・boolector 各 136 件、z3 85 件の計 493 件、いずれも `{"status": "pass"}`。改変対象は source/model/VCD/testbench/capture、plan・lowered-plan、lowered 出力、GHDL plan/input、VPI 診断の時刻・行・instance、波形値、PSL report、rejection reason、型改変、launcher などである。

## ZIPと復元後監査

`scripts/package-extra-formal.py` に `smt-vhdl-replay-v1` の収録種別を追加し（commit `fd40d5e`）、ZIP `smt-vhdl-replay-formal-01.zip` は 75,724,487 bytes、74,316 files、重複除去後 11,559 objects である。SHA-256 は `b416a56df7ae1dba4acf1ad09eed1175ee100799027548ad19e304d139e2541c`、manifest は `06bb714ecacb8bae154c352b84a9898cb3469c87fb73fff40e98ec6f670c19d8`。

未作成の復元先へ全 74,316 files を戻し、保存した監査器による再監査でも pass（commit `7eae7ea`）した。

## 残件

- 実機の Tang Nano では試していない。
- z3 の smtbmc クラッシュは未対応（候補から除外）。
- 画面接続（結果と VCD/Surfer の表示）は後続のタスク33 P5。
