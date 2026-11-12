# S1a: GOWIN 書き込みシミュレーション

## 条件と再現コマンド

Stage 0 で生成した `build/repro-b/jspi-pthread/openFPGALoader.mjs` / `.wasm` を使い、openFPGALoader v1.2.0 の WebUSB、FTDI MPSSE、JTAG、GOWIN 書き込み経路を Node.js 上の fake device で実行した。Node.js は v24.21.0、Emscripten は 6.0.13。`vendor/` は変更していない。実機への書き込みは行っていない。

Fixture は `tests/fixtures/blinky.v` と各 CST から生成した実 bitstream で、出力は `build/fixtures/<board>.fs`。LED/clock pin は各 CST のコメントに記した YosysHQ/apicula `examples/tangnano*.cst` を参照した。ビルドと確認:

```sh
tests/fixtures/build-fs.sh
WASM_BUILD_ROOT=build/repro-b node --test tests/sim/*.test.mjs
```

Python 3.12.13 の venv に通常の依存解決でインストールした版:

| Package | Version |
|---|---|
| apycula | 0.32 |
| yowasp-yosys | 0.70.0.0.post1259 |
| yowasp-nextpnr-himbaechel-gowin | 0.11.1.0.post826 |

0.35 は次のメタデータ競合により採用しない。nextpnr が要求する版に固定し、`pip install -r tests/fixtures/requirements.txt` で依存を解決した。

```text
yowasp-nextpnr-himbaechel-gowin 0.11.1.0.post826 requires Apycula==0.32, but you have apycula 0.35 which is incompatible.
```

生成物の header IDCODE は 1K `0x0100681b`、4K `0x0100981b`、9K `0x1100481b`、20K `0x0000081b` と一致した。9K は upstream の mask 後に `0x0100481b` として扱われる。ファイルは未追跡の `build/fixtures/` に置いた。

## fake とテスト

fake は `vendor/openFPGALoader/src/gowin.cpp` 等の手順に沿って TAP/命令レジスタ、status/DONE、SRAM、internal eflash、および Tang Nano 20K の JTAG-to-SPI (`0x16`) 経路をモデル化する。NOR は WREN/WEL、WIP の busy→ready、JEDEC ID `0xef4017`、erase、page program の AND semantics、readback を扱い、SRAM/flash の書き込み内容を捕捉する。`0xef4017` は fake 上の W25Q64 仮定であり、実機の JEDEC ID は確認していない。

期待データはテスト側で `.fs` の binary record を独立に解析する。SRAM、internal eflash（`GW1N` + `0xff` 20 bytes の先頭領域）、NOR の payload を比較し、NOR の WEL/WIP/status、erase、page program、read も検査する。8つの board/mode ケースは各5回実行した。

| 検査 | 実際の upstream 挙動 |
|---|---|
| 9K bitstream を 1K target に指定 | IDCODE mismatch を表示し、非0終了 |
| SRAM の DONE を最後まで unset | `FAIL` を表示するがプロセスは0終了。`programSRAM` が失敗を返した後も main が0終了するため、その挙動をテストで固定 |
| internal eflash erase busy forever | fake の status に busy を維持しても `Erase FLASH DONE` と表示し、0終了。busy 完了を検査していない挙動を固定 |
| NOR erase busy forever | fake は WIP を維持する。upstream の100000 pollは Node 上で完了せず、240秒でも子プロセスが `ETIMEDOUT`。テストは30秒の子プロセス上限による非0終了を確認する。upstream 自身の timeout/error 出力に到達したとは扱わない |
| NOR `--verify` readback corruption | `Verification failed`、非0終了 |
| USB transfer の `NotFoundError` | `FAIL` と例外を表示するが0終了。検出されない upstream 挙動を固定 |
| comparator negative control | 捕捉データの1 bit反転で比較が失敗することを確認 |

8 positive cases の elapsed time は module load/instantiate と `callMain` を含む生値(ms)で、CSVに記録した。Node test の全体は24/24 pass、duration 73.56秒。全出力は `build/s1a-tests-final.log`。

## 失敗した fixture 試行

以下は最終生成前の失敗をすべて記録する。family/device 指定を直した後は4 boardすべて生成できた。

| 試行 | 結果 |
|---|---|
| 最新版 Apycula 0.35 を使った20K生成 | `Speed grade 'ES' not found in database.`。後に判明した依存 metadata 競合は上記参照 |
| nextpnr device `GW1NZ-1` | `ERROR: Invalid device GW1NZ-1` |
| 9K の nextpnr family 未指定 | GW1N-9 family 指定を要求され失敗 |
| 9K の family `GW1N-9C` 指定後、pack target を同 family に変更 | pack target と part number が一致せず失敗 |
| 20K の nextpnr family 未指定 | GW2A family 指定を要求され失敗 |
| 20K の `gowin_pack -d GW2AR-LV18QN88C8/I7` | `ERROR: No package for partnumber GW2AR-LV18QN88C8/I7` |

成功した20K設定は device `GW2AR-LV18QN88C8/I7`、nextpnr `--vopt family=GW2A-18C`、pack target `GW2A-18C`。失敗時の個別コマンド全文は build log に残っていないため、ここでは確認できた device/family 変更とエラーを記す。再現時の最終コマンドは `tests/fixtures/build-fs.sh` にある。

## 生時間

| Board / mode | 5回の elapsed time (ms) |
|---|---|
| Tang Nano 1K SRAM | 126.377, 124.719, 127.346, 129.504, 187.260 |
| Tang Nano 1K flash | 1363.712, 1368.133, 1397.294, 1366.794, 1363.225 |
| Tang Nano 4K SRAM | 182.914, 177.783, 176.861, 175.010, 181.873 |
| Tang Nano 4K flash | 1660.237, 1685.166, 1654.591, 1700.532, 1652.957 |
| Tang Nano 9K SRAM | 242.804, 249.021, 247.204, 246.039, 250.221 |
| Tang Nano 9K flash | 2056.326, 1944.420, 2006.838, 1992.280, 1950.798 |
| Tang Nano 20K SRAM | 419.147, 430.981, 426.901, 432.781, 459.865 |
| Tang Nano 20K flash | 666.821, 692.068, 683.343, 661.890, 660.177 |

CSV: `docs/experiments/S1a-program-sim.csv`.

## 2026-10-26 の訂正

当初は、内蔵フラッシュの消去中に busy が続いても、upstream が `Erase FLASH DONE` と表示して0で終了すると記録した。この測定は Fake USB の MPSSE parser が `0x8e` と `0x8f` の長さバイトを命令として誤解析していた時点のもので、busy を検出できない挙動を示す測定ではなかった。

parser の修正後、upstream は消去を100回再試行し、`FAIL` を表示して終了コード0で終わることを確認した。画面は終了コードだけでなく `FAIL` も判定するため、この場合は失敗と表示する。以前の測定値と記述は当時の経緯として残す。
