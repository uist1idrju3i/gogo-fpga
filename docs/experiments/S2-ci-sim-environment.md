# S2 CI シミュレーション環境差の診断

- 状態: 完了
- 日付: 2026-10-26
- 担当: Devin
- 関連: PR #8

## 目的と仮説

CI で失敗する GW1N 内部フラッシュの CRC 読み戻しと USB 切断のテストについて、fixture 生成時の Python 版差または CPU 競合がローカルでも失敗を起こすか確認する。どちらも再現しない場合だけ、Fake USB の命令とレジスタ更新を記録して、CI とローカルを比較する。

## 採否の基準（結果を見る前に書く）

Python 3.14 で生成した fixture を使う4テストのうち1件以上が失敗し、Python 3.12 の fixture では4件すべてが成功した場合、fixture 環境差で再現したと判定する。再現しなければ、CPU 競合下で4テストを3回ずつ実行する。計12回のうち1件でも失敗すれば、CPU 競合で再現したと判定する。これも再現しない場合だけ、CI とローカルの Fake USB trace を比較する。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `0e3d8a6334baf1397b72bdbd582675187b5b89f1` |
| ホスト | Ubuntu 22.04.5 LTS、Linux 6.8.0-1061-aws、x86_64 |
| QEMU | 使用しない |
| Buildroot / GCC / カーネル | 使用しない |
| 使用したツールとバージョン | Node.js 24.21.0、Python 3.12.13 / 3.14.8、uv 0.13.4 |
| WASM `.wasm` / `.mjs` SHA-256 | `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c` / `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| 出力先と状態 | `build/fixtures`。Python 3.12 の `.fs` を `build/fixtures-py312` に保存 |
| 変える条件 | fixture 生成 Python 版、必要な場合は CPU 競合と Fake USB trace |
| 変えない条件 | fixture requirements、WASM、Node.js、テスト対象と assertion |
| 繰り返し | Python 版比較は各4件を1回。CPU 競合は4件を3回ずつ。 |

## 手順

```sh
uv python install 3.14
mkdir -p build/python314-bin
ln -s "$(uv python find 3.14)" build/python314-bin/python3
mv build/fixtures/venv build/fixtures-py312/venv
PATH="$PWD/build/python314-bin:$PATH" tests/fixtures/build-fs.sh
sha256sum build/fixtures/*.fs build/fixtures-py312/*.fs
WASM_BUILD_ROOT=build/ci-compare \
  node --test --test-name-pattern='^(flash programming: Tang Nano (1K|4K|9K)|USB disconnect during transfer is reported without a hang)$' \
  tests/sim/program.test.mjs

FAKE_USB_TRACE=1 WASM_BUILD_ROOT=build/ci-compare \
  node --test --test-name-pattern='^flash programming: Tang Nano (1K|4K|9K)$' \
  tests/sim/program.test.mjs
```

## 計測器の検証

fixture の比較には SHA-256 を使い、生成物ごとの完全一致を確認する。シミュレーションの成否は Node の test runner の pass/fail とテスト出力で確認する。CPU 競合の試行では `taskset` の CPU 指定と、稼働中の CPU hog 2個を確認する。

## 結果

Python 3.14.8 の fixture 生成は最初の Tang Nano 1K の Yosys ABC9 処理で Wasmtime trap により停止した。ログは `wasmtime._trap.Trap`、`Caused by: thrown Wasm exception`。4種類の Python 3.14 fixture は生成されず、ハッシュ比較とそれらを使った4テストは実行できなかった。生成前の Python 3.12 fixture は `build/fixtures-py312/` に保存した。停止後に `build/fixtures/*.fs` と保存済みの同名ファイルを `cmp` し、4件すべて一致することを確認した。

Python 3.12 fixture の SHA-256 は次のとおり。CI で生成された値と比較する。

| Fixture | SHA-256 |
|---|---|
| `tangnano1k.fs` | `999b7e160d98654c150d21c72e53d19e86e21b308e0188457763fb113e889998` |
| `tangnano4k.fs` | `63b030bf66d9dfc88fc14cdc3287df4efa179f7773808fdc6940860fa9ee8017` |
| `tangnano9k.fs` | `191b09be744a28461a55b44da0e91b4c70e00e47cf61b824c8f0040a99f47b83` |
| `tangnano20k.fs` | `7e66b61bab06d9f7f7ce31e88a97a26b467b3aa2d5bc3afc53cf0ffdefb11b7d` |

CPU 競合試験は `taskset -c 0` と `yes >/dev/null` 2個を使って3回実行した。全試行で対象4テストが各1回成功し、計12/12件通過した。

| 試行 | Tang Nano 1K | Tang Nano 4K | Tang Nano 9K | USB 切断 | 全体 |
|---|---:|---:|---:|---:|---:|
| 1 | 8,122.069 ms | 10,166.235 ms | 12,626.179 ms | 368.575 ms | 31,410.498 ms |
| 2 | 8,033.997 ms | 10,264.541 ms | 12,518.921 ms | 407.421 ms | 31,331.785 ms |
| 3 | 8,160.454 ms | 10,595.110 ms | 12,571.312 ms | 381.596 ms | 31,817.946 ms |

3試行の中央値（最小–最大）は、1K 8,122.069 ms（8,033.997–8,160.454）、4K 10,264.541 ms（10,166.235–10,595.110）、9K 12,571.312 ms（12,518.921–12,626.180）、USB 切断 381.596 ms（368.575–407.421）、全体 31,410.498 ms（31,331.785–31,817.946）。

Fake USB trace を有効にした3ボードの flash programming は3/3件成功した。15回の子プロセス実行から、`0x15`、`0x71`、`0x3a`、`0x3c` の IR load と `0x71` の DR update、TAP reset が記録された。Python 3.12 fixture を使ったこのローカル経路では `0x0a` の IR/DR と `0x13` の IR/read は観測されなかった。1K の直接実行結果も終了コード0で、命令数に `0x0a` と `0x13` は含まれない。

## 旧診断と訂正

2026-10-26 の診断 CI では、4個の fixture hash が Python 3.12 の保存値とすべて一致した。WASM と `.mjs` の hash もローカル再現値に一致した。したがって、今回のログで観測した CRC 失敗は fixture やビルド成果物の差では説明できない。

最初の診断では、`0x13` の読み戻し値が0で、Fake USB の内部フラッシュ reload 状態が未実装であることを原因と考えた。この仮説は誤りだった。後続 trace で `0x3c` reload 後の usercode と `0x13` 応答 bytes が正しいと分かり、残っている応答 queue の方が不一致の原因だと判明した。

GW1N の `Gowin::skip_checksum` はコンストラクターで初期化されず、`detectFamily()` の GW1N 分岐でも設定されない。`writeFLASH()` の333〜336行では `!skip_checksum && data` のとき CRC を確認するため、未初期化値により CRC 検査の有無が実行環境で変わる。ローカルでは検査が省略され、CI では実行された。これは実行経路の差を説明するが、読み出し不一致の直接原因ではない。vendor code は変更していない。実機の Tang Nano では試しておらず、利用者は upstream への Issue を起票しないと決めた。

## 根本原因と修正

根本原因は Fake USB の MPSSE parser が、`0x8e` の1バイト長と `0x8f` の2バイト長を消費していなかったことだった。`0x8f` の長さ `0x0026` を別命令として誤解析し、実際の FT2232H が返さない読み出し bytes を queue に積んでいた。FTDI AN_108 上でも、これらの命令はデータ出力・クロック命令であり、入力 bytes を返さない。openFPGALoader の `toggleClk()` はこれらを `mpsse_store()` で送るだけで、読み戻しを要求しない。

修正前の `0x13` 読み出し窓には、1K で2 bytes（`0x3b` と `0x6b` 由来）、4K で636 bytes（うち631 bytes は誤解析した `0x26` 由来）、9K で1518 bytes（うち1513 bytes は同じ誤解析由来）が残っていた。修正後は3ボードすべてで読み出し開始時の queue が0となり、`0x13` 応答は usercode と一致した。

| Board | usercode | `0x13` bytes |
|---|---:|---|
| Tang Nano 1K | `0x0000a9ee` | `ee a9 00` |
| Tang Nano 4K | `0x00001042` | `42 10 00` |
| Tang Nano 9K | `0x0000c5d5` | `d5 c5 00` |

Fake USB は内部フラッシュに実際に保存した bytes から usercode checksum を計算する。書き込み語の1 bitを反転する fault を加え、保存済み eflash から得た checksum が入力 fixture の checksum と異なることを検査する負の対照を追加した。CI では CRC 経路に入ったとき upstream が `CRC check : FAIL` を出すことも要求する。ローカルでは `skip_checksum` の未初期化値により CRC 経路が省略されたため、テストは保存データから計算した値の不一致を検査した。正常な usercode 読み出しも、保存済み eflash 内容から値を導く決定的なテストにした。

USB disconnect test は parser 修正後に421 msで成功し、以前の CI での90秒失敗は再現しなかった。disconnect 時の個別 queue trace は採取していないため、同じ parser 不具合との直接の因果は未確認である。修正前後の trace と生の値は [S2-ci-sim-environment.csv](S2-ci-sim-environment.csv) に記録した。

## 捨てた試行と経緯

Python 3.14 の fixture 生成は Yosys ABC9 の Wasmtime trap で停止したため、部分生成物を fixture 比較に使わなかった。初回の Fake USB trace は出力量が `spawnSync` の 8 MiB 上限を超えて `ENOBUFS` になったため、その実行結果をテスト成否の判定には使わず、trace をサンプリングして再実行した。

## 結論

CI とローカルの CRC 経路の差は `Gowin::skip_checksum` の未初期化動作で説明できる。CI で発生した CRC 読み出し不一致の直接原因は Fake USB が `0x8e` と `0x8f` の長さ bytes を誤解析し、偽の読み出し bytes を先行 queue に残したことだった。parser 修正後は queue が空になり、usercode の読み出しが一致した。結果は仮想 USB に限り、実機の動作は確認していない。

## 未確認の点

Python 3.14 の fixture 生成は Yosys ABC9 の Wasmtime trap で停止し、生成物を比較できなかった。これは未解決の環境差として残す。Tang Nano 実機での確認も未実施である。

## 2026-10-26 のレビュー修正検証

対象テストは7/7件、全シミュレーションは43/43件成功した。最初の全体実行では、9K の checksum が `0x59e7` となり、期待値 `0xc5d5` と一致しなかった。9K の各設定行は padding 後に4 bitずつ余るため、行ごとに byte に変換せず、行をまたいで bit を連結してから checksum words を作るよう修正した。修正後は fixture checksum と eflash 由来の usercode が一致した。所要時間と失敗・修正の記録は CSV に追記した。

ローカルの負の対照では `skip_checksum` の未初期化値により upstream の CRC 出力が省略された。保存済み eflash の word 23 が反転し、その bytes から計算した usercode が入力 fixture の checksum と異なることを確認した。CI では CRC 経路に入る場合に `CRC check : FAIL` を要求する。

## ログ

生ログはコミットしない。実行コマンドと測定値を CSV に記録する。
