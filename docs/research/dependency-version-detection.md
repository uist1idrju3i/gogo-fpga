# 依存の版を誤検出しないための修正

[調査の索引](../../RESEARCH.md#7-分割した調査)

## 見つかった問題と採用した方法

固定した依存そのものは変更せず、`.github/scripts/check-pins.py` の更新検知を修正しました。

| 対象 | 以前の問題 | 修正と境界 |
|---|---|---|
| GHDL | 汎用の数値比較が日付タグ `20181129` を `v6.0.0` より新しい版として選ぶ | `v<major>.<minor>.<patch>` に完全一致する公開安定タグを選ぶ。固定commitに対応するタグの判定にも同じ条件を使う |
| 形式検証のsolverとClick | 日付・実験・競技用のタグを版と誤認する | 固定ソースの検査と同じreleaseタグ形式を使い、固定版と最新版の両方を判定する |
| Rust | stable channelの最初の `version` を読むため、先に現れるCargoをRustと誤認する | 標準ライブラリーの `tomllib` でTOMLを解析し、`pkg.rust.version` を読む。commit・日付の付記を検査してから版の数値を比較する |

GHDLのdate、weekly、dev、rc、alpha、betaタグを除外します。XZ Embeddedなど、日付を正式な版に使う依存の比較は維持します。注釈付きタグの `^{}` からcommitを得る処理も維持しています。タグ形式が変わった場合は、形式を調査してから対応します。安定タグがない場合は成功扱いにせず「要確認」とします。

RustはTOMLのtableの並び順に依存しません。構文不正、必須keyの欠落、文字列でない値、版として不正な文字列を拒否します。Cargoしか存在しない文書からRustの版を推測しません。取得結果が壊れた場合はupstream reportにも「要確認」を残します。`tomllib` のため、実行環境はPython 3.11以降が必要です。CIのUbuntu 26.04と、GHDL用の隔離環境はこの条件を満たします。

## 原典と保存した入力の確認

- [GHDLのタグ](https://github.com/ghdl/ghdl/tags)。取得元は `.gitmodules` の `vendor/ghdl` を正とし、`git ls-remote --tags` の結果を読みました。
- [Rust stable channel TOML](https://static.rust-lang.org/dist/channel-rust-stable.toml)。CargoとRustは別のpackageとして記録されています。
- [Pythonのtomllib](https://docs.python.org/3/library/tomllib.html)。外部依存を追加せずにTOMLを解析します。

同じ保存入力を修正前後の選択関数へ渡しました。GHDLは修正前が `20181129`、修正後が `v6.0.0` です。Rustの構造化読取りは `1.99.1` を得ました。これは取得時の入力の確認であり、依存をその版へ更新した記録ではありません。

| 保存した入力 | SHA-256 |
|---|---|
| GHDL remote tags | `c8aedb96a94a31ca6fd3ef62d9195db857d7eb5b1c6ad483427779c69d0f0485` |
| Rust stable channel TOML | `fb152be80975c194aa5fc684b2aec3a6e14e2b855efe2faa4e5f8ae6e590f463` |

## 回帰と負の対照

`tests/check-pins/test_check_pins.py` に、GHDLのrelease以外のタグ、stable tagがない入力、Rust/Cargoのtable入替、欠落、不正な型・構文・版、reportへの非成功状態の伝搬を追加しました。既存の全依存と日付タグのテストも残します。

```sh
sh tests/check-pins/run.sh
python3 .github/scripts/check-pins.py consistency
```

これらは更新検知の検査です。全依存の更新後ビルド、CIの監視、最新major・廃止予定・runnerなどの網羅的な監査は別途行います。

## Issue #21のsolver通知を再確認

[Issue #21](https://github.com/uist1idrju3i/gogo-fpga/issues/21)の通知を受け、2026-11-16に公式の `git ls-remote --tags` を取得しました。従来の検出器は、rcなどを含まないタグから数値を探し、最大値を選んでいました。そのため、日付や競技の年をreleaseの版より大きいと判定しました。

| 依存 | 固定版 | 通知に出たタグ | 正式なrelease形式の最新タグ | 判定 |
|---|---|---|---|---|
| Yices2 | `yices-2.7.0` | `2021-02-19` | `yices-2.7.0` | 誤検出。固定版が最新 |
| Z3 | `z3-5.3.3` | `bisim-study-smart-20260926` | `z3-5.4.1` | 更新候補あり。通知のタグを訂正 |
| Boolector | `3.2.4` | `smtcomp-2018` | `3.2.4` | 誤検出。固定版が最新 |
| Bitwuzla | `0.9.1` | `smtcomp-2021` | `0.10.0` | 更新候補あり。通知のタグを訂正 |

Yices2は `yices-X.Y.Z`、Z3は `z3-X.Y.Z`、Boolector・Bitwuzla・Clickは `X.Y.Z` に完全一致するタグだけを使います。`parse_formal_pins` と `is_stable_tag` は同じ形式を参照します。これはタグ名を選ぶ条件であり、ビルド・製品認定の成功を意味しません。SBYのbranch先端の監視は維持します。

### 保存した原入力と再確認

取得元は `.gitmodules` と `RESEARCH.md` のpin表を正とします。原入力にはタグのオブジェクトと `^{}` のcommit参照をそのまま保存しました。

| 依存と原入力 | upstream | SHA-256 |
|---|---|---|
| [Yices2](evidence/issue21-solver-tags/yices2.txt) | https://github.com/SRI-CSL/yices2.git | `42a2562a951524b9e5bb3bcdae95c5427d4c317d10a81e0ee49046f2493b9930` |
| [Z3](evidence/issue21-solver-tags/z3.txt) | https://github.com/Z3Prover/z3.git | `6adba1990b2d813c4b39225b20fdf45e1c7cf11d8d3ac7eb0ec1d6c0f8f4db70` |
| [Boolector](evidence/issue21-solver-tags/boolector.txt) | https://github.com/Boolector/boolector.git | `2aff9375350bab1d22f2d041be983521a19e1f307979a9a640b8b01b79bcc55e` |
| [Bitwuzla](evidence/issue21-solver-tags/bitwuzla.txt) | https://github.com/bitwuzla/bitwuzla.git | `c4167b3e63183a27556902ca3d0f7f84284dbbed301e4dbb3abd1aa9c82195ba` |

同じ入力で修正前後を比較するには、各原入力を `latest_stable_tag(text, dependency)` に渡します。修正前は通知の列、修正後は正式なrelease形式の列になります。回帰試験では、実際の誤検出タグ、dev・rc・alpha・beta、注釈付きタグ、固定commitに同名以外のタグが付く場合、正しい更新の保持、安定タグがない場合の「要確認」を検査します。

### 更新の進め方と未確認範囲

今回の修正では依存の固定値を変更しません。Z3とBitwuzlaの候補は、間にある全変更履歴、ライセンス、WASIパッチ、製品認定への影響を調べてから別の変更として扱います。その他の依存の通知も、各upstreamと照合して採否を判断します。Yices2が最新でも他の更新候補が残るため、このIssue全体は完了扱いにしません。実機Tang Nanoは本リポジトリでは試していません。
