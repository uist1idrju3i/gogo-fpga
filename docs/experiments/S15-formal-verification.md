# S15 形式検証の事前基準

- 状態: 計画。ソルバーのビルド・証明・反復測定は未実施
- 日付: 2026-11-02（日本時間）
- 担当: Devin
- 関連: [形式検証の調査](../research/formal-verification.md)、[固定ソースと依存](../research/formal-sources.md)、[実験索引](README.md)

## 目的と仮説

上流の SymbiYosys（SBY）、`yosys-smtbmc`、Yices2、Z3 を再利用し、利用者の設計を外部へ送らずに、小回路の BMC・帰納法・cover を実行できるかを確かめます。既存の Yosys SAT も比較しますが、SMT 経路の代わりにしません。Bitwuzla と Boolector は候補に残し、実行の証拠なしには有効にしません。

この文書は、最初の形式検証実験より前の基準です。結果や正式測定の commit は、試行ごとの記録と生 CSV へ追加します。実装途中の診断試行を、完成したブラウザー機能や正式な性能測定とは扱いません。

## 採否の基準（結果を見る前に固定）

| 検査 | 必須の基準 |
|---|---|
| 正常・違反の判定 | 下記の全入力で、native と WASM の判定が一致すること |
| property 保持 | 合成前後の対象数と ID を照合すること。0個、途中で消えた assertion、矛盾した assume は非成功 |
| 深さ | 最初の違反が深さ N の入力で、N-1 の BMC を無制限の証明と表示しないこと |
| 帰納法 | 基底部と帰納部の結果を区別すること。片方だけの成功を prove 成功にしないこと |
| 反例 | 固定入力、clock/reset、property、初期状態を保持し、元の回路で違反を独立に再実行できること |
| cover | 到達、指定深さで未到達、到達不能の証明を区別すること |
| 異常 | unknown・timeout・cancel・error・unsupported を成功から除外すること |
| 証拠 | exit code、stdout/stderr、status、witness、入力と資材の hash が整合すること |
| 配布 | 各配信ファイル25 MiB未満、全 hash 一致、ライセンス原文と対応ソースを照合できること |
| 回帰 | T4 の simulation・VCD と T5 の library closure・ZIP・合成経路を壊さないこと |

SAT のモデルには複数の解があるため、異なるソルバーの VCD のバイト一致は要求しません。制約・判定・違反の意味と再実行結果を比較します。独立した証明書検査器の検証を行ったとは主張しません。

初期の資源予算は、形式ジョブ1個、既定30秒、設定上限300秒、ソルバーの linear memory 上限512 MiB、テキストログ8 MiB、trace64 MiBです。Python・Yosys・ソルバーの合計も別に測ります。これらは実測値ではありません。予算超過は resource-limit とし、上限を黙って広げたり、失敗した条件を除いて採用したりしません。構成の変更が必要なら、理由と変更後の基準を試行前に記録します。

## 条件

| 項目 | 固定する値・記録方法 |
|---|---|
| 事前基準 | 本書を追加した commit と、以後の変更理由を試行記録へ保存 |
| 基準の commit | 清浄な実行対象 commit を試行 manifest へ保存。作業中の差分を含めない |
| ホスト | OS、CPU 数、物理メモリー、負荷、並行実行の有無を実行時に保存 |
| ツール | 実際の native/WASM、Node.js、Chromium、compiler、SDK の版と SHA-256 |
| 固定ソース | RESEARCH の pin、gitlink、`git submodule status`、適用パッチと前後の hash |
| 入出力 | HDL・property・library・SMT・設定・出力の byte/hash、clock/reset、property ID |
| 出力先 | `build/S15/<trial-id>/`。既存の試行・CSV・ログは上書きしない |
| 再利用 | 新規ビルドか既存資材かを区別し、既存なら元の commit と binary hash を保存 |
| 変える条件 | engine、ソルバー、native/WASM、輸送方式、fixture、深さ、正常/異常 |
| 変えない条件 | 比較する HDL、property、library closure、深さ、初期状態、資源制限 |
| 正式な反復 | 条件ごとに native/WASM 各5回以上。各回で交互に実行 |

## 入力と独立検査

1. 組合せの恒等式と、期待値を1か所壊した性質。
2. reset 付きカウンターの BMC と帰納法。誤った reset/clock も含めます。
3. 深さ N で初めて違反する回路を、N-1・N・N+1 で検査します。
4. 小さな RAM、ROM 初期値、動的な入力を含む回路。
5. 同じ性質を持つ VHDL と Verilog。VHDL plain assertion と PSL、形式用の限定 Verilog 構文を分けます。
6. T5 の選択済み library を含む小回路。library 名、順序、include、data を保持します。

Verilog の反例は Icarus、VHDL は native GHDL と下位化後の回路で再実行します。再実行できない trace は検証済みと表示しません。小回路の成功を CPU 全体の ISA 正当性や、配置配線後の実機動作の証明とは扱いません。

## 計測器と負の対照

本試行の前に同じ条件2回の A/A と、期待値を壊した負の対照を通します。時間の値が0や全条件同値になる場合は、計測器を調べてから正式測定へ進みます。

必須の異常入力は、0 property、消えた assertion、矛盾した assume、誤った reset/clock、未対応構文、unknown、timeout、cancel、solver crash、不正な status、欠けた witness、壊れた WASM、hash 不一致です。pipe では分割 read/write、長い入力と応答、stdout/stderr の分離、EOF、閉じた process への write、cancel 後の遅い応答を試します。禁止コマンドとパス逸脱も実行前に拒否させます。

ZIP/OPFS では `.sby`、`.ys`、property、include、data、順序、設定を往復し、schema 1〜3 の互換性、schema 4 を旧版が誤って保存しないことを検査します。実行開始後の編集、project 切り替え、cancel、再実行で、古い応答が新しい結果を上書きしないことも確認します。

## 実行とログ

実行器はリポジトリ内に置き、入力・条件・出力先を引数にします。具体的なコマンド、環境変数、base commit、binary hash、試行順は、その実行器を追加した試行記録へ保存します。実行中のスクリプト・入力・バイナリーは変更しません。重い反復は CI に追加しません。

生 CSV は trial ID、commit、binary/input hash、engine、solver、mode、bound、実行系、反復、期待判定、実判定、status、exit code、時間、WASM memory、配布量、witness/replay の結果、ログ hash を含めます。status を含む全列を監査してから、最小・中央値・最大を集計します。起動・解析・solver の時間とビルド時間を分け、timeout・error・cancel・unsupported・負の対照は正常系の性能標本へ混ぜません。

失敗・中止した試行も原本入力、SMT、stdout/stderr、status、witness/VCD、hash 目録とともに保存します。大ログは一時ディレクトリーだけに置かず、hash と再生成コマンドを記録します。CSV は1ファイル1 MB以下を目安に分けます。出力先を削除する前に証拠を別の保存先へ写して照合します。

## 結果と未確認の範囲

[P0の配布ソース照合](S15-formal-source-closure.md)は別に記録しました。形式検証の実行結果とは区別します。

P1の[Yosys SAT反例の独立再実行](S15-formal-replay.md)は、限定した診断経路として実装中です。本書を追加したP0では未実施だった検査と、その後の診断試行を区別します。SMTソルバーのWASMビルド、双方向輸送、SBY/SMTBMCの原本実行、正式な5回反復は未実施です。初回完全offline起動は別の実験です。画面操作・録画も本書で承認済みとはせず、Tang Nanoの実機確認とCloudflare Pages公開は実施しません。
