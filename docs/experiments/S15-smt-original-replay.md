# S15 SMT反例の原回路による独立再実行

状態は実装中です。SAT反例の再実行、原本witnessの形式変換、SMTBMC/SBYのnativeとの成果物比較を、SMT反例の原回路による検証済み実績とは区別します。P5の画面接続より先に、この独立層を検査します。solverの製品有効化・配布closure・実機確認・CI全体の確認は、この記録の完了条件ではありません。

元VerilogのIcarus native/WASMへの接続は、[別の実験記録](S15-smt-verilog-replay.md)へ分けています。正式5回・A/A 2回の全1,484行23列、改変対照316件、証拠ZIPの復元後監査まで通りました。元VHDL/PSL、下位化Verilogとの比較、画面統合は引き続き残っています。

## 目的と仮説

原本SMTBMCの `--dump-vlogtb` は、内部registerとmemoryへモデルの値を代入します。これを無条件で実行すると、元回路の初期状態を独立に確かめたとは言えません。元VerilogのIcarus再実行、元VHDLのGHDL/VPI再実行、下位化VerilogのIcarus再実行へ、原本が選んだ入力列と期待するport値を渡します。内部状態はforceせず、元HDLの初期化とclockを使います。

原本の `write_vcd_trace` は、上流SMTIOで取得したnet値を `MkVcd` へ渡します。この出力境界だけを記録すれば、SMT生成・応答解析・proof semantics・property評価を移植せずに、既存の再実行経路へ接続できると考えました。記録器は元 `MkVcd` の全methodも呼び、原本のVCD出力を変えません。

## 結果を見る前の受入れ基準

| 段階 | 条件 |
|---|---|
| 出力境界 | 明示entrypoint `formal_trace` だけで記録を有効化。既定 `smtbmc` の挙動を変えない |
| 原本との比較 | 同じ元source・model・solverで、記録なし/あり、native/Pyodideの4経路のVCD/YW/testbench全bytesと終了code、stderrが一致。stdoutは上流の経過時刻だけを除いて一致 |
| 値の記録 | modelとVCDのSHA-256、net path・幅・clock極性、全sampleと終端を保持し、native/Pyodideの記録bytesが一致 |
| 異常・資源 | 例外、途中終了、欠落、重複、幅違い、不安全なpath、上限超過では成功した記録を返さない。既存出力を上書きしない |
| 元Verilog | Icarus native/WASMで全port値・同じpropertyの違反・完走・独立VCDを確認。N-1/N/N+1、assume、reset、両clock極性を検査 |
| 元VHDL/PSL | 元sourceのproperty位置・最初の違反周期・PSL report・GHDL/VPIと独立VCDを照合。下位化Verilogも比較 |
| 未対応 | 任意初期状態、未知値、未対応memory・複数clockなどを検証済みにしない。SAT/SMTと未検証を区別 |
| 正式試行 | 計測器を固定した清浄な同一commitでA/A 2回と正式5回。全列独立監査、失敗保存、証拠ZIPの空の場所への復元後監査 |

## 出力境界の実装

`web/formal_trace.py` は上流の `smtio.MkVcd` を継承し、登録・時刻・値を記録します。`runpy` で原本SMTBMCを起動し、元の終了codeを保持します。例外では最終記録を公開せず、呼出し後は `MkVcd` と `sys.argv` を復元します。VCDを閉じた後にhashを取り、modelが途中で変わっていないことも確認します。

記録先は `formal-trace.json` です。入力modelと出力は安全な相対pathに限り、symlink・drive付きpath・既存出力を拒否します。引数のfile pathは原本を実行する前にも検査し、原本がfileを開いた後で初めて不安全な指定に気付くことを避けます。net/clockの重複、sample内の重複、幅と時刻を検査し、signal数4,096、sample時刻1,024、単一net幅4,096 bit、合計の定義・値とJSON各8 MiBを上限にします。`x`・`z`・`?`を含む値は記録成功として公開しません。

JSONは一時fileを閉じてから公開します。nativeはhard linkによる排他的な公開、Pyodideはjob専用の単一workerのMEMFS内で存在を再検査してrenameを使い、途中書き込みのJSONを返しません。これはhostの共有fileをPyodideから操作するものではありません。

この明示entrypointの引数は、検査した `-s`・`-t`・`-m`・`-i`・`-c`・`-g`・`--presat`・`--noprogress`・`--unroll`・`--noinfo` と、`--dump-vcd`・`--dump-yw`・`--dump-vlogtb`・`--smtc` に限ります。未検査option、複数trace名への `%` 展開、重複した入出力先は拒否します。既定の原本 `smtbmc` のoptionは制限しません。原本の制約・SMT・判定の解析はこの境界に移植していません。

この段階は値の受け渡しの基盤です。再実行やproperty違反の独立確認が完了する前に、記録ができたことだけを反例検証成功とは扱いません。

## 予備比較の条件と再実行

基準commitは `0c9f1d4c824de86ef217df7c285b8ab7255e8fbc` です。solverとYosysは前段でhash照合した固定binaryを再利用し、Python資材は新しい出力先へ再生成します。元SBYの6 fixtureを使い、proveのbasecase/inductionを分けた8条件について、各solverの4経路を比較します。既定はYices2/Z3で、追加候補は `--solver bitwuzla` または `--solver boolector` を明示します。

```sh
python3 scripts/build-formal-python.py --out build/S15/smt-trace-python-assets-03
node scripts/probe-upstream-formal.mjs --probes build/S15/p2-native-wasi-all-probes.json --out build/S15/smt-trace-native-02
node scripts/probe-formal-trace.mjs --sources build/S15/smt-trace-python-assets-03 \
  --probes build/S15/p2-native-wasi-all-probes.json --baseline build/S15/smt-trace-native-02 \
  --out build/S15/smt-trace-preliminary-03
```

出力先があれば停止します。比較器はhost・実版・全submodule・command・worktree状態・snapshot、SBY基準metadata、各modelと成果物、標準stream、実終了code、全childの終了と整合性を保存します。途中失敗も削除せず、正式試行に混ぜません。native/Pyodideの比較であり、実機の値ではありません。

追加候補も別の出力先を使います。`SOLVER` は `bitwuzla` と `boolector` をそれぞれ指定します。

```sh
node scripts/probe-upstream-formal.mjs --solver "$SOLVER" \
  --probes build/S15/p4-extra-formal-probes.json --out "build/S15/smt-trace-$SOLVER-native-01"
node scripts/probe-formal-trace.mjs --solver "$SOLVER" \
  --sources build/S15/smt-trace-python-assets-03 --probes build/S15/p4-extra-formal-probes.json \
  --baseline "build/S15/smt-trace-$SOLVER-native-01" --out "build/S15/smt-trace-$SOLVER-preliminary-03"
```

## 出力境界の予備結果

清浄なcommitでの正式測定ではなく、上記基準からの変更を含む手元の予備比較です。修正後の3組について、native/Pyodideと記録なし/ありの4経路が一致しました。

| solver | 条件 | 経路あたりの比較 | 行数 | 状態 |
|---|---:|---:|---:|---|
| Yices2/Z3 | 各8 | 各4 | 64 | 全行 `matched`、errorなし |
| Bitwuzla | 8 | 4 | 32 | 全行 `matched`、errorなし |
| Boolector | 8 | 4 | 32 | 全行 `matched`、errorなし |

全128行で、model・元VCD/YW/testbench全bytes、標準stream、終了code、native/Pyodideの記録JSONが一致しました。Bitwuzlaのhelp childとSMT child、Boolectorの実終了code 10/20も、既存のprocess境界の検査を通しています。CSVは[既定2候補](S15-smt-trace-default-preliminary.csv)、[Bitwuzla](S15-smt-trace-bitwuzla-preliminary.csv)、[Boolector](S15-smt-trace-boolector-preliminary.csv)です。この時点では独立監査と正式反復は未実施でした。後続の[全17列監査・正式反復](S15-smt-trace-audit.md)とは区別します。

hostはLinux `6.8.0-1061-aws`、x86_64、Intel Xeonの2 CPU、memory 8,327,749,632 bytesです。Node `v24.21.0`、Python `3.12.13`、Pyodide `314.0.7`を使いました。solverのsource・binary hashとnative実行pathは各出力先の `metadata.json` と `*-build.json`、実行時のchild identity・実終了code・輸送整合性は各条件の `process.json` に保存しています。binaryは前段の認定品を再利用しており、今回の変更から再ビルドしたものではありません。

境界のPython単体は13件、全Python回帰は129件、Web回帰は276件が成功しました。その後、全signalのsample欠落の拒否と3種のclock edgeの原本bytes維持を調べる単体を追加しています。Webの追加2件は原本 `MkVcd` クラスをASTのまま読み込む単体fixtureであり、実solverの128行とは別です。`x/z/?`、不安全なpath、symlink、重複、幅、時刻、header後の定義、未完了trace、実行中model改変、終了codeの型と範囲、既存出力、定義と値の合計上限、一時fileの公開失敗を拒否しています。

## 初回unitの失敗

安全pathのunitで `.` の拒否漏れが1件出ました。空のpath要素を明示的に拒否するよう修正し、失敗ログを保持しました。元SMTBMCによる予備比較と正式試行は、このunitの実行時点では未実施です。

最初の予備比較は、古いprobe一覧が失敗済みのZ3 WASI buildを指していたため停止しました。Yices2の8条件・4経路は一致しましたが、この部分結果を両solverの完了とは扱いません。前段で認定した固定binaryを指す一覧を確認し、一覧を引数で渡して、新しいSBY基準と出力先でやり直します。失敗済みのZ3を無視して続ける変更はしていません。

追加したWeb単体の初回fixtureは、未patchのSMTIO全体をPyodideへ読み込み、host資源設定の初期化で停止しました。最初の276件中1件の失敗を保存しています。fixtureを原本 `MkVcd` クラスだけのAST読込へ改め、負の対照も単に例外が出たことだけでなく、狙ったpath・値・終端の拒否理由まで照合しました。製品側のprocess patchやSMT判定をこのfixtureに合わせて変更していません。

## CIの起動準備の追補

[Playwright E2Eの起動ログ](https://github.com/gogo-fpga/toolchain/actions/runs/41436913533/job/125275201976) では、テスト開始前のWeb資材生成が `third_party/colibri: checkout differs from pinned gitlink` で停止しました。このjobはzstdだけを取得しており、Web生成が参照するHDLライブラリーを取得していませんでした。Build jobで取得したsubmoduleは、別jobのcheckoutには引き継がれません。

E2Eでも固定gitlinkの `third_party/` とVexRiscvの入れ子ソースを明示的に取得するように修正しました。無条件のrecursive取得やpin検査の緩和はしません。取得順を検査する回帰テストは修正前のworkflowで失敗し、修正後はライブラリー検査24件が成功しました。これは起動準備の修正であり、ブラウザーでの形式検証や元HDLの再実行を確認した結果ではありません。

## 独立監査と反復の基準

`scripts/audit-formal-trace.py` は、比較器の `matched` を信用する代わりに、全17列をprocess記録・元成果物・標準streamから計算し直します。未知の条件、行の不足・重複、JSONの重複key・非有限値、CSVの不一致、危険なpath、symlinkを拒否します。Bitwuzlaのhelp/SMT childを分け、Boolectorの実終了code 10/20と許可policyを検査します。

記録JSONのnet・clock・時刻・値から、固定した上流の `MkVcd` クラスを使ってVCDを再生成し、原本VCD全bytesとも照合します。SMT応答の解析を移植するものではありません。上流がclockのsample値をVCDへ出さず、edge定義から波形を生成する点もそのままです。clockのモデル値はnative/Pyodide間で照合する記録であり、原HDLで独立に検証した値とは扱いません。

監査の過程で、記録器の信号定義が上流writerの内部辞書に依存していた点を改めました。独立した定義・時刻・値を各 `super()` 呼出し前に保存し、先に記録されたことを単体で検査します。上流の全method呼出しは残します。

提出済みcommit `3b6eba147b8989d27cb9f23c439fcc758d027bd5` の予備128行は、新しい監査器でも全17列が一致しました。初回監査では既定entrypointのJSONで空のcapture hashが省略される点と、英語localeによる成果物名の順序を見落として停止しました。失敗ログを保持し、旧予備記録だけを明示的に読めるようにしました。新しい比較器は空のhashも `null` として保存し、hashの対象名はcodepoint順に固定します。正式modeは旧形式を許可しません。

正式modeは清浄な同一commitのnative基準を要求し、source pin・元Pythonとpatchのhash・staged資材・native/WASI build metadata・実binary全bytesと起動先を照合します。`scripts/measure-formal-trace.py` は既定2候補、Bitwuzla、Boolectorを順にA/A 2回・正式5回測り、全896行19列、反復間の意味的hashと条件ごとの最小・中央値・最大を監査します。[正式結果と証拠復元](S15-smt-trace-audit.md)は全列監査を通りました。

```sh
python3 scripts/build-formal-python.py --out build/S15/smt-trace-python-assets-formal-01
python3 scripts/measure-formal-trace.py --sources build/S15/smt-trace-python-assets-formal-01 \
  --probes build/S15/smt-trace-all-probes.json --out build/S15/smt-trace-formal-01
python3 scripts/measure-formal-trace.py --audit-only --out build/S15/smt-trace-formal-01
```

probe一覧は前段でhash認定した4候補のnative/WASI build出力を指定します。前段のbinaryを再利用し、今回の記録境界からsolverを再ビルドしたとは扱いません。`scripts/negative-formal-trace.py` は全17列のCSV/JSON、child、欠落・重複、VCDと記録値などを個別に変え、拒否理由と復元後の正常監査を保存します。測定中のscriptは変更しません。

正式測定前の実証拠改変対照は、既定2候補56件、Bitwuzla 57件、Boolector 57件の計170件を拒否し、原状へ戻した後の監査も通りました。既定2候補は独立metadataへの修正を含む新しい予備比較を使い、追加2候補は提出済みの予備証拠を使っています。これは正式反復の結果ではありません。Python回帰138件とWeb回帰276件も成功しました。

初回正式試行 `smt-trace-formal-01` はcommit `4ec0983e4a4476e56538f37c8fff7200040ab697` の既定2候補64行を生成後、監査器が上流の本体名 `yices_smt2` とCLI起動名 `yices-smt2` を同一視して停止しました。比較出力・失敗記録は別の失敗証拠として保持します。本体の解決先はbuild metadataの相対パス全体と照合し、CLI起動名・binary hashの照合も維持する修正と回帰を追加しました。この試行は正式成功結果に含めず、修正commitから全反復をやり直しました。成功した出力先と実行commandは正式結果の記録を参照してください。

## 未完了

値の記録層は全列独立監査・正式反復・証拠復元まで確認しました。元Verilog・元VHDL/PSL・下位化Verilogへの値の接続と、原回路再実行層の負の対照・全列監査・正式反復・画面接続は未完了です。原本SMTBMC/SBYの成果物一致と、原回路による反例検証を分けて進めます。

## 一次資料

- [`smtbmc.py`](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/backends/smt2/smtbmc.py): `write_vcd_trace` と `write_vlogtb_trace`
- [`smtio.py`](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/backends/smt2/smtio.py): `MkVcd`
- [既存SAT再実行](../../web/lib/formal-replay.mjs)
- [元VHDLの再実行](S15-vhdl-native-replay.md)と[下位化比較](S15-vhdl-lowered-replay.md)
