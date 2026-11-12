# S15 P1 SAT反例の独立再実行

- 状態: 実装中の診断試行。正式な5回反復・ブラウザー統合は未完了
- 基準: SAT比較経路の`cbef0c84f631add993b82c5e7bcdd2d5cedb5973`
- 関連: [事前基準](S15-formal-verification.md)、[方式と制限](../research/formal-verification.md#元のverilogによる反例の独立再実行)

## 目的と固定条件

Yosys SATの反例を同じソルバーで自己確認せず、元のVerilogと独立したIcarusのイベント駆動シミュレーションで確認します。事前基準のN-1/N/N+1、clock/reset、原文propertyと具体的な初期値を保持します。正常な終了だけでは採用せず、全stepの出力一致、元のassertionの違反、VCD保存を要求します。壊したモデルとreset列は非成功が条件です。

この層ではfixtureと入力を固定し、YosysとIcarusをそれぞれnative/WASMで比較します。性能やブラウザー全体の資源上限の採否は測りません。診断試行は変更中のcheckoutで実行しており、pushしたcommitの検証には数えません。清浄なrevisionでの実行は別に記録します。

## 再実行コマンドと保存先

固定版のYosysとIcarusのnative/WASM、Icarusの両`build-info.json`をビルドしてから、次を実行します。CIでは既存の比較用artifactを使います。

```sh
node --test --test-concurrency=1 tests/synth/formal-replay.test.mjs
node --test tests/web/formal-replay.test.mjs
```

各実行は`build/S15/p1-replay-<一意名>/`を新規作成します。manifestに実行revision・未コミット差分の有無・Node・引数・実バイナリー8本のhash・Icarusの原版とbuild-info・実行したvvpの版を保存します。Icarusの版とcommitはpin checkerを正とし、metadataの各hashを実ファイルと照合します。Yosysの中間JSONのcreatorも固定版と照合します。

元のソース、Yosys scriptと全stdout/stderr、中間JSON・RTLIL、SAT witness、再実行bench、nativeの作業ファイル、WASMのVCD、判定と生CSVを保存します。CSVは38行で、SAT反例12本に対する独立再実行24行、壊した出力12行、誤reset2行です。深さN-1で反例がない結果は別のSATログと結果JSONで保持します。CSVの全列を監査してから結果を引用します。失敗時も同じディレクトリーを残し、CIは7日間artifactとして保存します。

## 診断試行と失敗の記録

初回は5シナリオのVCD比較で失敗しました。バイト内容ではなく、WASMの`Uint8Array`とnativeの`Buffer`の型差を検査器が拒否したためです。nativeも`Uint8Array`へそろえて全バイト比較を維持し、再実行しました。失敗ログは`build/S15/p1-replay-attempt1.log`に保全し、入力・出力の証拠も削除していません。

その後、reset列、VCD欠落・UTF-8不正、`FORMAL`定義、実バイナリーとmetadataの照合、生CSVを追加しました。診断の各試行は別の証拠ディレクトリーへ保存しています。作業中の変更を含む成功は、配布revisionの成功に読み替えません。

## 未確認の範囲

一般的な反例、未初期化状態、複数clock、VHDL・PSL、vacuity、cover、SMT/SBY、workerと保存への接続、5回反復とA/Aは未完了です。負の対照の再実行は現段階ではWASM Icarusのみです。ブラウザー画面、実機Tang Nano、Cloudflare Pages公開は確認していません。

## 清浄な実装commitでの診断結果

実装commit `bf042da31c92269db52e42cde54156b76d2ba30f`で、次を実行しました。manifestの`workingTree`は空文字列です。ホストはUbuntu 22.04.5 LTS、2論理CPU、MemTotal 8,132,568 KiBで、検証済みの製品用バイナリーを再利用しました。今回は性能測定や正式な5回反復には数えません。

```sh
node --test --test-concurrency=1 tests/web/*.test.mjs tests/synth/formal-sat.test.mjs tests/synth/formal-replay.test.mjs tests/synth/iverilog-wasm.test.mjs
```

| 検査 | 結果 |
|---|---|
| Web単体・SAT・独立再実行・Icarus比較 | 210件成功、失敗・skip・cancel各0件 |
| 独立再実行の生CSV | [38行15列](S15-formal-replay.csv)の全570値を監査 |
| 正常な反例の再実行 | 24行で`verified`。native/WASMの終了値・stdout/stderr・property・VCDが一致 |
| 壊した出力の負の対照 | WASMの12行で`rejected`、終了値1 |
| 誤resetの負の対照 | WASMの2行で`rejected`、終了値1 |

深さN-1はnative/WASIとも`bounded-safe`で、反例の再実行には入れません。Nではstep4、N+1ではstep4と5、negedgeと帰納法の基底部ではstep4、組合せではstep1、reset列ではstep5の元のassertion違反を確認しました。VCD欠落、時刻の途中欠落・逆行、未知の診断、欠けた観測markerなどは単体の負の対照で拒否しています。

実際のYosysは0.70、原本commitは`28ba3cb926fe376fa05ebfc1b921747d011d4557`です。Icarusのvvpはnative/WASMとも`13.0 (stable) (v13_0)`を返し、原本は`dfeee909ed9f20b4870dd93423156c0170c0e1ff`でした。Nodeはv24.21.0です。Icarusのbuild-infoはnativeのGCC 11.4.0、WASMのclang 23.1.0-wasi-sdkとWASI SDK 34.0を記録しています。

| 実際に使ったファイル | SHA-256 |
|---|---|
| `build/native/yosys` | `d298997c12f89e845b76ba0a8b484ad5ebbe63b604397948bbd0d8ecfd9e318c` |
| `build/wasi/yosys/yosys.wasm` | `85812d62f2aaf0a4ab9ed8c933a862cc4eec18a874160b4fc36e5871d82ff644` |
| `build/iverilog-native/output/ivlpp` | `272678cb06591880763219b60da8adcbfa80ba273d1ec55fc63ec33bad937f49` |
| `build/iverilog-native/output/ivl` | `fa80c74f3c275b34c27a6fa578fce90b00f8c0b3bd8013314007c29f3b90694e` |
| `build/iverilog-native/output/vvp` | `06b819775608ce66b35ad23a75e9473658f492617bc8499a6311bb5057addeae` |
| `build/iverilog-wasm/output/ivlpp.wasm` | `7ab296df67635fc272b5dfa95c3e0e5e0f7176271b4035d26f847e266c6936af` |
| `build/iverilog-wasm/output/ivl.wasm` | `936223cd9204283fe16a1b3232684a9766573088d2d0da3fa08a2c94fcfdb30f` |
| `build/iverilog-wasm/output/vvp.wasm` | `909014061e6dbde49f2f86b47c4a2b536abaea0c79678a7b901e6b816de1bc83` |

診断のmanifestはSHA-256 `f192fb361dd5ac56b21ac1f6e88bef9e576166506ccfa2dfed50360d5c444d12`、生CSVは`55890d1dc7d4fb252f0a57571b1b731eca721df8b5ea92e3f7faaa65ec101e84`、全210件のログは`fa17c7fb3812b6e71ad8ce52bd121e0e3e5bedc60fee7af2cf54e32252e4021f`です。再実行ではmanifestの実行場所やログの所要時間が変わるため、これらの完全一致だけを採否の条件にはしません。入力・出力・hash・診断はCIの`ci-formal-replay-<run_id>`にも保存する構成にしましたが、本記録の時点でCIは未確認です。
