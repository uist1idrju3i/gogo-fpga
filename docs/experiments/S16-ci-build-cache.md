# S16 CIの出力キャッシュと所要時間

- 状態: 改善前の成功5 runを収集。実装後のCI時間と公開資材のcold/warm一致は未確認。
- 日付: 2026-11-13
- 関連: [調査の索引](../../RESEARCH.md#7-分割した調査)、[CIキャッシュの保守](../research/ci-build-cache.md)、[S8](S8-ci-speed.md)、[S8B](S8B-pyodide-parity-shards.md)

## 目的と仮説

毎回のコンパイルを、固定入力に対応する出力の復元と全ファイル検査に置き換えます。既存の全ての機能検査を残したまま、producerジョブの時間を短縮する仮説です。測定の結果、約1時間の大部分がコンパイルという当初の想定は外れました。最新mainではCPU parityが34分41秒、E2Eの検査が11分31秒かかり、Yosys両版は既に出力キャッシュにhitしていました。

## 改善後の採否基準

以下は改善後のCIを測る前に決めます。今回はPRを開かないため、実装後の採否と時間の記入は後続CIで行います。

1. mainのcold buildと、同じpin・flags・imageのwarm buildで、公開する各ファイルのSHA-256が全て一致すること。Pagesが別途書く `publication-info.json` だけを比較対象から除きます。ログやnative GHDLの未正規化の中間物は公開物の一致に混ぜません。
2. 各runで既存の全必須検査が成功すること。PRからのcache saveは0件、改変・不足・余分なファイル・権限違いの負の対照は全件拒否すること。
3. 同じ入力でcold/warmを交互に各5回以上比較します。warmのproducer実行区間の中央値がcoldより60秒以上短く、全体の実行区間中央値がcoldから5%を超えて悪化しないこと。復元・hash・保存の時間を含め、cache容量と最大RSSも併記します。

今回の改善前5 runは異なるcommitの観測で、上記の交互試験の代わりにはしません。実機のTang Nanoは対象外で、本リポジトリでは試していません。

## 固定条件と計測器

| 項目 | 条件 |
|---|---|
| 実装の基準 | `5c45a04`。改善前の詳細ログはmain `6c7e81f9449d324492890afc46797739ec6b3524` |
| runner | `ubuntu-26.04`。詳細ログのproducerは `nproc=4`、`free -g` のMem合計15 GiB |
| 実際のimage | 同じrun内に `20261101.186.1` と `20261111.196.1` が混在。新キーでは区別する |
| 実ログの版 | Node v24.22.2、npm 11.19.1、emcc 6.0.13、clang 24.0.0git、Chromium Headless Shell 156.0.8078.4 |
| その他の版 | 各commitのpinとgitlinkを参照。既存ログで全てのSDK実行ファイルの版を採取できたとはしない |
| 出力 | 各ジョブの `build/`、組立後の `public_html/`。coldではコンパイラーを起動し、warmでは検証済み出力を使う |
| 変える条件 | 出力キャッシュ、広い入力キー、整合性検査、mainのみの保存 |
| 変えない条件 | コンパイルのコマンドとflags、parityの入力と比較、sim、E2E、配布物の検査、公開の承認 |

job/stepの `completed_at - started_at` を整数秒で求めます。runの作成から完了までにはconcurrency待ちも含まれるため、最初のjob開始から最後のjob完了までの実行区間も区別します。並列jobの時間は合算しません。生データは [CSV](S16-ci-build-cache-before.csv) に全job・stepと時刻、run ID、attempt、SHA、結論を保存しました。CSVは284,220 bytesです。初稿のCRLFをLFへ揃え、値は変えていません。

基準mainの全gitlink一覧は `git ls-tree -r 6c7e81f9449d324492890afc46797739ec6b3524` から得られます。modeが160000の行を抽出した一覧のSHA-256は `dd439719aa6d648b99ed695fc4b7d0172b56f9cac23f9b5e690c03a20e8a89c9` です。

## 改善前の結果

全てattempt 1、build.ymlがsuccessのrunです。選択は直近のmain/PRの成功runで、同一条件5回の試験ではありません。

| run ID | event / SHA | 作成から完了 | 実行区間 |
|---|---|---:|---:|
| [43358334397](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43358334397) | main / `6c7e81f` | 54分48秒 | 54分45秒 |
| [43334227479](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43334227479) | PR / `5677455` | 51分43秒 | 51分40秒 |
| [43332364067](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43332364067) | main / `8ce027b` | 91分24秒 | 57分42秒 |
| [43325158485](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43325158485) | PR / `3da1346` | 50分23秒 | 50分00秒 |
| [43323487318](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43323487318) | main / `3352f05` | 95分31秒 | 52分56秒 |

実行区間の中央値は52分56秒、最小50分、最大57分42秒です。作成からの時間が長い2 runは、最初のjobが始まる前に待ち時間があります。

次表は直近のmainとPRです。数値は秒。主要stepはmain / PRの順で記します。

| job | main | PR | 主要stepと秒数 |
|---|---:|---:|---|
| Changes | 6 | 11 | checkout 3 / 5 |
| Yosys WASI synthesis | 52 | 64 | submodule 15 / 15。両版のコンパイルはcache hitで省略 |
| Yosys native synthesis | 24 | 29 | submodule 10 / 9 |
| nextpnr WASI place and route | 263 | 275 | WASI/chipdb 132 / 129、native 81 / 81 |
| GHDL WASM synthesis | 343 | 296 | WASM/native 252 / 240 |
| Icarus Verilog WASI build and comparison | 340 | 258 | WASM/native 243 / 187 |
| Surfer WASM build | 191 | 168 | build/license 166 / 142 |
| Yosys WASM/native comparison | 14 | 23 | parity 3 / 3 |
| nextpnr WASI/native comparison | 20 | 31 | parity 3 / 4 |
| Build | 276 | 321 | openFPGALoader 95 / 98、submodule 56 / 83、Web単体 52 / 53 |
| Pyodide gowin_pack (cpu) | 2140 | 2059 | parity 2081 / 1996 |
| Pyodide gowin_pack (hdl) | 1128 | 1034 | parity 1044 / 942 |
| Simulation shard 1 | 219 | 210 | sim 210 / 199 |
| Simulation shard 2 | 211 | 159 | sim 201 / 147 |
| Simulation shard 3 | 214 | 212 | sim 203 / 200 |
| Simulation shard coverage | 9 | 7 | 資料取得 1 / 1 |
| Playwright E2E | 790 | 715 | browser検査 691 / 624 |

最新mainのログには `S8-CACHE synth hit=true valid=true` とnativeの同じ判定があります。E2Eは `needs: pyodide-pack` によりCPU parityの終了後に始まっています。コンパイルが主因という仮説に対し、コンパイル時間の短さと既存Yosys hitを反証として確認しました。出力キャッシュだけで約1時間を大幅に削るとは見込みません。GHDL/Icarusの約4分のコンパイルを主に短縮し、全体では数分の改善を予想します。復元時間込みの実測ではありません。

## 再実行と改善後の観察

```sh
python3 scripts/ci-build-timings.py \
  --run 43358334397 --run 43334227479 --run 43332364067 \
  --run 43325158485 --run 43323487318 \
  --output build/ci-before.csv
gh run view 43358334397 --log > build/ci-before.log
python3 -m unittest discover -s tests/check-ci-cache -v
```

計測器は既存出力を上書きせずに止まります。日時の90秒差と0秒差、逆転と不正日時をテストします。キャッシュは同じ入力のA/Aキー、copy復元前後の全ファイルmanifest、実行権限、1 byte相当の改変、不足、追加、symlinkの差を負の対照で調べます。

初回PRは新namespaceのmissで、PRからは保存しません。mainへのマージ後のpushが保存元になります。次のPRではsummaryのcomponent別 `verified-hit` とキーを読み、コンパイルstepがskippedでも全機能検査が実行されたことを確かめます。image、aptの版、pin参照元の変更やevictionはmissの理由として記録します。親commitの日付を含むopenFPGALoaderは、別日付のPRではmissになる制約があります。

公開物は同じ内容のcommitをmainで `cache=false` と通常の手動実行に分けて比較できます。PRと手動実行は保存せず、main push/scheduleの保存済みキャッシュを通常実行だけが復元します。cold/warm各5回は交互にし、日付・ImageVersion・キー・全検査・artifactのhash・転送時間・最大RSS・cache容量を併記してください。mainのSDK/出力のキーが一致しない組はペアにしません。

## 未確認と失敗の扱い

改善後のCIはまだ実行していません。冷たい再コンパイルとの公開物全byte比較、CI上の破損注入、速度、最大RSSと保存後容量は未確認です。ローカルのcopy復元が成功しても、これらの代わりにはしません。既存APIでは49 cache、合計7,855,118,243 bytesが残っていました。新namespaceの移行期は容量とevictionを必ず観察します。既存cacheの削除は行いません。

新しいパス別省略はrequired checkとparityの保証を変えるため採用しません。UIだけの変更も全検査を通します。S8の中止・差分・未達項目の記録は保持します。本試行では改善後の失敗runをまだ収集していません。失敗や中止が出た場合は、成功runだけに置き換えず、同じCSV形式で理由とともに追加します。

実装時はcomposite action案を試しましたが、zizmorのself-repository警告が出ました。推奨の `$/` 参照は固定したactionlintが拒否しました。どちらの検査も緩めず、workflowへ直接展開する案に変更しました。CSVのCRLFによるwhitespaceエラーも修正しました。

基準mainの取得ログのSHA-256は `3541db4eadb57ddcb91ea2f979ee40cade1d134c83d87548e5dffe6318b22642`。ログは上のコマンドで再取得できます。GitHubのstep名の表示方法が変わる場合は、取得時のhashとAPIの時刻を区別してください。

## 後続: parityとPlaywrightの分割

キャッシュのみの実装 `32fd44ae9ebd9e3539958fd8b4395f76d4ce753d` を基準に、同じbranchで検査を分割します。改善後の時間はまだ測っていません。以下はrun 43358334397の個別テスト時間から作った予測で、採用後の実測ではありません。個別値と準備費は [分割前CSV](S16-shards-before.csv)、固定した割当は `tests/ci-shards.json` に保存します。未計測のpublication-info specは10秒を仮置きし、通常は無効なS5の4件は0秒とします。

CPUは28組をコア単位で4分割します。同じコアの4ボードを同一processへ残し、合成netlistのボード間比較と正常・故障注入の実行結果を共有する既存の検査を失わないようにします。HDLは32組をボード別に2分割します。約244秒ずつのEthernetの4組を2組ずつに分け、HDLの独立scoreboard、通常pack、負の対照、形式検証と反例再実行はHDL-1だけで実行します。

| shard | 割当 | 測定済み検査の合計 | 準備込みの目安 |
|---|---|---:|---:|
| cpu-1 | hazard3の4ボード | 574.6秒 | 約10.6分 |
| cpu-2 | darkriscv・femtorvの4ボード | 432.0秒 | 約8.2分 |
| cpu-3 | neorv32・servの4ボード | 494.2秒 | 約9.2分 |
| cpu-4 | picorv32・vexriscvの4ボード | 576.1秒 | 約10.6分 |
| hdl-1 | 4K・9K、通常pack・負の対照など | 約530秒、別に形式検証 | 約10〜11分 |
| hdl-2 | 1K・20K | 約510秒 | 約9〜10分 |
| E2E-1 | synthesis・workflow・OpenRouter認証・Surfer | 327.8秒 | 約8分 |
| E2E-2 | VHDL・simulation・WebUSB・AI・IDE・公開情報・S5 | 323.1秒（仮置き10秒を含む） | 約8分 |

CPUのjob準備・終了処理は59秒、HDLは形式検証を含め84秒でした。Pyodide自体の初期化は2.7〜2.8秒です。既存artifactからnative参照とpack資材を各jobへ渡し、コンパイルは繰り返しません。3 CPU shardではコア単位の割当が約767.5秒に達し、準備を足すと12分を超えるため4個にしました。さらに小さくすると準備・ダウンロード・Pyodide初期化とCPU正常系の再実行を増やすため採用しません。

E2Eはspec全体を一つのshardに置きます。job準備99秒とglobal setup・server約50秒をそれぞれ繰り返します。最長のsynthesis specが265.7秒なので、3分割でもその下には短縮できません。2分割からの改善は約1分にとどまり、追加の準備費が大きいため2個を選びました。workers=1、検査内容、timeoutを維持し、retryは元と同じ0回です。S5の無効条件はcollection時に同じ条件で宣言し、通常の4 skipを一覧にも反映します。新しいskipは許しません。

### 網羅性とrequired check

parityでは各processが元の全4ファイルを読み、登録された全leafの一覧と割当を出力します。実行済み一覧はNodeの実際のpass/failイベントから取得します。matrixの親はcontainerとして扱い、28 CPU・32 HDLの各組を一回ずつ数えます。独立scoreboardの8子テストや通常テストも検査対象です。全shardのcollection一致、割当と実際のpassの一致、既知の全matrix組、失敗・不足・重複を検査します。形式検証の別stepはHDL-1だけに残します。

E2Eは毎shardでPlaywrightの全件 `--list` を取得した後、割り当てたspecだけを実行します。全件一覧の一致、全specの割当、全test IDの和集合、結果1件、期待したstatusを検査します。既存S5の4 skipは全件一覧で確認できる場合だけ認めます。結果がない、余分、失敗、予期しないskip、retry、途中終了、artifact不足のいずれもcoverageを失敗させます。

`Pyodide gowin_pack (cpu)`、`Pyodide gowin_pack (hdl)`、`Playwright E2E` は同名の集約jobとして残します。元のChanges判定でbuildを行う場合は `always()` で実行し、shard群とcoverageの両方がsuccessでなければ失敗します。cancelledやskippedは成功扱いにしません。Changesで元から全buildを省く文書差分は、これまでと同じくbuild群全体を省きます。coverage jobも `always()` で不足資料を検出します。

### job数と期待する実行区間

build.ymlのmatrix展開後は17から27 jobへ増えます。parityは最大6並列、E2Eは最大2並列に制限します。parityの6個とsimulationの3個が重なる段階でも約9並列で、このworkflowだけならpublic repoの20並列枠内です。別workflowや別PRと枠を共有すると待ちが出るため、作成からの時間と実行区間を引き続き分けます。

warm時はproducer約1〜6分、parity約11分、coverage・集約、E2E約8分で、全体約21〜26分を予想します。HDLとCPUは並列なので足しません。coldのコンパイラー再構築やqueueを含む上限の保証ではありません。改善後は同じpin/imageで各5回以上測り、各shardの12分程度の目標、準備費、全体中央値、全coverageと集約の成功を確認します。基準に届かなければ個別durationと準備時間を併記して再配分します。実機の計測ではありません。

実行例は `node scripts/run-ci-shard.mjs pack cpu-1 build/ci-shards/parity-cpu-1` と `node scripts/run-ci-shard.mjs e2e 1 build/ci-shards/e2e-1` です。既存出力は上書きしません。coverageは `node scripts/check-ci-shards.mjs pack shard-results` と `node scripts/check-ci-shards.mjs e2e shard-results` で再実行できます。実際の分割後CI、全parityと全E2Eの再実行は後続CIで確認する残件です。

回帰テストの初回には、Nodeのprogrammatic runnerが検査用 `-e` の起動引数を子へ継承し、検査用launcher自身を再実行しました。追加のexecArgv指定では継承を消せなかったため、CIと同じ通常のmoduleファイルを起動する負の対照へ直します。productionの呼び出しは元から通常のscriptです。失敗、除外、重複出力拒否を実際のNodeイベントで検査し、Playwrightの全件collectionは116件・11 spec・既存skip 4件であることを照合します。

追加で独立scoreboardのローカル実行も試しましたが、既存のnative参照 `build/iverilog-native/output/ivlpp` が未配置で失敗しました。Node 24の環境は読み込み済みで、欠けているのはnative出力ディレクトリーです。参照先を選ぶ既存helperは変更していません。CIではIcarus producerの成果物を取得する既存のstepを維持します。このローカル実行を成功とは数えず、全parityの実行確認は残件にします。
