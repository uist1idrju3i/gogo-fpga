# 形式検証の候補と有効化条件

[調査の索引](../../RESEARCH.md#7-分割した調査) / [固定ソースと配布条件](formal-sources.md) / [ビルドと実行方式](formal-solvers.md)

## 一覧の目的と現在の範囲

上流が認識する選択肢を隠さず、検査経路での動作と製品での利用を区別します。`web/lib/formal-capabilities.mjs` は候補、確認状態、阻害要因、日本語の無効理由を保持します。候補を持つだけでは、バイナリーの配布や実行を許可しません。画面への表示はまだ未接続です。

SMTBMCの9選択肢は、固定した[Yosysのsmtio.py](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/backends/smt2/smtio.py#L197-L278)の分岐から確認しました。SBYの6エンジンと各modeは、固定した[SBYのmode dispatch](https://github.com/YosysHQ/sby/tree/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/sbysrc)を原典とします。`--help`のsolver一覧にはABCが載っていないため、helpの文言だけでは網羅できません。

## SMTBMCの全選択肢

| 上流名 | 製品側ID / 起動名 | 現在の状態と採否 |
|---|---|---|
| yices | `yices2` / `yices-smt2` | 原本SBY・SMTBMCとnative/WASIの反復検証済み。製品資材の準備と画面接続は残件 |
| z3 | `z3` / `z3` | 原本SBY・SMTBMCとnative/WASIの反復検証済み。製品資材の準備と画面接続は残件 |
| bitwuzla | `bitwuzla` / `bitwuzla` | 診断native/WASI・help・原本SMTBMC/SBYの正式反復を照合済み。製品資材・依存の配布条件・製品認定が未確認のため無効 |
| boolector | `boolector` / `boolector` | 診断native/WASI・終了10/20・原本SMTBMC/SBYの正式反復を照合済み。製品資材・依存の配布条件・製品認定が未確認で、保守終了のため無効。推奨既定にはしない |
| cvc4 | `cvc4` / `cvc4` | ソース未固定、配布条件・ビルド・process接続が未確認のため無効 |
| cvc5 | `cvc5` / `cvc5` | ソース未固定、配布条件・ビルド・process接続が未確認のため無効 |
| mathsat | `mathsat` / `mathsat` | ソース未固定、配布条件・ビルド・process接続が未確認のため無効 |
| abc | `abc` / `yosys-abc` | `-S`による独立process接続と形式検証の実行が未確認のため無効。合成内のABC利用とは別 |
| dummy | `dummy` / 起動なし | 記録済み応答を読む検査用backend。実solverで証明したものではなく、証明用には有効化しない |

Yices2とZ3の根拠は、[CLIの正式比較](../experiments/S15-solver-native-wasi.md)、[SBY全体の正式反復](../experiments/S15-sby-repeated.md)、[異常時の対照と全列監査](../experiments/S15-sby-controls.md)です。限定した入力・深さ・profileの検査であり、あらゆる回路での正しさを保証するものではありません。

## SBYエンジンと内蔵SAT

ここでSBYのmodeは上流がdispatchする組合せです。未接続のエンジンが動くことを確認した一覧ではありません。

| エンジン | 上流のmode | 現在の扱い |
|---|---|---|
| smtbmc | bmc / prove / cover | 検査経路で接続済み。検証済みsolverも必要。初期実装は単一slot |
| abc | bmc / prove | SBYの外部engine接続は未実装。SMTBMCのABC選択肢とも別 |
| aiger | bmc / prove / live | 外部engine接続は未実装 |
| btor | bmc / prove / cover | 外部engine接続は未実装 |
| itp | bmc / prove | `itp-bmc`の固定資材とprocess接続は未実装 |
| none | bmc / prove / cover / live | モデル生成用。証明用エンジンとして有効化しない |
| Yosys SAT | bmc / prove | SBYとは別の内蔵SAT比較経路。coverは扱わない |

AIGER・BTORの[witness変換試験](../experiments/S15-sby-witness.md)は形式変換の境界を調べたものです。外部engineの実行や、元回路での反例検証に昇格しません。内蔵SATの範囲は[性質の保持と反例の独立再実行](formal-verification.md)に記録しています。

## BitwuzlaとBoolectorで残る境界

[原本SMTBMC/SBYの追加候補接続](../experiments/S15-extra-solver-smtbmc.md)では、help取得と実際の終了codeを仮想processへ接続しています。予備比較は正式な適合性認定ではなく、両候補は無効のままです。PATH上の別のnative solverへ到達した初期試行は除外し、解決先とhashの検査を必須にしました。

[独立監査と反復](../experiments/S15-extra-formal-audit.md)は、追加候補を明示したときだけ条件集合を切り替え、従来のYices2/Z3の行数・全列検査を維持します。清浄な同一commitで正式5回・A/A 2回の全420行、改変対照20件、証拠ZIPの全38,413ファイルの復元後監査が通りました。予備28条件の監査と今回の正式結果、製品認定は別に扱います。catalogは古い未ビルド・help未接続という理由を訂正し、両候補を `product-unqualified` として全modeで無効にします。資材が存在すると申告されても有効化しません。

[BitwuzlaのMeson診断](../experiments/S15-bitwuzla-build.md)は、上流wrapの固定依存とWASI境界を記録します。整数幅と終了境界を修正し、清浄なnative/WASIで[CLI正式5回・A/A 2回の全203行14列](../experiments/S15-bitwuzla-cli-qualification.md)を独立に監査しました。今回の原本SMTBMC/SBYの限定認定とは別の段階であり、いずれも製品での有効化を許可しません。

Bitwuzla本体の固定版[COPYING](https://github.com/bitwuzla/bitwuzla/blob/8d1eb01093ae54d9b4586456b69c3bf31000a4c2/COPYING)とBoolector本体の固定版[COPYING](https://github.com/Boolector/boolector/blob/393cdfba3735d334bb4e6525500b8a0280dd41e6/COPYING)はMITです。本体の条件だけで、依存を含むバイナリーを配布可能とは判定しません。

- BitwuzlaはGMP 6.3以上、MPFR 4.2.1以上、SymFPUとSAT backendを必要とします。既定はCaDiCaLで、Meson 0.64以上、C++17を要求します。wrapの取得先・固定revision・archive hashは[依存の原記録](formal-sources.md#ビルドprofileと無効な依存)からたどれます。別の固定値を能力一覧のコードへ複製しません。
- 原本SMTIOはBitwuzlaの`--help`を`subprocess.check_output`で読み、`--lang`の有無に応じてCLI引数を選びます。通常のstdin/stdout接続だけでは、この事前起動を扱えません。追加のprocess別名で実WASIのhelpを渡し、引数の選択は上流に任せる接続を正式反復でも検査しました。
- BoolectorはBTOR2ToolsとSAT backendが必要です。btor2tools、CaDiCaL、Lingelingのsetup指定も[依存の原記録](formal-sources.md#ビルドprofileと無効な依存)に保持します。固定版の[NEWS](https://github.com/Boolector/boolector/blob/393cdfba3735d334bb4e6525500b8a0280dd41e6/NEWS#L1-L5)は最終リリース・保守終了・Bitwuzlaへの継承を明記しています。
- 原本SMTIOはBoolectorやABC等のsolver内timeout指定を拒否する場合があります。候補一覧はこの制限を消さず、workerの外部期限・取消とは別に扱います。

両候補のnative/WASI診断ビルド、実応答比較、正式反復、依存とlicenseのclosureは未実施です。追加のSAT backend、mimalloc、実験的機能も採用していません。検証と配布条件が揃うまで無効を維持します。Yices2とZ3を含め、製品の推奨既定はこの一覧の追加では決めません。

## 有効化の条件と回帰検査

`formalCapabilities` は、候補を残したまま `disabled` と `reason` を返します。既定では全て無効です。候補の確認状態、mode、呼出側が申告する利用可能資材を別々に検査し、SBY/SMTBMCには利用できる検証済みsolverも要求します。資材のIDを渡しただけで、未検証候補やdummy、noneが有効になることはありません。内蔵SATとSBY、SMTBMCのsolverの名前空間は分けます。

これは表示用の能力判定です。資材IDの申告は暗号学的な検証ではなく、worker起動時のmanifest・binary hash・輸送・終了状態の検査を代替しません。画面側の接続では、実際に準備した資材だけを渡す必要があります。

`tests/check-solver-protocol/test_capabilities.py` は親リポジトリーのgitlinkから原本を読み、Python ASTでSMTの全分岐・起動名とSBYの全mode分岐を照合します。実行中のupstream checkoutの変更やhelpだけに依存せず、動的で解析不能な選択肢も失敗にします。`agent-docs`は、この照合用にリポジトリーの `.nvmrc` に従うNodeを準備します。バージョンを別に固定しません。

`tests/web/formal-capabilities.test.mjs` は候補の可視性、資材未準備、未検証候補への偽の資材申告、mode、SMTBMCのsolver不足、未知ID・別名・重複、canonical dataの変更拒否を検査します。

```sh
node --test tests/web/formal-capabilities.test.mjs
python3 -m unittest discover -s tests/check-solver-protocol -p test_capabilities.py -v
```

この変更ではソルバーや上流のproof semanticsを変更せず、WASMやPython実行資材も追加しません。元回路でのSMT反例検証、schema・保存形式、製品の画面・配布・全体反復は残件です。実機のTang Nanoでは本リポジトリで試していません。
