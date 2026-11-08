# 実験の記録

実験・測定・比較を再現できる形で記録します。計画、実行、記録の手順は「experiment-record」スキル（`.agents/skills/experiment-record/SKILL.md`）に従います。

実験を始める前に、仮説、変える条件、採否の基準を決めます。基準の commit、ツールのバージョン、実行コマンド、環境変数、成果物のハッシュも記録します。生データは同じ名前の `.csv` に保存し、結果は RESEARCH.md に記録してください。

| 記録 | 内容 | 状態 |
|---|---|---|
| [S15 追加候補と原本SMTBMC/SBYの接続](S15-extra-solver-smtbmc.md) | Bitwuzlaの実help、Boolectorの終了10/20、native起動先の検査 | 両候補でSMTBMC各8条件・SBY各6条件の予備比較。初期の別native起動は除外。正式反復は後続の独立監査へ記録。製品認定は残件 |
| [S15 追加候補の独立監査と反復](S15-extra-formal-audit.md) | SMTBMC/SBY全列とhelp・実code・実構文エラーの監査 | 正式5回・A/A 2回の全420行・全列監査。改変20件とZIP全38,413ファイルの復元後監査も成功。製品では無効 |
| [S15 SBY子workerの停止と輸送の対照](S15-sby-controls.md) | 実ソルバーのstdin待機、全worker停止、delta改変とroot競合、非対応オプション | 正式5回・A/A 2回、全161行14列・966出力・707 workerを独立監査。ZIPからの全件復元も成功 |
| [S15 SbyPopenのwitness変換](S15-sby-witness.md) | AIGER・BTORの形式境界、原本の子worker、nativeとの全byte比較 | 正式5回・A/A 2回、全14行9列・42出力・21 workerを監査。回路の反例検証とは別 |
| [S3A Pyodide gowin_pack のビットストリーム比較](S3A-pyodide-gowin-pack.md) | native と Pyodide の `.fs` 出力、実行時間、配布 asset の比較 | 完了 |
| [S4A ブラウザー内ビルドの測定](S4A-browser-build.md) | Chromium 内の4ボード build、時間、memoryBytes の比較 | 完了 |
| [S4B 大きい資材の圧縮形式と展開時間の比較](S4B-compressed-assets.md) | gzip、zstd、xz の大きさと Chromium での展開時間 | 完了 |
| [S4C ブラウザーの初回配信量](S4C-cold-load-bytes.md) | 4 ボードの冷たい初回ビルド・書き込み時に取得する応答本文量 | 完了 |
| [S5 WASI SDK のビルドオプション比較](S5-wasi-build-options.md) | Yosys と nextpnr のビルドサイズ、資源、Node・Chromium の実行時間と出力同一性 | 完了 |
| [S5B Yosys・nextpnr の Os／LTO／Os+LTO 比較](S5B-os-lto-chromium.md) | Chromium の性能、WASM サイズ、ビルド安定性と出力同一性の追加比較 | 完了 |
| [S6 zstd・xz 展開器のビルドオプション比較](S6-decoder-build-options.md) | Chromium での展開時間、WASM サイズ、A/A と Node テストによる安定性を比較。凍結基準を満たす候補がなく B を維持 | 完了 |
| [S7 openFPGALoader の Chromium ビルドオプション比較](S7-openfpgaloader-chromium.md) | fake USB の実内容検証付きで5変種を比較し、凍結規則により B+LTOA を既定に採用。以前の既定は `scripts/build-wasm.sh --variant=B` で再現 | 完了 |
| [S8 CI ビルド時間の短縮](S8-ci-speed.md) | CI cache と並列 job の安定性・所要時間を測定 | 採用（2026-10-30、ユーザー判断「A」。凍結基準に未達項目あり） |
| [S9 GHDL WASM の Os + LTO 安定性確認](S9-ghdl-os-lto.md) | 凍結基準に基づき GHDL WASM の Os + LTO を評価 | 不合格（候補の LTO リンクに失敗。既定は変更せず） |
| [S9 GHDL WASM Os + LTO の凍結基準](S9-ghdl-os-lto-criteria.md) | Os + LTO 候補の安定性・採否条件 | 測定前に固定 |
| [S9B GHDL WASM 最適化マトリクス](S9B-ghdl-matrix.md) | GHDL WASM の最適化設定の安定性、size、Node 時間を比較 | 採用：Os（ユーザーの判断、基準からの逸脱） |
| [S9B GHDL WASM 最適化マトリクスの凍結基準](S9B-ghdl-matrix-criteria.md) | 最適化候補の安定性・比較・採否条件 | 測定前に固定 |
| [S0 GHDL WASM 合成のビルドと smoke](S0-ghdl-wasm.md) | GHDL 6.0.0 の WASM 合成、VHDL fixture、Tang Nano bitstream、T3-2 のブラウザー統合 | 完了 |
| [S0B GHDL WASM の Chromium / Node 測定](S0B-ghdl-chromium.md) | 7 fixture と4ボードの VHDL template を Node / Chromium で測定。raw CSV は本文から参照 | 記録のみ（既定 Os を変更しない） |
| [S0B GHDL Chromium 測定の凍結基準](S0B-ghdl-chromium-criteria.md) | GHDL WASM の Node / Chromium 測定条件と正しさの確認 | 測定前に固定 |
| [S10 Icarus Verilog WASM 化](S10-iverilog-wasm.md) | Icarus v13_0 の WASI build、native parity、制限、artifact hash | 完了 |
| [S10 Icarus Verilog WASM 化の凍結基準](S10-iverilog-wasm-criteria.md) | 3つの WASM の再現性、native parity、negative control の条件 | 測定前に固定 |
| [S11 NVC r1.23.1 の WASM 化](S11-nvc-wasm.md) | Emscripten NVC の callback signature mismatch を特定。cast emulation 後も Node simulation が完走せず、5-file limit で停止 | 中止（5-file limit） |
| [S11 NVC WASM 化の凍結基準](S11-nvc-wasm-criteria.md) | NVC WASM の build、parity、negative control の基準と延長条件 | 測定前に固定 |
| [S12 Surfer WASM 化](S12-surfer-wasm.md) | Surfer v0.7.0 の WASM build、配布、browser test と再現性 | 同一 revision の local 2回と CI の全453ファイル一致 |
| [S12 Surfer WASM 化の凍結基準](S12-surfer-wasm-criteria.md) | Surfer の再現 build、browser load、negative control の条件 | 測定前に固定 |
| [S12B シミュレーション統合の回帰検証](S12B-simulation-integration.md) | timescale前後の4ボードbitstream比較、波形8画面、Icarus配布前検査と初回失敗の記録 | 全体E2E76件成功・比較測定4件skip、シミュレーション3回反復30件成功 |
| [S13 nextpnr の配置結果の再現性](S13-nextpnr-determinism.md) | 製品用の8代表回路×4ボードで native / WASI を各5回比較。A/A、負の対照、資源、CSV を記録 | 候補2を採用。通常320回と A/A 20回が一致し、負例10回を拒否 |
| [S14 CPU コアの実行と4ボード比較](S14-cpu-library-matrix.md) | ROM、RAM、GPIO と独立検査、負の対照、合成・配置配線・pack の採否基準 | 事前基準と初回失敗の保全記録 |
| [S14 製品用HDLの正式反復](S14-production-hdl.md) | 8部品と4ボード、A/A、負の対照、生CSVと全列監査 | 全32組で両系各5回一致。350行39列を監査 |
| [S14 製品用CPUの正式反復](S14-production-cpu.md) | 7候補と4ボード、3経路の対照、生CSVと全列監査 | 成功18・容量超過6・frontend非対応4。正常な18組は両系各5回一致。370行39列を監査 |
| [S14 昇格後の最終回帰と配布ソース](S14-final-regression.md) | 全60組の全列CSV・診断・選択制限とGit情報なしの再生成 | 整列後の07e2256でもHDL32組成功、CPU成功18・容量超過6・frontend非対応4。全7,700値、22候補107資材と全配布ファイルを照合 |
| [S14 整列後のE2Eと配布物再生成](S14-post-stack-e2e.md) | 保存API・配布前検査の修正、失敗試行、同一commitのWeb再生成 | 876c2a8で全体E2E76件成功・比較4件skip、22候補107資材とWeb全661ファイルが一致 |
| [S14A 修正commitの全60組回帰](S14A-final-regression.md) | HDL32組・CPU28組、全列・診断・通常選択制限と証拠 | HDL32成功、CPU18成功・6容量超過・4frontend非対応。7,700セルを監査 |
| [S14A SERV / 20Kの演算の縮約](S14A-pnr-fp-contract.md) | 元のCI artifact、同じGCCのfast / off対照、製品用再ビルド、A/Aと厳密比較 | 全60実行・60行11列を監査。heap placerだけ縮約を無効化 |

仮想デバイスによる測定値は、実機の値として扱いません。

追加ソルバーの固定依存・取得原文と診断の事前基準は [S15 P4](S15-extra-solver-builds.md) に記録します。Boolector native/WASIのCLI 5条件と失敗試行を確認しました。ID幅とtraceの境界は修正後の正式反復が通りました。[BitwuzlaのMeson診断](S15-bitwuzla-build.md)は固定依存だけの清浄ビルドとCLI予備29実行が通りました。[BitwuzlaのCLI独立監査](S15-bitwuzla-cli-qualification.md)は正式5回・A/A 2回の全203行14列が通りました。[正式145行](S15-bitwuzla-cli-formal.csv)・[A/A 58行](S15-bitwuzla-cli-aa.csv)と[証拠目録](S15-bitwuzla-cli-files.csv)を保存し、ZIP復元後も全列を再監査しました。後続の[原本SMTBMC/SBY認定](S15-extra-formal-audit.md)は正式反復と証拠復元を通りました。製品配布は未完了です。

型幅と未対応processの追加対照は [S15 P4 可搬性](S15-solver-portability.md) に分け、原本IDの負の対照とgzip API trace拒否を正式5回・A/A 2回で確認しました。生CSV全56行21列とZIP復元後の独立監査を記録しています。

| 実験 | 目的 | 状態 |
|---|---|---|
| [S15 形式検証](S15-formal-verification.md) | 上流SBY・SMTBMCとソルバーの再利用、native/WASM、property・反例、輸送と非成功判定 | P1のSAT・反例再実行は別記。SMTソルバーのビルド・証明・正式5回反復は未実施 |
| [S15 P0 配布ソース照合](S15-formal-source-closure.md) | 固定ソース、GMP原archive、licenseとGit情報なしの再生成 | c41e5c5で配布ソースとZIPを照合。形式検証の実行とは区別 |
| [S15 P1 SAT反例の独立再実行](S15-formal-replay.md) | 元のVerilogをIcarusのnative/WASMで再実行し、壊した出力・resetを拒否 | 清浄なbf042daで210件成功。生CSV38行15列を監査。正式5回反復と画面統合は未完了 |
| [S15 SMT反例の原回路による再実行](S15-smt-original-replay.md) | 原本SMTBMCのVCD出力境界から値を独立記録 | 記録と原回路の反例検証を区別。元Verilog/VHDL再実行・画面接続は未完了 |
| [S15 SMT記録の独立監査](S15-smt-trace-audit.md) | 原本VCDを再生成し全17列をraw evidenceと照合 | 正式5回・A/A 2回の全896行19列、改変対照170件とZIP全18,753 filesの復元後監査が成功 |
| [S15 SMT反例の元Verilog再実行](S15-smt-verilog-replay.md) | Icarus native/WASMで入力だけを駆動し、内部信号・clock・時刻・propertyを独立照合 | 正式5回・A/A 2回の全1,484行23列、改変対照316件とZIP全96,592 filesの復元後監査が成功。元VHDL/PSLと画面統合は未完了 |
| [S15 SMT反例の元VHDL/PSLと下位化Verilog再実行](S15-smt-vhdl-replay.md) | GHDL+VPIによる元VHDL再実行とIcarus両版による下位化再実行。違反周期・instance path・全port値・VCD・PSL reportを照合 | 正式5回・A/A 2回の全1,785行27列、改変対照493件とZIP全74,316 filesの復元後監査が成功。z3はsmtbmcクラッシュで候補外。画面統合は未完了 |
| [S15 P1 VHDL・PSL property保持](S15-vhdl-formal.md) | 上流GHDLの解析とmonitorを再利用し、明示した形式出力をYosysへ渡す | 清浄な72080beで33件成功、生CSV44行11列を監査。PSL解析の失敗も記録。独立再実行と正式反復は未完了 |
| [S15 P1 元VHDLの独立再実行](S15-vhdl-native-replay.md) | GHDL標準VPI・PSLレポートと独立VCDで反例を照合 | 清浄な同一commitで55件×5回とA/Aの2回成功。CSV全280行19列を監査。下位化後比較・追加fixtureは未完了 |
| [S15 P1 VHDLと下位化Verilog](S15-vhdl-lowered-replay.md) | 上流Yosysで下位化し、元VHDLとIcarus native/WASMを比較 | 69件の5回反復とA/Aが成功。[生CSV](S15-vhdl-lowered-results.csv)全420行20列を[監査](S15-vhdl-lowered-audit.json)。[失敗試行](S15-vhdl-lowered-failures.md)も保持 |
| [S15 P2 ソルバーのビルドと双方向通信](S15-solver-build-and-transport.md) | 固定Yices2・Z3、stdin/stdout、終了・異常系、native/WASMの採否基準 | 初期の失敗と予備輸送を保持。clean buildと正式反復は下記へ分離 |
| [S15 P2 実ソルバーの応答と終了](S15-solver-protocol.md) | bit-vector・array・長い応答、計算要求後の停止、hardware丸めの境界と全列監査 | 事前基準と予備21実行などの履歴。正式結果は下記へ分離 |
| [S15 P2 Z3 WASIのlink](S15-z3-wasi-link.md) | SDKの例外library、fork登録と単一threadのyield、buildと計測の履歴分離 | link失敗と手動18条件を保持。その後のclean buildは成功 |
| [S15 P2 native/WASI正式比較](S15-solver-native-wasi.md) | 両solverの実応答、worker異常系、5回・A/A、資源、圧縮サイズと証拠 | 全329行31列・294負の対照を監査。SBY接続は後続のP3へ分離。製品画面は未完了 |
| [S15 P3 原本SBY・SMTBMCのprocess境界](S15-sby-process.md) | Pythonの能力診断、原本のBMC・prove・coverと輸送境界 | native SBY12条件、原本SMTBMCとPyodide/WASI16条件の予備比較・全13列監査が成功。初期の過程は保持し、SBY全体の接続は次の記録へ |
| [S15 P3 SBY全体の仮想process接続](S15-sby-runtime.md) | SbyPopen、Yosys/Python子worker、仮想select、jobserver、SQLiteと差分 | 両solver各6条件でstatus・主要成果物・SQLite5表が予備一致。後続の独立監査・正式反復へ継続。画面は未完了 |
| [S15 P3 SBY全成果物の独立監査](S15-sby-artifact-audit.md) | 全268成果物・CSV16列、限定した環境差、再帰的終了、改変の拒否 | 清浄commitで全12条件・316件が成功。UNKNOWNのSQLite最終行不在を保持。正式反復は次の記録へ分離 |
| [S15 P3 SBY正式反復](S15-sby-repeated.md) | 同一commitでA/A 2回と正式5回、全84行・19列・反復間hash | 全1,876成果物が一致。全7,411ファイルをZIP復元後にも独立監査。異常対照は別記録へ継続。画面統合は残件 |
