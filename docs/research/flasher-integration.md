# 書き込み部の移植とビルド選定

[調査の索引](../../RESEARCH.md#7-分割した調査)へ戻る。

午後のFPGA Web Flasherから引き継いだ知見と、その後のS7・asyncify検証をまとめます。測定当時の版、失敗、未確認の範囲を残しています。コマンドとファイルのパスは、リポジトリーのルートを基準にします。

書き込み部は、[午後のFPGA Web Flasher](https://github.com/gogo-fpga/flasher) のコード、ビルド、テストを基礎にします。移植元の調査記録は[RESEARCH.md](https://github.com/gogo-fpga/flasher/blob/dcbeb67/RESEARCH.md)です。実験記録はコピーせず、[S0](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S0-wasm-build.md)、[S1a](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S1a-program-sim.md)、[S1b](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S1b-option-matrix.md)、[S2](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S2-ci-sim-environment.md)、[S3](https://github.com/gogo-fpga/flasher/blob/dcbeb67/docs/experiments/S3-ci-speed.md)を参照してください。

- openFPGALoader v1.2.0 と libusb、libftdi、zlib を Emscripten 6.0.13 でビルドしています。
- JSPI と `-fwasm-exceptions` を組み合わせる構成で書き込み部を動かしています。libusb の WebUSB バックエンドは pthread と共有メモリーを必要とし、配信には COOP/COEP ヘッダーを使います。
- upstream の openFPGALoader は、失敗時にログへ `FAIL` を出しても終了コード 0 を返す場合があります。終了コードだけで成否を判断しません。
- 仮想 FT2232、GOWIN TAP、NOR フラッシュを使ったテストがあり、故障注入による負の対照も行っています。仮想デバイスの結果は実機の検証ではありません。
- S7 では、Chromium 上の fake USB 書き込みと最終 SRAM / flash 内容検証を行い、凍結基準により B+LTOA を選定しました。primary は B+LTOA が 14,994.695 ms、B が 15,491.515 ms（3.207%改善、N = 55.165 ms）でした。B+O3+LTOA は sim 4/5 のため対象外です。この選定を反映し、B+LTOA を JSPI の既定 build に採用しました。以前の既定 build は `scripts/build-wasm.sh --variant=B` で再現できます。詳細は [S7 実験記録](../experiments/S7-openfpgaloader-chromium.md)を参照してください。実機では、本リポジトリでは試していない。

  現行既定 WASM の SHA-256 `61c4943252821a0d1405133c11690b7718fb5af28c86bf102e926ccba780a642` は S7 B+LTOA の `5ccccd017186a7a8d137f9791e08a53cf2fedaa5aaa59143028def8908557812` と異なりますが、差は `-ffile-prefix-map=$build_root=/build` が残す `/build/jspi-pthread/` と `/build/B+LTOA/` の出力下位パス、およびそれに伴う data offset です（MJS は両方 `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44`）。確認では `--variant=B+LTOA` が S7 の WASM/MJS SHA `5ccccd017186a7a8d137f9791e08a53cf2fedaa5aaa59143028def8908557812` / `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44` を、`--variant=B` が S7 B の `ecf7617859639422050c1098edc1dac04e943def90cb5a7328b8035714cb42b7` / `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` を再現し、既定 profile の A/A も `61c4943252821a0d1405133c11690b7718fb5af28c86bf102e926ccba780a642` / `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44` で一致しました。4条件の `$REPO_ROOT` 再生成コマンド、`flags.make`／`link.txt` の差分件数、`wasm-dis`／`strings` の差分件数は [S7 実験記録の既定 profile 確認](../experiments/S7-openfpgaloader-chromium.md#jspi-既定-profile-の再現確認)に記録しました。

asyncify は S1b のフラグを維持し、現行スクリプトと origin/main の `flags.make` / `link.txt` は build root 置換後の diff が各 0 行（configure-level の一致でバイト同一性は未確認）だったが、この VM での full link は 1:18:51・peak RSS 15.3 GB で終了コード 2 により失敗し、バイト同一性は本リポジトリでは試していない（origin/main でも同じ失敗となるかは未確認）。

これらは移植元の記録に基づく知見です。新しい Emscripten やブラウザーでの再検証は、このリポジトリーではまだ実施していません。
