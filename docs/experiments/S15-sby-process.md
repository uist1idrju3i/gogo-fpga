# S15 P3 原本SBY・SMTBMCのprocess境界

- 状態: 実施中。native原本SBYの予備12条件と、原本SMTBMCのnative/Pyodide予備16条件を実施。下記は接続前の経緯を保持し、その後の[SBY全体の仮想process接続](S15-sby-runtime.md)を別記しました。正式反復と製品統合は未完了です。
- 関連: [S15の事前基準](S15-formal-verification.md)、[P2の正式比較](S15-solver-native-wasi.md)、[調査索引](../../RESEARCH.md#7-分割した調査)

## 目的と仮説

上流SBYとyosys-smtbmcを原本のまま使い、Pythonのprocess・pipe・待機・終了だけをブラウザー用に接続します。SMTの生成、応答の意味、帰納法、propertyの評価、trace、statusのSQL処理はJavaScriptへ移植しません。P2の実solverと共有bufferを再利用する仮説です。

## 採否の基準

SBYを始点としてYosys、yosys-smtbmc、実solverまで通し、次の6条件をnative原本とPyodideで照合します。事前の期待値と異なる出力は失敗として保存し、判定を緩めません。

| 条件 | mode・depth | 事前の期待status | 意味 |
|---|---|---|---|
| 違反前の短いprefix | bmc・2 | PASS | 深さ内だけ安全。証明ではない |
| 到達する違反 | bmc・6 | FAIL | 元回路の反例とVCD・YWが必要 |
| 短い帰納法 | prove・2 | UNKNOWN | BMCのPASSだけをproofに昇格させない |
| counterの不変条件 | prove・6 | PASS | basecaseとinductionの成立が必要 |
| cover到達 | cover・6 | PASS | 到達の証拠が必要。安全性の証明ではない |
| cover未到達 | cover・6 | FAIL | 到達なし。assert違反とは区別 |

6条件は最初の縦方向の予備検査であり、P3全体の完了基準ではありません。正式比較にはVHDL・Verilog、制約、SMTとproperty、元回路の反例再実行、複数property、空虚な前提も含めます。unknown、timeout、cancel、solver crash、status破損、witness欠如、hash不一致を一つずつ注入して非成功を確認します。正式試行は清浄な同一commitで各5回以上、順序を交互にし、A/Aを2回行います。中央値・最小・最大と生CSV、全列の独立監査、raw log、tool版、hash、失敗試行を保存します。

## 固定する条件と手順

nativeは参照・測定用で、製品runtimeではありません。固定sourceとP2で照合したsolverを使い、SBYの並列数を最初は明示的に1へ制限します。nativeとPyodideの証明条件は同じにし、輸送境界とその待機方法だけを変えます。

予備native検査の再実行コマンドは次のとおりです。manifestは[P2の生成手順](S15-solver-native-wasi.md)で作ったprobe directoryを指定します。出力先が存在する場合は上書きせず停止します。

```sh
node scripts/probe-upstream-formal.mjs \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --out build/S15/p3-native-upstream-1
node scripts/probe-formal-python.mjs --out build/S15/p3-python-runtime-probe-3
```

## Pyodideの能力診断

Node v24.21.0、npmのPyodide 314.0.7に含まれるPython 3.14.2を実行しました。`sys.platform`は`emscripten`、`os.name`は`posix`です。importできることと、実際の操作が可能なことを分けて調べました。

| 境界 | 実際に行った操作と結果 |
|---|---|
| resource | importでModuleNotFoundError |
| subprocess | importは成功。PopenはOSError 138でprocess非対応を返す |
| threading | importは成功。Thread.startはRuntimeErrorで拒否 |
| fcntl | importとF_GETFL定数の取得は成功。仮想processのFD監視は未確認 |
| select | importと空FD・待ち時間0の呼出しは成功。仮想pipeの待機は未確認 |
| signal | importは成功。仮想processの停止・process groupは未確認 |
| sqlite3 | importとin-memory databaseのSELECT 1が成功 |

この診断から、SQL処理を作り直す必要は示されませんでした。一方、原本がposixという条件だけで使うresourceとPopen、reader threadは、そのままでは動きません。importの成功だけをブラウザー対応済みとしません。

## 原本で確認した境界

固定SBYの`sby_core.py`はbash経由のPopen、fcntlのnonblocking指定、select、process groupのsignalを使います。`sby_jobserver.py`は並列数1ならpipeを作りません。Yosysの`smtio.py`はsolverのPopenとreader Thread・Queue、signal、resourceのstack limitを使います。SQLite、proofとSMTの処理は元のPythonを維持し、これらのprocess輸送だけを狭いpatchで接続する方針です。

原典は固定gitlinkの[SBY core](https://github.com/YosysHQ/sby/blob/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/sbysrc/sby_core.py)、[jobserver](https://github.com/YosysHQ/sby/blob/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/sbysrc/sby_jobserver.py)、[status](https://github.com/YosysHQ/sby/blob/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/sbysrc/sby_status.py)、[Yosys smtio](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/backends/smt2/smtio.py)です。URLとSHAは`.gitmodules`と`git ls-tree HEAD`から取得しました。

## 失敗と未確認

最初の能力診断は、resourceがないときの診断器のexcept処理が未登録の辞書要素へ書き込み、KeyErrorで停止しました。診断器を直した2回目を上表の根拠とし、初回を成功として数えません。両方のログと2回目の実行scriptを保全しています。

## native原本の予備基準

P2の固定native solverを使い、原本SBY・Yosys・yosys-smtbmcを縦方向に実行しました。Yices2とZ3の両方で、上表の6条件、計12条件が期待したstatusと終了コードになりました。同じ条件をもう一度実行した予備試行も12条件が一致しました。5回の正式反復やnative/Pyodide比較ではありません。

特に短いproveでは、basecaseの`passed`に対してinductionは`Temporal induction failed!`となり、全体は`UNKNOWN 4`でした。生成した`trace_induct.vcd`と`trace_induct.yw`は帰納法の反例であり、初期状態から到達する元回路の反例として扱えません。不変条件のproveでは、basecaseとinductionがともにpassedで、上流のsummaryがk-inductionの成立を報告しました。

coverの到達はstep 4で、VCDとYWを生成しました。未到達のcoverは`FAIL 2`ですが、assert違反とは区別します。BMCの短いprefixは`PASS 0`でも、有界の確認にとどまります。検査器はmodeとstatusを分けて保持し、status file・終了コード・SBYの最終行の不一致と不正なstatusを拒否します。

予備出力には入力、設定、全stdout/stderr、SMT、制約、VCD、YW、SQLiteと全ファイルのsize/SHA-256を保存しました。診断3では配布Pyodideの5資材のsize/SHA-256も記録しました。原本のPythonと実行scriptのhash、実tool版、未commitの変更を含む状態は各metadataに記録しています。この2試行は未commitの予備結果で、清浄な提出commitを検証したものではありません。

SBY原本のPyodide実行、nativeとのstatus・trace・制約比較、正式反復、UI、ブラウザーの展開器、実機は未完了です。空FDのselectとsqlite3の単独queryを、P3の接続成功として扱いません。

## 原本SMTBMCの仮想process接続（予備）

原本SBYがnativeで生成したSMTを変更せず、原本SMTBMCから実WASI solverを呼び出しました。Yices2とZ3それぞれ8条件、計16条件です。proveだけはbasecaseとinductionを別々に検査し、この段階ではSBY全体のproof判定を置き換えません。

`patches/yosys-smtio-process.patch`はPopen、reader Thread・Queue、processの停止とresourceへの接続だけを変えます。Python workerが同期読取りで待っても、managerとsolverの独立workerは動作を続けます。stderrは原本が指定するSTDOUTへまとめ、書込みを直列化します。親の取消は子solverの終了記録も待ちます。Python例外はSystemExitと区別してruntime-errorにします。

`p3-engine-preliminary-4`と`-5`では16条件すべてで終了コード、ログ、全入力・VCD・YW・Verilog testbenchがnativeと一致しました。ログの経過時刻prefixだけを比較から除き、他のbyte差は隠していません。いずれも未commitの予備結果であり、提出commitや製品全体の検証ではありません。

```sh
python3 scripts/build-formal-python.py --out build/S15/p3-formal-python-assets-5
node scripts/probe-formal-python-engine.mjs \
  --sources build/S15/p3-formal-python-assets-5 \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --baseline build/S15/p3-native-upstream-2 \
  --out build/S15/p3-engine-preliminary-6
```

資材生成器はgitlinkの原本からstageし、stageだけへpatchを適用します。SBY・SMTBMC・witness・Clickとlicenseの原文は変更しません。SMTIO全体のASTは、process接続だけをnativeの形に戻すと原本と一致します。`sat`を`unsat`へ改変する負の対照も拒否しました。資材の再生成一致と上書き拒否を含むPython検査25件、Web単体253件が成功しました。単体には実Pyodide・WASIの小さなfixtureも含みますが、UI検査ではありません。

`p3-engine-preliminary-7`では、実行したsource・patch・依存lockとPython資材を保存し、solverのnative/WASI双方から実際の版表示を取得しました。生CSV全16行13列を`python3 scripts/audit-formal-python.py build/S15/p3-engine-preliminary-7`でraw log・終了記録・全artifactと独立に照合しました。各列の改変13種、VCDの欠落・改変、worker異常・signal・stderr・重複行を拒否する監査器の単体検査も追加しています。この監査は予備結果専用で、正式反復やsource closureの完了を意味しません。

清浄な実装commit `81b227eb57121191356e40978bde6474ab57c5aa`からPython資材を再生成した`p3-engine-preliminary-8`でも、16条件が一致し、Web単体253件・Python検査25件が成功しました。[生CSV](S15-smtbmc-process-preliminary.csv)全16行13列の独立監査も成功しました。Yicesは両系2.7.0、Z3は両系5.3.3と実行時の版表示で確認しました。nativeは64 bit、WASIは32 bitです。これはNodeでの予備比較であり、各5回とA/A、ブラウザー操作、独立した反例再実行、実機の確認ではありません。

初期の失敗を含むraw log・全artifact・source snapshot・Python資材とlicenseを証拠ZIP `S15-smtbmc-process-evidence-81b227e.zip`へ保存しました。[ファイル目録](S15-smtbmc-process-files.csv)の全サイズ・SHA-256をZIPの再読込みで照合し、[ZIPのSHA-256](S15-smtbmc-process-evidence.sha256)も記録しました。`bin/`のsymlinkは実行用の別名なので目録に含めず、実バイナリーのhashと実行時の版表示はbuild metadata・version logへ記録しています。solver binary自体の出典・clean build・生ログは[P2の正式記録](S15-solver-native-wasi.md)を参照します。

失敗試行も保持します。最初の手動probeはmanifestのruntime keyとbinaryのpropertyを取り違え、その後はadapterにwaitがなく停止しました。比較driverの初回はlocal変数がNodeのprocessを隠して停止しました。初めて全16条件を試した`preliminary-3`では、反例・coverの生成中に原本が呼ぶpollが未実装で6条件が失敗しました。waitとpollを接続した後に上記の一致を確認しています。AST検査の初回はnormalizer自身が空要素を残して不一致となりました。normalizerだけを直し、原本の判定処理は変更していません。

この層にはSBYのprocess起動、Yosys子workerとのfilesystem反映、仮想selectをまだ実装していません。資材生成器のGitなし配布ソースへの接続、独立全列監査、清浄commitでの正式5回・A/A、元回路による反例再実行、画面統合も残件です。

## Yosys子workerとファイル差分の予備検査

目的はSBYが生成したYosys scriptを、ブラウザー内の独立workerで実行し、親の作業領域を壊さずに成果物だけを返すことです。既存の固定版Yosys WASIと配布用share tarをSHA-256で照合してから起動します。元のYosysのコマンドを実行し、合成や証明アルゴリズムは変更しません。現段階はYosys子worker単体の予備検査であり、SBY本体への接続、正式反復、画面上での確認ではありません。

元のWASI preopenで`.`を作業ディレクトリーへ割り当てるだけでは、そのcapability rootから隣の`../src/top.v`を読めず、Yosysは終了コード1でした。専用の`workingDirectory`で`.`を追加し、許可される親を`/`のpreopen内に限定したところ、隣のファイルを読み、JSONを出力して終了コード0になりました。別のrootと親参照の循環は拒否します。`tests/synth/wasi-p1.test.mjs`には失敗する元の構成も負の対照として残しています。

子workerは`yosys -ql design*.log design*.ys`だけを受け、作業ディレクトリーと入力のpath・件数・合計サイズを検査します。元の作業領域のsnapshotと子の結果との差から変更、追加、削除だけを抽出し、変更前と変更後のSHA-256を付けます。適用前にframe長、path、hash、現在の親ファイルとspawn時snapshotの衝突を確認し、すべて通ったときに更新後のファイル一覧を返します。親が独自に書いたlogは差分にない限り保持します。破損したbinary、shell構文、作業領域外のpath、競合、欠落・余剰byte、改変されたpayloadを負の対照で拒否しました。差分の親Pyodideへの反映は未接続です。

再実行には製品用の`build/synth/yosys.wasm`、`build/synth/yosys-share.tar`とmanifestが必要です。Node単体は作業領域の差分だけを検査し、実WASI試験は固定版のbuild資材を使います。計測値やnativeとの一致は、この予備試行から主張しません。

```sh
node --test tests/web/formal-workspace.test.mjs
node --test tests/synth/wasi-p1.test.mjs tests/synth/formal-wasi.test.mjs
```

初回はpreopenの選択順でも解決できず、最初のcwd祖先検査には循環を検出する処理がありませんでした。両方を修正し、負の対照を追加しました。上記の予備試行では単体2件と実WASI13件が成功しましたが、清浄な提出commitでの再検証とSBY全体比較はまだです。通常のYosys解析エラーも終了コード1とlogを返し、輸送の失敗と区別します。
