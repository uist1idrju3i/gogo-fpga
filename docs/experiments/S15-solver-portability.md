# S15 P4 追加ソルバーの型幅と未対応process境界

- 状態: 境界検査の正式5回・A/A 2回と全列監査が成功。SMTBMC接続・製品認定は未完了
- 基準: [追加ソルバーの診断](S15-extra-solver-builds.md)、[S15の共通基準](S15-formal-verification.md)
- 戻り先: [実験索引](README.md)

## 目的と変える条件

前段で見つけたBTOR2のID切り詰めとBoolectorのgzip API traceの未初期化参照を、WASI向けの最小patchと実行で調べます。固定したsource・依存・compiler・最適化・memory上限は前段から変えず、能力一覧は無効のままです。上流への投稿は行いません。

WASIのlongは32 bitであり、int64_tを `labs(long)` へ渡すと幅を失います。`btor2tools-wasi-ids.patch` は4箇所を `llabs(long long)` へ置き換えます。nativeの64 bit longは変更せず、SMT処理や判定アルゴリズムを置換しません。API traceのpatchはWASIのgzip要求をstderrとabortで拒否し、外部processの成功を装いません。上流sourceを直接編集せず、隔離したbuild sourceだけに適用します。

## 結果を見る前の基準

1. 固定sourceへfuzzなしで適用でき、実際に使うpatchのsnapshotとhash、driverと全コマンド、ログ・終了状態・binary hashを保存すること。失敗した出力先は再利用しません。
2. 原本のBTOR2 parserへ小さな有効入力を与え、公開のID検索APIで32 bitを越える正負IDが既存行へ化けないことをnative/WASIで確認します。巨大なtableを作ってmemory不足を試す検査にはしません。原本WASIが誤って既存行を返す負の対照も確認します。
3. WASIのgzip API traceで診断が出て成功扱いにならないことを確認します。未初期化参照はコンパイラーと原文から確認した問題であり、原本で未定義動作が毎回同じ結果になるとは仮定しません。
4. patch後のビルドで上記の型幅・未初期化警告が消え、前段のCLI 5条件が維持されること。別の警告は捨てずに記録します。
5. 予備診断の後に清浄な同一commitへ固定し、A/A 2回と正式5回、全列の独立監査とhash・欠落の負の対照を行います。今回の境界検査をSMTBMC/SBYの正式認定や製品配布の確認とは扱いません。

実行中のスクリプトは変更しません。基準commitとworktree、実際のツール版、ホスト条件、入力・出力・測定資材のhash、生CSVを保存し、失敗試行も結果へ残します。

## 予備診断（正式反復とは別）

最初の清浄な実装commit `be04b41b7211c444aee55f9af97db01764956691` でBoolector 3.2.4のnativeとWASIを再ビルドしました。nativeは2,861,824 byte（SHA-256 `19fbca1674a11dfa9caee74292203624de002fdcb43a31667ebb580129e27067`）、WASIは2,116,022 byte（SHA-256 `043b2d62ed145e59d5aa87ca0b22caa7fb69ec6bd829504b74453b0a1832dd24`）です。前段と出力ディレクトリーが異なり、バイナリーのbyte一致を前提にしません。`scripts/probe-extra-solver-cli.mjs` による版・ヘルプ・SMTの値とpush/pop・EOF・構文エラーの5条件はnative／WASIで一致しました（計10実行）。このCLI診断はSBYの認定ではありません。

原本のID検索では、nativeの大きなIDが未定義の行を返さなかったのに対し、WASIで正負の大きなIDが既存の行1に化けました。原本の負の対照はnativeが終了0、WASIが終了23で、いずれもsignalなしです。修正後の正負14値は両方とも終了0で全行一致しました。gzip API traceはnativeがgzipを出力し終了0、WASIがstderrに明示的な拒否理由を出し `runtime-error` で停止しました。通常のtraceは両方とも終了0です。WASI workerの入力は7 byte容量に3 byteごとに渡し、stdinのEOF、stdout／stderr、終了状態を別々に記録しています。生データは [修正後の6行21列](S15-solver-boundaries-preliminary.csv) と [原本の2行21列](S15-solver-boundaries-control-preliminary.csv) に保存しました。この時点では正式反復前であり、配布条件・SMTBMCへの接続も未完了でした。

ビルドログに残るCaDiCaLのGit識別子未検出、WASIの`getpid`エミュレーション警告、未使用変数・未使用関数などは削除していません。今回狙ったBTOR2Toolsの `labs(long)` とBoolector traceの未初期化参照という2種類の警告は、修正後のビルドログでは出ていません。CaDiCaLの `getpid` は乱数初期化にも関係するため、警告が残る限り製品認定の根拠とはしません。

## 正式5回とA/A 2回

計測器と監査器を `272d54f3c8c930d30696ce18c3d5b6e46caadca8` に固定し、清浄なworktreeで実行しました。上記の `be04b41` のsolver本体・静的libraryをhash照合して再利用し、このcommitから補助probeのnative/WASI・修正後/原本対照の4組を作り直しています。compilerはnativeがGCC 11.4.0、WASIがSDK 34.0のclang 23.1.0です。ホストはUbuntu 22.04.5、Linux 6.8.0-1061-aws、x86_64、2 CPU、全memory 8,327,749,632 byte、Node v24.21.0でした。詳細な版出力、flag、libraryの全hashとbuild logを証拠に保存しています。

A/Aは `AA-01`、`AA-02`、正式反復は `formal-01` から `formal-05` の順です。各回で修正後のnative/WASI 6実行を行い、続けて原本ID対照の2実行を行いました。A/Aの16行と正式40行は全て期待どおりで、独立監査器が生CSVの全21列を生出力・binary・build metadataと照合しました。[正式CSV](S15-solver-boundaries-formal.csv)と[A/A CSV](S15-solver-boundaries-aa.csv)は、元の21列に `run` を加えた22列です。`summarize-extra-solver-boundaries.py --check` で各回の生CSVから再生成して一致を確認できます。

| 条件 | 正式5回での結果 |
|---|---|
| 修正後のID検索 | 正負14値のstdoutがnative/WASIで一致し、終了0 |
| 原本ID対照 | nativeは終了0。WASIは同じ大きなIDが行1へ化け、全5回で終了23 |
| 通常のAPI trace | native/WASIとも終了0で、元のtrace形式を確認 |
| gzip API trace | nativeは展開後の形式を確認し終了0。WASIはstdout 16 byte、stderr 51 byteの明示診断で `runtime-error`、終了値はnull |

全7回で各条件のstdout/stderrと終了状態は安定しました。nativeのtraceにはprocessごとのpointerが入るため、そのhashの反復一致やnative/WASI間の全byte一致は主張しません。元のbyteとhashを残し、通常traceとgzip展開後の構文・出力を独立に検査しています。正常終了したWASIのlinear memoryは33,554,432 byteです。nativeとWASI trap時のmemoryはnullであり、RSSや0として読み替えません。

次の時間は正式5回の補助probeの値です。workerの起動・輸送も含むため、solverの探索性能の比較には使いません。単位はmsです。

| 条件 | native 最小/中央値/最大 | WASI 最小/中央値/最大 |
|---|---|---|
| 修正後ID | 1.338 / 1.623 / 3.010 | 38.085 / 42.300 / 61.907 |
| 通常trace | 1.947 / 1.973 / 2.316 | 38.558 / 38.781 / 45.183 |
| gzip trace | 3.083 / 3.448 / 3.794 | 31.627 / 32.201 / 36.615 |
| 原本ID対照 | 1.252 / 1.278 / 1.327 | 36.762 / 37.508 / 47.884 |

## 独立監査と証拠の復元

監査器は `status` を含む全21列のそれぞれを変える負の対照、stdoutやbinaryの改変、ファイルの欠落・余剰、コピー後の再監査を単体6件で確認しました。正式14出力先の56行に加え、最終予備2出力先の8行もZIPから復元し、復元した監査器で全列を再監査しています。これはCLI/API境界の確認であり、SMTBMC/SBYでの証明、solverとしての採用、製品配布や画面の検証ではありません。BoolectorとBitwuzlaは能力一覧で無効のままです。

証拠のpayloadは634ファイルです。`s15-boundary-evidence-03.zip` は8,793,501 byte、SHA-256は `b49cbd9bc1632b78f9f809a6acc5f2e67d60348fd110d299aab403c2b6d0f432`、`manifest.json` のSHA-256は `cc96a399fdd67046a045dcd1f84fc493cc67977f33109969f3b77a92e51a8421` です。manifestの全path・size・hashとZIPの全件一致を確認しました。source treeやobjectを全て含む配布ソースではなく、固定pin、driverとpatchのsnapshot、実際のbinary/library、build log、生の入出力、計測と監査の記録です。

初期の原本probeは32 bit最小値への縮小による未定義動作を避けるため、対照に使う入力を絞って再実行しました。初期runnerには監査用のrepositoryと時刻の記録も不足していたため、初期の予備出力と補正後の出力を別に保存し、正式結果へ混ぜていません。初回の独立監査はbuild本体の `exit_status` と補助buildの `exit_code` を取り違えて停止しました。修正後は両方を区別して照合しています。文書検査でCSVが未追跡と判定された初回ログも残し、追跡対象へ加えた後に再検査しました。

## 再実行の入口

```sh
python3 scripts/build-solver-probe.py --solver boolector --runtime native --jobs 2 --out build/S15/portability-native-01
python3 scripts/build-solver-probe.py --solver boolector --runtime wasi --jobs 2 --out build/S15/portability-wasi-01
python3 scripts/build-extra-solver-boundaries.py --probe-build build/S15/portability-native-01 --out build/S15/boundary-native-01
python3 scripts/build-extra-solver-boundaries.py --probe-build build/S15/portability-wasi-01 --out build/S15/boundary-wasi-01
node scripts/probe-extra-solver-boundaries.mjs --native build/S15/boundary-native-01 --wasi build/S15/boundary-wasi-01 --out build/S15/boundary-results-01
python3 scripts/audit-extra-solver-boundaries.py --input build/S15/boundary-results-01
```

補助probeはbuild metadataのcompilerと明示的なCFLAGS・link flagsを再利用し、実際の全コマンドを別に記録します。CMakeが追加する既定のflagまで同じものとは扱わず、補助probeの所要時間を製品solverの性能として比較しません。

IDの原本対照はbuild・実行コマンドへ `--unpatched-ids` を加え、別の未使用出力先で生成します。原本で32 bitの最小値への縮小に伴う未定義動作を持ち込まないため、補助probeの `--alias-only` 指定で正負2,147,483,648の2件を除きます。大きなIDから行1へのaliasという決定的な誤りと、修正後の全14値の検索を分けて検査します。

正式反復の出力名は `boundary-{patched,unpatched}-{AA-01,AA-02,formal-01,...,formal-05}` です。補助buildの4組を同じ版へ固定してから、各出力名に対して実行・監査コマンドを繰り返します。集計と証拠ZIPは次で作り直せます。既存出力は上書きせず、復元時も元のGit commitを照合します。

```sh
python3 scripts/summarize-extra-solver-boundaries.py --check
python3 scripts/package-extra-solver-boundaries.py --out build/S15/boundary-evidence-new.zip
python3 scripts/audit-extra-solver-boundaries.py --input <restore>/build/S15/boundary-patched-formal-01 --evidence-root <restore> --git-repo .
```
