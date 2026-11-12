# S15 P1: 元VHDLと下位化Verilogの反例比較

## 目的と事前基準

[元VHDLの独立再実行](S15-vhdl-native-replay.md)に続き、GHDLの形式Verilog出力を上流Yosysで下位化し、Icarusのnative/WASMでもSAT反例を再実行します。基準は`1408b5156cbce2c39d3939f05fc8162c10b0e62e`です。これは検査用の経路であり、ブラウザー製品の形式検証画面ではありません。HDLをサーバーに送る製品機能も加えません。

GHDL native/WASMのVerilogを全バイト比較し、それぞれをYosys native/WASIへ渡します。この4通りの各反例を、変更していない元VHDLと、下位化後のVerilogで検査します。正式反復は清浄な同一commitで5回とA/Aの2回とし、全ポートの値・方向・幅、propertyの最初の違反周期、全診断、VCD、終了状態を調べます。壊した出力・propertyの結び付け・状態・ポートと、欠落・重複・途中で切れたCSVを拒否することも採否の条件です。速度の優劣は判定しません。

## 上流の再利用と照合範囲

VHDLとPSLのparser、monitor生成、runtime、VPI、PSLレポートはGHDLを再利用します。名前付きライブラリーも上流の解析処理を使い、独自のVHDL/PSL parserは作りません。元VHDLの依存ファイルは明示したライブラリーへ先に解析し、トップの元ファイルを変更せずに再実行します。

Yosysの`proc`、`flatten`、`chformal -lower`、`chformal -cover -remove`と`write_verilog`を再利用します。coverを除くのはIcarusのassertion再実行モデルだけです。元VHDL側のcover一覧、activation coverの種類と、GHDLのPSLレポートは保持します。coverを削除したモデルで到達性を判定しません。

propertyは列挙順ではなくkindとA/ENの接続別名で一意に結び付けます。元ソースのラベル・行・列と、出力Verilogの物理的な位置は分けて保存します。欠落・余剰・曖昧な結び付けを拒否し、ポートと状態の一覧も照合します。状態は、Yosysの準備後のモデルと再読込したVerilogを比較し、各状態bitの別名・幅・初期値とclock極性を調べます。最適化前だけに存在する未使用monitor bitまで残るとは主張しません。

GHDLはpredicateがfalseのままでも入力変化などで再診断することがあり、Icarusの`$assert`は変化時だけ診断することがあります。生ログの診断数を合わせて削らず、propertyごとの最初の違反を比較し、Icarusの各違反が元VHDLの同じproperty・source・周期に存在することを要求します。GHDL側の独立VCD検査と全ポート照合、Icarus native/WASMの標準出力・標準エラー・VCDの全バイト比較も維持します。有限の反例の一致であり、任意のdelta cycleや全入力列の等価性の証明ではありません。

通常assertionの入力切替時刻の曖昧さは、Yosys JSONのA/ENから入力依存を追って調べます。状態境界は`$dff`で止め、多重driver、未駆動、未知のbit、組合せ循環、不明な方向、未対応state cellを拒否します。無関係な入力だけの切替を、property違反の曖昧さへ誤分類しません。

## fixtureと制約

| ケース | 確認する範囲 |
|---|---|
| plain-depth4 / plain-depth5 | 通常assertionと反例の深さ |
| plain-negedge | falling edge |
| initial-nonzero | 既知の非ゼロ初期値 |
| synchronous-reset | 同期resetの駆動と観測 |
| multiple-properties | 異なる周期で違反する複数property |
| named-library | arithmeticライブラリーのpackage/bodyと関数を元VHDLでも解析 |
| hierarchy | leaf entityの状態とtopのbit条件、階層を下位化した後の照合 |
| psl-depth4 | clocked assert、assume、明示したcover |
| psl-activation | implicationとactivation cover |

境界の5ケースは、成功したassertion再実行の件数に含めません。

| ケース | 期待する結果と未対応理由 |
|---|---|
| unknown-initial | SAT反例は得ても、Xを含む初期値の独立再実行を拒否 |
| unconstrained-initial | SAT反例は得ても、未初期化状態の独立再実行を拒否 |
| combinational-loop | `check -assert`で準備段階に失敗。前提矛盾へ誤分類しない |
| memory | 未対応の`$mem` stateとして拒否。memory一般の検証済みとはしない |
| vacuous-activation | 有界範囲で違反なし。activation coverは残すが、到達したとは扱わない |

階層fixtureは任意の階層・演算・PSLの完全対応を意味しません。数値演算を含む一部の診断はprocess footerが別のソースを指すため拒否する制約を、[失敗記録](S15-vhdl-lowered-failures.md)に残します。

## 証拠と再実行

実装は`tests/synth/formal-vhdl-lowered.test.mjs`と`tests/synth/ghdl-lowered-replay.mjs`、監査は`scripts/audit-lowered-replay.mjs`です。必要な資材は既存の製品用GHDL native/WASM、Yosys native/WASI、Icarus native/WASMです。VPIプラグインだけを各回で作り直します。GHDLの固定版・ビルド方法は[前層の環境](S15-vhdl-native-replay.md#固定した環境)と同じです。

```sh
GHDL_WASM_BUILD_ROOT=build/S15/vhdl-formal-build4 \
  node --test --test-concurrency=1 tests/synth/formal-vhdl-lowered.test.mjs \
  tests/synth/ghdl-lowered-replay.test.mjs tests/synth/ghdl-replay.test.mjs
node scripts/audit-lowered-replay.mjs --sample build/S15/p1-vhdl-lowered-SAMPLE \
  --out build/S15/p1-vhdl-lowered-audit
```

出力先は毎回新規作成し、既存のCSVを上書きしません。`--sample`は複数回指定できます。正式検査では未コミットの変更を拒否します。`--preliminary`は予備検査専用です。

各回のCSVは60行20列です。成功の10ケース×4経路が40行、境界の5ケース×4経路が20行です。各成功行に元VHDL、Icarus native/WASM、壊した出力の終了状態とhashを全て記録します。`elapsedMs`は元VHDLの解析・実行とIcarusの2実行の合計であり、GHDL/Yosys合成全体の時間ではありません。境界行の時間は測定せず`not-measured`と記録します。標準出力・標準エラー・VCDのhash配列は、この4実行の順です。

監査はCSVを再解析し、全ての値を元のログ・JSON・Verilog・VCDと照合します。GHDL/Icarusの検査とpropertyの結び付けも再実行します。manifestにはrevision、作業tree、実行環境・ツールの版、binary/source hash、submodule一覧、GHDL build manifestと全証拠ファイルのhashを保存します。元の通常合成用GHDL資材と形式出力用資材を取り違えた場合も停止します。

T6 P2以降のソルバー、SBY/SMTBMC transport、形式検証のworker/UI、製品版の反復と配布閉包は別の残件です。Tang Nano実機は本リポジトリでは試していません。

## 正式反復とA/A

正式反復の基準は`6c502038eaf71554f8a2da68efb1e7a9bf3bf901`です。各回のmanifestと監査器で未コミット差分がないことを確認しました。固定済みのGHDL・Yosys・Icarusを作り直さず再利用し、VPIプラグインだけを作り直しました。69件の検査を5回とA/Aの2回実行し、全7回が成功しました。

各回60行20列のCSVを監査器で生ログから作り直して照合し、合計420行・8,400値を確認しました。[統合した生CSV](S15-vhdl-lowered-results.csv)は、元の20列に試行名の`sample`列を付けた21列です。[監査結果](S15-vhdl-lowered-audit.json)には各CSV、manifest、ソース、バイナリーのhashと実際の版、ホスト情報を残しています。

| 試行 | 検査 | 比較成功 | 初期値を理由に再実行拒否 | 準備・memory非対応 | 有界内に違反なし | 所要時間の中央値 / 最小 / 最大（ms） |
|---|---:|---:|---:|---:|---:|---|
| repeat1 | 69/69 | 40 | 8 | 8 | 4 | 70.21 / 62.64 / 153.69 |
| repeat2 | 69/69 | 40 | 8 | 8 | 4 | 70.62 / 62.82 / 117.35 |
| repeat3 | 69/69 | 40 | 8 | 8 | 4 | 69.49 / 60.64 / 121.32 |
| repeat4 | 69/69 | 40 | 8 | 8 | 4 | 71.15 / 64.57 / 145.39 |
| repeat5 | 69/69 | 40 | 8 | 8 | 4 | 77.16 / 63.04 / 136.92 |
| aa1 | 69/69 | 40 | 8 | 8 | 4 | 74.82 / 65.59 / 142.96 |
| aa2 | 69/69 | 40 | 8 | 8 | 4 | 69.47 / 61.95 / 130.36 |

時間は比較成功40行のGHDL、Icarus native/WASMの実行時間を行ごとに足した値です。ホストは2論理CPUのIntel Xeon、メモリー8,327,749,632バイト、Docker内のOS表示はUbuntu 26.04.1 LTSです。Node.js v24.21.0、GHDL 6.0.0（GNAT 14.3.0、mcode）、GCC 15.2.0、Yosys 0.70、Icarus 13.0を実際の出力で確認しました。速度設定の比較実験ではありません。

A/Aを含む7回の全列を比較し、所要時間とGHDL VCDの日時を含むhash以外は一致しました。GHDLの生VCDは書き換えず保持し、各回の独立したVCD検査で値・時刻・ポートを照合しています。Icarus native/WASMのstdout・stderr・VCDは、各行の実行系間と反復間で全バイト一致しました。GHDLとIcarusの診断回数は上記の理由で別に保持し、最初の違反を比べます。

生CSVのSHA-256は`740c6b9296134ed714ac99b110f579c4995a64d504b5f0bd25128f423ca7970d`です。予備・失敗試行も含む62,590ファイルの[hash目録](S15-vhdl-lowered-evidence.sha256)を保存しました。証拠ZIPは56,226,639バイト、SHA-256は`7afc0638d9349a591fdbeb30f027dcab2738a96ec527f4e6a86abb5c2e1eeeb1`です。大きなログとバイナリーはコミットせず、ZIPをセッションで共有します。

## ライセンスと配布

この層は自作の検査補助コードとfixtureを加え、外部コードや新しい依存を取り込みません。GHDL、Yosys、Icarusは既存の固定ソース・原文ライセンス・配布条件を再利用します。`vendor/`と`third_party/`を直接変更せず、製品へのnativeプラグイン同梱も加えません。形式出力のGHDLパッチの配布・ソース閉包は[前層の記録](S15-vhdl-formal.md)と[固定ソースの条件](../research/formal-sources.md)を参照してください。
