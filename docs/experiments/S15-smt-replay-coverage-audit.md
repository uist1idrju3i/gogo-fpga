# S15: SMT反例の独立再実行の言語横断監査

タスク46。元Verilog再実行（タスク56）と元VHDL/PSL・下位化Verilog再実行（タスク54）の2つの子工程をまとめ、反例として再実行できる trace の範囲を一覧にします。再実行できない trace を「反例検証済み」としない境界が守られているかを、記録・分類・実装の3面から監査しました。

## 監査の方法

両記録の主張（行数・列数・SHA-256・ZIP容量）を手元の証拠へ再計算して照合し、生CSVの全行で `expected`（期待区分）と `actual`（実区分）が一致して verified の行が再実行可能な case に限定されることを数えます。あわせて、再実行層 `web/lib/formal-replay.mjs` の受理条件と製品側の表示・有効化の状態を読み、対象外の trace が検証済みに見えないことを確かめました。

## 完了の確認

| 子工程 | 提出 | 証拠 |
|---|---|---|
| タスク56（元Verilog） | PR #77（旧toolchainリポジトリーの pull/77） merge済み | `replay.csv` 1,484行・SHA-256 `b1352a19…ea484`、ZIP 69,870,106 bytes・96,592 files・`256fbabf…fce1` |
| タスク54（元VHDL/PSL・下位化Verilog） | PR #78（旧toolchainリポジトリーの pull/78）・#79（旧toolchainリポジトリーの pull/79）・#80（旧toolchainリポジトリーの pull/80） merge済み | `replay.csv` 1,785行・SHA-256 `62177dd2…fcbe`、ZIP 75,724,487 bytes・74,316 files・`b416a56d…541c` |

照合は、証拠ZIPの bytes・SHA-256 と生CSVの行数・SHA-256 が、各記録（[Verilog版](S15-smt-verilog-replay.md)・[VHDL版](S15-smt-vhdl-replay.md)）の記載と一致することを確認したものです。

## 反例再実行の網羅表

製品が扱う反例の由来と、それぞれの再実行経路・検証の状態です。

| trace の由来 | 再実行経路 | 検証の記録 | 状態 |
|---|---|---|---|
| smtbmc FAIL・元Verilog | `createSmtReplay` → Icarus native/WASM | [S15-smt-verilog-replay](S15-smt-verilog-replay.md) | 正式5回・A/A 2回完了 |
| smtbmc FAIL・元VHDL/PSL | `createSmtReplay` → GHDL native + VPI | [S15-smt-vhdl-replay](S15-smt-vhdl-replay.md)（先行するP1: [S15-vhdl-native-replay](S15-vhdl-native-replay.md)） | 正式5回・A/A 2回完了 |
| smtbmc FAIL・下位化Verilog | `createSmtReplay` → Icarus native/WASM | 同上（先行するP1: [S15-vhdl-lowered-replay](S15-vhdl-lowered-replay.md)） | 正式5回・A/A 2回完了 |
| Yosys SAT bmc（内蔵engine） | `createSatReplay` → Icarus native/WASM | [S15-formal-replay](S15-formal-replay.md) | P1検証（210件・38行15列）。正式5回反復は残件 |
| smtbmc cover の witness | 対象外（到達の証拠であり assertion 違反ではない） | — | 反例検証に数えない |
| smtbmc prove の induction | 対象外（帰納法は反例を生成しない） | — | 反例検証に数えない |
| SbyPopen の AIGER/BTOR witness | 変換のみ | [S15-sby-witness](S15-sby-witness.md) | 全byte一致を検証済みだが、回路の反例検証とは別と明記 |

## 行の分類の監査

両生CSVの全行で `expected` と `actual` が一致しました。区分は verified・rejected・tool-error の3種で、拒否と上流エラーを成功に数えない基準どおりです。

| 記録 | verified | rejected | tool-error | 合計 |
|---|---:|---:|---:|---:|
| 元Verilog再実行 | 1,120 | 336 | 28 | 1,484 |
| 元VHDL/PSL・下位化再実行 | 1,470 | 196 | 119 | 1,785 |

元Verilogは1回×1候補あたり53行で、受理10 case（2 origin×2 runtime＝40行）、拒否6 case×2 origin＝12行、上流tool error（組合せループのrc16）1行です。元VHDL/PSL・下位化は1回×1候補あたり79行（yices2・bitwuzla・boolector）で、受理は下位化12 case×2 origin×2 runtime＝48行と元VHDL 12 case×2 origin×GHDL＝24行の計70行（memory はVHDL側のみ意図的拒否）、拒否4 case×2 origin＝8行、上流tool error 1行です。z3は1回18行で verified はゼロでした。13 case が上流SBYの終了code 16（smtbmcのsmtio解析クラッシュ）で tool-error、2 case×2 origin が拒否となり、反例そのものが生成されません。検証済みにしない設計どおりです。

## 未対応 trace を検証済みにしない境界の点検

| 点検対象 | 状態 |
|---|---|
| 拒否区分 | 未初期化・任意初期状態・未知の初期値・非対応memory・assertなし・深さN-1（完全な失敗traceがない）・入力遷移中の曖昧なassert・空虚な前提は、理由付きで rejected に分類され、verified に混ざらない |
| 上流エラー | solver側の tool-error は別扱いで upstream log を証拠に保存。z3 + GHDL下位化のクラッシュは全13 FAIL case で再現し、z3 はこの経路の採用候補から外れている。Verilog経路の z3 は反例を生成して検証済みであり、制限はVHDL経路特有 |
| 受理条件 | `createSmtReplay` は bmc と prove の basecase の1本の完全な失敗 trace だけを受理し、cover・induction・複数 trace・不完全な記録を fail closed で拒否する。`createSatReplay` は内蔵SATの bmc witness に限る（`web/lib/formal-replay.mjs`） |
| witness変換 | AIGER/BTOR の変換一致は、回路の反例検証とは別の記録として扱う |
| 製品の表示 | 結果とVCD/Surferの画面接続は未実装（タスク33 P5）で、反例検証済みを示す表記はまだ存在しない。solver 有効化情報（`web/lib/formal-capabilities.mjs`）の probe-verified は binary の輸送・同一性の認定であり、反例の再実行とは別の基準。z3 は probe-verified のままだが、VHDL経路では上流が ERROR を返し反例が生成されないため、検証済みの反例として表示される余地はない。P5で solver 選択へ注記する残件として記録する |

## 監査の結論

- タスク56・54 は merge 済みで、証拠の実測値は記録どおりです。親工程の完了条件を満たします。
- 再実行できない trace（拒否区分・上流エラー・cover・induction・AIGER/BTOR・SAT経路の未反復部分）は、どれも反例検証済みとして扱われていません。
- 残件は、P5の画面接続（z3のVHDL経路の制限を solver 選択に注記する事項を含む）、SAT経路の正式5回反復、P6の製品認定、実機確認です。
