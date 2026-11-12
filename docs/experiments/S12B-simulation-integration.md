# S12B シミュレーション統合の回帰検証

[実験一覧](README.md)へ戻る。

## 目的と条件

T4のIcarus実行、VCD選択とSurfer表示を確認し、シミュレーション用に追加したtimescaleが4ボードのbitstreamを変えないことを検証します。初回UI実装の基準commitは `964b1465efb7ef0ef7c52032151b876ebf7c93c7`、最終回帰の基準commitは `c19c69fb0c2a0853b83c5386de11754bebf7b01d` です。bitstreamの回帰検査は `tests/synth/gowin-pack.test.mjs` にあります。

採否は既存のT4計画とテストの条件を維持します。native / Pyodideの `.fs` は全バイト一致を要求し、Pyodideは各ボード5回実行します。UIは4ボードで幅1280pxと390pxの全8画面を確認し、既存の波形パネル高420px以上という条件を下げません。配布前検査はIcarusの3 WASMをビルド元と全バイト照合し、欠落・改変・余分なファイルを拒否します。

ツールの実測値はNode.js 24.21.0、Yosys 0.70 / `28ba3cb92`、nextpnr 0.11.1、Chromium 156.0.8078.4、Pyodide 314.0.7 / Python 3.14.2です。native側のNumPyは2.5.4、msgspecは0.22.0でした。合成・配置配線などの固定資材はT5で作成済みの製品用ビルドを読み取り専用で再利用しています。T4 checkoutから作り直したnextpnrの検証ではありません。並行負荷があるため、速度の改善は主張しません。

| バイナリー | SHA-256 |
|---|---|
| Yosys WASM | `85812d62f2aaf0a4ab9ed8c933a862cc4eec18a874160b4fc36e5871d82ff644` |
| nextpnr WASM | `70ee0c70f83069329240c6c19115ba6b548e1937261e8d0da9630141bca1f684` |
| nextpnr native | `9b8865b8cc784a205861a1b2788bcc6f33f41255cd13ee0dc5dcae834b79d1e9` |

## bitstreamと負の対照

Verilogテンプレートの先頭のtimescale行だけを除去して旧回路の入力を作り、同じ制約、WASI合成、WASI配置配線、native packを実行します。追加後の回路で作った `.fs` と全バイト比較し、さらに同じ配置配線結果から作るPyodideの `.fs` を5回比較します。結果の全4行・全列は[生CSV](S12B-simulation-integration.csv)に保存しました。4ボードとも追加前後が一致し、native / Pyodideも計20回すべて一致しました。

このsuiteは7件すべて成功しました。壊れたJSON、存在しないwheel、別デバイス指定、hashが違うwheel cacheの負の対照も含みます。別デバイスは拒否するか、異なるIDCODEになることを確認します。テストベンチは合成入力へ追加せず、シミュレーション専用のファイルとして扱います。

```sh
node --test tests/synth/gowin-pack.test.mjs
node --test tests/web/*.test.mjs tests/synth/iverilog-wasm.test.mjs
```

## UIと配布物

焦点を絞ったPlaywrightの2件は成功しました。4ボードでテンプレートをシミュレーションし、Surferへの読込とパネル高を通常幅・390px幅で確認しました。全8枚を目視し、ボード名、VCD選択、完了状態、波形と時間軸が表示される範囲を確認しました。Icarusの3 WASMは、個別の改変・欠落と余分なファイルを拒否する負の対照も成功しました。

```sh
PLAYWRIGHT_PORT=8124 S5_PLAYWRIGHT_OUTPUT_DIR=build/t4-height-preflight-results \
  npx playwright test tests/e2e/simulation.spec.mjs tests/e2e/web-flasher.spec.mjs \
  --grep 'each board template simulates|built distribution matches'
```

この後の全体E2E初回は62件成功・14件失敗・4件skipでした。失敗14件はいずれも `build/fixtures/<board>.fs` の読込時のENOENTで、テスト用fixtureをまだ生成していませんでした。結果は失敗のまま保持し、固定版のfixture生成スクリプトで4ボードの通常fixtureとテンプレート用fixtureを生成し、全8ファイルのIDCODEを検査しました。生成後、`c19c69f` の全体E2Eを新しい出力先で実行し、76件成功・4件skip・失敗なしを確認しました。

4件のskipは `tests/e2e/s5-synthesis.spec.mjs` のS5 finalist比較測定だけです。`S5_CHROMIUM_VARIANT` と `S5_ASSET_DIR` を指定しなかったため、4ボードの比較測定は本実行では試していません。通常の合成・仮想書き込みのE2Eとは区別します。

同じcommitのシミュレーションE2Eは、全10件を3回ずつ実行して30件すべて成功しました。複数VCDの切り替え・保存、プロジェクト切り替え時の古い結果の破棄、停止と再実行、時間制限、不正VCD、WebGLがない場合の保存も確認しています。速度を比べる実験ではなく、機能回帰として3回反復しました。

最後の反復で取得した通常幅1280px・幅390pxの全8画面も目視しました。ボード名、完了状態、VCD選択、信号と時間軸の表示を確認しました。幅390pxではSurferの信号名の列が画面の多くを占め、波形を表示する幅は狭くなります。狭い画面での操作性改善まで検証済みとは扱いません。

| 同じcommitの検査 | 結果 |
|---|---|
| Web単体とIcarus比較 | 143件成功 |
| packとtimescale前後の比較 | 7件成功、4ボード各5回一致 |
| fixture生成後の全体E2E | 76件成功、4件skip、失敗なし |
| シミュレーションE2Eの3回反復 | 30件成功、失敗なし |

```sh
tests/fixtures/build-fs.sh
PLAYWRIGHT_PORT=8124 S5_PLAYWRIGHT_OUTPUT_DIR=build/t4-c19c69f-e2e-results \
  npx playwright test
PLAYWRIGHT_PORT=8124 S5_PLAYWRIGHT_OUTPUT_DIR=build/t4-c19c69f-simulation-repeat-results \
  npx playwright test tests/e2e/simulation.spec.mjs --repeat-each=3
```

手動の画面操作録画は未実施です。書き込みのE2Eは仮想USBを使う検査であり、実機の結果ではありません。Tang Nanoの実機は本リポジトリでは試していません。

## 保全ログの照合値

大きいログはコミットせず、SHA-256と再実行コマンドを記録します。初回の失敗を成功に置き換えず、以降の実行とは別のログとして保持します。

| ログ | SHA-256 |
|---|---|
| timescale前後とnative / Pyodideのpack比較 | `874a43a960b2731ba3c9f74a2eb9396baf49fda8a83e3d0fc52a44181ad7f954` |
| 964b146の全体E2E初回 | `d926741d6a887c0f241eddeb51a9bf530bf9cabd675b49d276a844d6d124779d` |
| 波形高とIcarus配布前検査の焦点E2E | `2963d392e595805582af2b6b142991b95fc4011a55336355fdca270c7213373a` |
| 固定版fixture生成とIDCODE確認 | `9b854cd578471b808609ef697359dec98076c68f1dede18866500f3c86ec3c04` |
| c19c69fのfixture生成後の全体E2E | `0ec22ff617cb1dfc39b3ff8f3959f6afe807af5101357f843659dc8a7abf4e32` |
| c19c69fのシミュレーションE2Eの3回反復 | `9b23e6d038cc8b459e78de6e58efaeca1975484bf5012bc70e967e3057e5d049` |
