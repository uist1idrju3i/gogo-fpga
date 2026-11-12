---
name: fake-usb
description: 午後のFPGA Web Toolchain の書き込み機能で使う仮想デバイス（tests/sim/fake-webusb.mjs の FT2232/MPSSE、GOWIN TAP、NOR フラッシュ）を拡張・修正するとき、仮想 USB のテストが失敗したとき、新しい操作やボードを仮想 USB で確かめるときに使う。upstream の手順に合わせ、負の対照で失敗を検出できることを確かめる。
---

# fake-usb（仮想デバイスの拡張）

実機の Tang Nano が手元にないため、書き込みの確認は仮想デバイスに頼っています。仮想デバイスの誤りは、そのまま「通るはずのないテストが通る」「正しい製品が失敗する」につながります。

## 構成

| 部品 | 場所 | 根拠 |
|---|---|---|
| WebUSB の `USBDevice` と FT2232（VID `0x0403`、PID `0x6010`、インターフェース A、bulk IN `0x81`、OUT `0x02`） | `FakeUSBDevice` | libusb の `emscripten_webusb.cpp`、libftdi |
| MPSSE のコマンドとビット単位の読み出し | `FakeUSBDevice`、`packMpsseBitModeRead()` | FTDI AN_108。ビット単位の読み出しは上位のビットに詰まる |
| GOWIN TAP（IDCODE、SRAM、内蔵フラッシュ、状態レジスター） | `GowinTap` | `vendor/openFPGALoader/src/gowin.cpp` |
| 外付け NOR（20K: 8 MiB、4K/9K: 4 MiB） | `GowinTap` の NOR の部分 | `src/spiFlash.cpp`。JEDEC ID は汎用の値で、実機の品番ではない |
| GW1N（4K/9K）の外付けフラッシュ経路 | BSCAN の部分 | `gowin.cpp` の `spi_put()`。JTAG のデータの shift で SPI を 1 ビットずつ動かす |
| 故障の注入 | `createFakeUsb(idcode, { faults })` | `doneNever`、`eflashBusyForever`、`norBusyForever`、`protectedNor`、`corruptNorReadback`、`disconnectAfter`、`norSeed` |

## 手順

1. 先に upstream を読みます。追う手順の関数と行番号（例: `gowin.cpp:1053-1083`）を控え、コメントに書きます。推測で応答を作りません。
2. 仕様の資料（FTDI AN_108、JEDEC の SPI NOR のコマンド、Sipeed の資料）で確かめられる値と、確かめられない値を分けます。確かめられない値（実機のフラッシュの品番など）は、汎用の値であることを RESEARCH.md に書きます。
3. 正常系のテストを足します。書き込みなら、仮想デバイスが受け取ったデータを `.fs` の中身と比べます。終了コードだけで判定しません。
4. 負の対照を必ず足します。故障を注入した回で、テストが失敗を検出することを確かめます（例: `corruptNorReadback` で `--verify` が失敗する、1 ビット壊した比較が不一致になる）。注入が実際に効いたことも assert します（例: `result.readCorrupted`）。
5. テストが失敗したら、製品の誤りと決める前に、仮想デバイスを upstream と仕様に照らし合わせます。20K の `--verify` の失敗は、仮想デバイスの MPSSE の詰め方の誤りでした。
6. 大きな結果（NOR の内容など）は stderr ではなくファイルで受け渡します。BSCAN の経路は重いので、テストは `--test-concurrency=1` で直列に流し、単独と全体の両方の時間を見ます。
7. 仮想デバイスでの時間は、実機の値ではないと明記します。

## 確認

```sh
WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs
node --test tests/sim/mpsse-packing.test.mjs
npx playwright test
```

仮想 USB は `tests/e2e/` の Playwright からも使います。仮想デバイスを変えたら E2E も流します。
