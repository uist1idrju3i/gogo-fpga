# S15: Bitwuzla/Boolectorと原本SMTBMC/SBYの接続

[実験索引](README.md)へ戻る。

## 目的と事前基準

上流の `smtio.py`、`smtbmc.py`、SBYをそのまま使い、両候補を既存のPyodide/WASI processへ接続します。これは[Bitwuzla CLI認定](S15-bitwuzla-cli-qualification.md)と[Boolector境界認定](S15-solver-portability.md)の次段です。製品catalogの有効化、製品worker/画面、配布の認定は別に行い、この接続だけで有効にしません。

- 比較の参照は、同じpinのnative solverと原本SBY/SMTBMCです。既存のBMC短期PASS・反例FAIL、proveのUNKNOWN・帰納法PASS、cover到達・未到達の6条件を再利用します。proveはbasecaseとinductionを分け、直接SMTBMCは各solver 8条件です。
- Bitwuzlaでは原本SMTIOが判定前に `check_output([solver, '--help'], text=True)` を実行します。WASIのhelpを実際に起動して全出力を渡し、版別の引数選択は上流に任せます。helpの文字列を代わりに生成せず、出力上限、EOF、終了code、stderrを検査します。
- BoolectorはSMT-LIBの正常終了が10/20になる場合があります。`Popen.wait()` はnativeと同じ実際の終了codeを返し、brokerは明示した有限の終了code一覧だけを受け入れます。未指定時は0だけであり、transportやruntimeの失敗を終了codeへ変換しません。
- native/Pyodideのstatus・終了code、時刻だけを除いたSMTBMCログ、stderr、VCD/YW/testbench全byteを照合します。SBYではSQLite全表、主要成果物、分類も既存の独立照合器で確認します。
- 上流PythonのAST照合はprocess関数の別名とbrowser分岐だけを除き、式、制約、判定、応答解析、反例生成の変更を拒否します。
- 正式認定に進む前に、実装・計測器・監査器を清浄なcommitへ固定します。各条件は正式5回、A/A 2回。全列監査、実行中の取消・外部期限・不正輸送・構文エラーの負の対照、証拠ZIPの全ファイル照合と復元後監査を必須とします。作業中の予備結果は正式認定に数えません。

実行資材には前段の清浄buildを使います。各試行のmetadataでbuild commit、本体と依存のhash、計測commit、Python/Node/Pyodide版、source snapshotを別々に保存します。失敗ログも `build/S15/` に保持します。

## 接続の実装と予備試行

この接続層に続く全列監査、process対照、正式反復の基準と結果は[追加solverの独立監査](S15-extra-formal-audit.md)へ分けています。接続層の予備一致だけでは正式認定になりません。

変更はprocess境界に限ります。`patches/yosys-smtio-process.patch` はnativeで `subprocess.check_output`、browserで `formal_process.check_output` を参照する別名を追加します。helpの読み方、版別の引数選択、unroll、SMT応答の解析は原本のままです。仮想processはstdinをEOFにし、stdoutだけを捕捉してstderrを親へ転送します。bytes/text、UTF-8、改行、非ゼロ時の `CalledProcessError` を保持し、未対応のkeywordは拒否します。

`Popen.wait()` と仮想readerのjoinは実際の終了codeを返す境界へ接続します。code 10/20を0へ書き換えません。brokerは資材の明示的な `exitCodes` を検査し、既定は `[0]`、Boolectorの診断だけは `[0, 10, 20]` です。空・重複・範囲外・不正な型は拒否し、各子processの証拠に実際のcodeと一覧を保存します。異常なtransportはこの一覧では成功になりません。

診断CLIは `--solver bitwuzla` と `--solver boolector` を明示した場合だけ追加候補を選びます。未指定の比較対象は従来のYices2/Z3のままです。未知のsolver指定で0件の成功を返すことはありません。SBY子processの引数検査は両候補を受け付けますが、実行資材のmanifestにないsolverの起動は禁止したままです。製品catalogは変更しません。

### 資材

前段の清浄buildを再利用し、この接続のためにコンパイラーやsolver本体を変更しません。

| solver | runtime | build commit | SHA-256 |
|---|---|---|---|
| Bitwuzla | native | `d8fdbc6cf9ed23ce58e6aebd26d9f9d311c652b5` | `c618a94953cbce37d14e94db9f53f9f408a463e94f213b9a5535e0c3ec2b8020` |
| Bitwuzla | WASI | `d8fdbc6cf9ed23ce58e6aebd26d9f9d311c652b5` | `069d676fb4408352344bab80474fc74b5a8e39caf31747b40c2951f6cc43ead7` |
| Boolector | native | `be04b41b7211c444aee55f9af97db01764956691` | `19fbca1674a11dfa9caee74292203624de002fdcb43a31667ebb580129e27067` |
| Boolector | WASI | `be04b41b7211c444aee55f9af97db01764956691` | `043b2d62ed145e59d5aa87ca0b22caa7fb69ec6bd829504b74453b0a1832dd24` |

実行環境はNode v24.21.0、Python 3.12.13、Pyodide 314.0.7、2 CPUです。詳細なbuild条件は上記の前段記録とmetadataに保持します。

### 失敗と除外

1. 旧Python資材のBitwuzlaでは、help取得がOSのsubprocessへ到達し、`emscripten does not support processes` で停止しました。`p4-bitwuzla-python-unpatched-01` に例外の全stackとstreamを保持します。helpの文字列を埋め込む代替は採用しません。
2. Boolectorの初回はreaderのjoinが終了20を例外にし、8条件すべて `runtime-error` でした。`p4-boolector-python-preliminary-01` を失敗として保持し、nativeのThread.joinと同じく、その終了codeだけで例外にしない接続へ直しました。終了状態を受け入れる一覧はbrokerで別に検査します。
3. 初回のnative SBY比較器は、追加候補のリンク名を `z3` にしていました。実際にはPATH上のOSS CAD Suiteのsolverへ到達していたため、`p4-*-native-preliminary-01` は固定資材の認定から除外します。後続の初回SBY比較も、期待する名前のファイルがなく実行前に停止しました。これらの結果や、それを参照したSMTBMCの初期試行を正式な比較へ流用しません。
4. リンク名を実行するsolver名へ直し、Pythonの `shutil.which` による解決先が隔離したbin内であることと、そのファイルのSHA-256を起動前に検査するようにしました。PATHへのfallback、同名の別ファイル、hashの変化を拒否する負の対照を追加しています。native metadataに解決先とhashを保存し、SBY比較器もその記録を必須にします。

修正後の作業中の予備試行では、両候補のSMTBMC各8条件、SBY各6条件が一致しました。SBYはstatus、分類、SQLite全5表と主要成果物を比較しています。これは作業中の検査であり、清浄な提出commitの検証や、全列を導出する独立監査、正式反復の成功とは扱いません。単体はWeb 272件、Python 98件が成功しています。AST照合と偽の判定を拒否する検査も含みます。

### 清浄な接続commitの再検査

`7345f8b75072364f21b127abe1002fc62719de2a` の清浄な作業treeでPython資材を再生成し、nativeの起動先を検査してから両候補を逐次比較しました。[直接SMTBMCの生CSV](S15-extra-solver-smtbmc-preliminary.csv)は全16行13列、[SBYの生CSV](S15-extra-solver-sby-preliminary.csv)は全12行16列です。全行でerror欄は空です。SMTBMCはnative/Pyodideの終了codeとstdout hash、反例の全byteが一致し、SBYは6条件の分類、SQLite全5表と主要成果物が一致しました。各solverのSBY成果物数は134、比較対象は80であり、両候補の合計は268成果物・160比較です。

同じcommitでPython 98件・Web 272件・実Yosys子worker 3件の計373件が成功しました。Node構文、Python compile、pin、JIS、link、文書サイズも検査しています。これは正式反復ではなく、全列の独立監査を通した記録でもありません。CSVを公開したことだけで適合性認定とは扱いません。

実行ディレクトリーは `build/S15/p4-{bitwuzla,boolector}-{native,smtbmc,sby}-7345f8b`、Python資材は `build/S15/p4-extra-python-assets-7345f8b` です。各ディレクトリーのmetadataに計測commit、清浄な作業tree、全snapshot、native起動先、資材hashを保持しています。失敗した初期試行は上書きしていません。

RESEARCH.mdは追記時に40,000バイトを超えたため、旧見出しとリンクを残し、Yosys/nextpnrのビルド設定・比較規則・測定履歴を[独立した調査](../research/yosys-nextpnr-wasi.md)へ移しました。原典、過去の失敗、その後の修正、測定値を保持しています。

### 再実行の形

診断manifestは、各solverの `native` と `wasi` に前段のbuildディレクトリーを指定するJSONです。出力先は未使用の名前にし、例の `bitwuzla` を `boolector` に替えて両候補を実行します。

```sh
python3 scripts/build-formal-python.py --out build/S15/extra-python-assets
node scripts/probe-upstream-formal.mjs \
  --probes build/S15/extra-probes.json --solver bitwuzla \
  --out build/S15/extra-bitwuzla-native
node scripts/probe-formal-python-engine.mjs \
  --sources build/S15/extra-python-assets --probes build/S15/extra-probes.json \
  --solver bitwuzla --baseline build/S15/extra-bitwuzla-native \
  --out build/S15/extra-bitwuzla-smtbmc
node scripts/probe-formal-sby.mjs \
  --sources build/S15/extra-python-assets --probes build/S15/extra-probes.json \
  --synth build/synth --solver bitwuzla --baseline build/S15/extra-bitwuzla-native \
  --out build/S15/extra-bitwuzla-sby
```

各試行は実際のcommand、source snapshot、solver/Yosys/Python資材、nativeとPyodideの全stream・成果物、子processの終了状態、JSONとCSVを出力します。正式認定はこの予備CLIにフラグを付けただけでは完了にしません。

## 状態と残件

接続層の予備比較に続き、[独立監査と正式反復](S15-extra-formal-audit.md#清浄commitでの正式結果)で正式5回・A/A 2回の全420行と実行中停止、改変対照20件、ZIP復元後の監査を確認しました。予備記録は正式結果で置き換えず、その経緯として残します。製品資材の配布closure、元HDLによるSMT反例再実行、製品worker/画面の接続と認定は未完了です。両候補は製品で無効のままです。Tang Nano実機は本リポジトリでは試していません。
