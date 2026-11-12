# 依存の版を誤検出しないための修正

[調査の索引](../../RESEARCH.md#7-分割した調査)

## 見つかった問題と採用した方法

固定した依存そのものは変更せず、`.github/scripts/check-pins.py` の更新検知を修正しました。

| 対象 | 以前の問題 | 修正と境界 |
|---|---|---|
| GHDL | 汎用の数値比較が日付タグ `20181129` を `v6.0.0` より新しい版として選ぶ | GHDLだけは `v<major>.<minor>.<patch>` に完全一致する公開安定タグを選ぶ。固定commitに対応するタグの判定にも同じ条件を使う |
| Rust | stable channelの最初の `version` を読むため、先に現れるCargoをRustと誤認する | 標準ライブラリーの `tomllib` でTOMLを解析し、`pkg.rust.version` を読む。commit・日付の付記を検査してから版の数値を比較する |

GHDLのdate、weekly、dev、rc、alpha、betaタグを除外します。既存の他の依存が使う日付タグは除外しません。注釈付きタグの `^{}` からcommitを得る処理も維持しています。GHDLが今後タグ形式を変更した場合、形式を調査してから対応します。安定タグがない場合は成功扱いにせず「要確認」とします。

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
