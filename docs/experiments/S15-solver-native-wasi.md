# S15 P2 Yices2・Z3のnative/WASI正式比較

- 状態: Nodeの実workerによるP2正式反復と独立監査を実施済み。製品の形式検証は未完了
- 日付: 2026-11-02
- 関連: [実験索引](README.md)、[事前基準と予備結果](S15-solver-protocol.md)、[buildと輸送](S15-solver-build-and-transport.md)、[Z3のlink診断](S15-z3-wasi-link.md)、[ソルバー調査](../research/formal-solvers.md)

## 目的と実行前の基準

固定した上流CLIを、native processとWASI Preview 1の実workerで動かします。SMT-LIBのparserや意味をJavaScriptへ移植せず、同じsolverの正常応答が全byteで一致し、輸送の異常を成功扱いにしないことを確認します。基準は上記の事前記録と、commit済みの比較器・監査器から変更していません。

正式条件は各5回以上、A/Aは2回以上とし、native/WASIの実行順を反復ごとに交互にします。stdout、stderr、frame列、終了と失敗分類、source・build・binaryの由来、生CSVの全31列を独立監査します。期待した異常を検出できた場合も、検査の`verdict`は`pass`です。これは性質の証明が成立したという意味ではありません。

## 固定した条件

| 項目 | 実際の条件 |
|---|---|
| 比較器のcommit | `3ea717e965a24b9d5738301b0c1a49c7e83fdf6b`。開始前・終了後ともworktreeは清浄 |
| ホスト | Ubuntu 22.04.5 LTS、Linux 6.8.0-1061-aws、x86_64、2 CPU、memory 8,327,749,632 byte |
| 実行系 | Node v24.21.0、V8 13.6.233.17-node.53。GNU Timeは版名が`UNKNOWN`のため全出力をmetadataへ保存 |
| Yices2 | Yices 2.7.0、source `85cf17e44eac76b5d14b297c09fc9bfecf47ef65`、GMP 6.3.0 |
| Z3 | Z3 5.3.3、source `430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e`。native表示は64 bit、WASI表示は32 bit |
| WASI build | WASI SDK 34.0、clang 23.1.0-wasi-sdk。Z3のCMakeは3.31.10 |
| Z3 native build | Clang 21.1.8と隔離したlibc++ 21。ABI・unwindを明示link |
| 輸送 | 既存shim、共有byte pipe、専用worker、字句framer。通常条件は容量7 byte、入力chunk 3 byte |
| 変える条件 | 同じsolverのnative/WASIと、事前定義した正常・異常条件 |
| 変えない条件 | 4つの既存binary、source pin、patch、build metadata、比較器とworkerのソース |
| 出力 | `build/S15/p2-native-wasi-formal-1`を新規作成。5回とA/A 2回の間はbinaryを作り直さない |

4つのbinaryをすべて同じbuild commitから作ったわけではありません。Yices2の両系とZ3 nativeは`537a140b4ba4e233af6606a78071e80e08ce858b`、Z3 WASIは比較器と同じ`3ea717e`からの清浄なbuildです。上流source pinはsolverごとに両系で同一です。format 3は各metadataのbuild commitから元のbuild scriptを取り出し、そのhashを照合してsnapshotを保存します。現在のscriptを過去のbuild scriptとして扱いません。

| Binary | byte | SHA-256 |
|---|---:|---|
| Yices2 native | 3,454,192 | `03ed31aadc9fcdb02864fa68785fddfbcfd28051cadd8c509128093403dfa3de` |
| Yices2 WASI | 1,970,068 | `478fcb7fe5b3baa45420d2fb7087ae8508850cdb824a9968d871df13de66f7ad` |
| Z3 native | 31,589,376 | `0ceec28f441342dac24ac23787ad68d126f54775f170686b99da92828fedfc46` |
| Z3 WASI | 31,458,902 | `1a08dac12bab2e302bc4c1c53d4cdc0e0b8c48c6422df8f4b05c9e0de09e39b9` |

各compilerの版出力、submodule状態、GMP/SDK archiveとpatchのhash、全build argv・環境・終了値・log hashは、証拠内のmetadataとbuild logにあります。nativeは比較専用で、製品の実行経路や配布対象へ昇格していません。

## 結果と計測器の検査

[生CSV](S15-solver-native-wasi.csv)は235行の正式反復と94行のA/A、計329行です。[独立監査の結果](S15-solver-native-wasi-audit.json)は全31列、全329行、294個の負の対照を検査して`pass`でした。生CSVのSHA-256は`6e1cbc2f1c0907db79f8423badfebc5c8fa32737bed883bcb09fe43b264b8786`です。

| 範囲 | 確認した結果 |
|---|---|
| bit-vector・array | 両solverでpush/pop、値とmodel、複数frame、分割入力を実行。native/WASIのstdout・stderr・frame列が全byte一致 |
| 長い値 | 32,768 bitの値と上流printerの改行をそのまま保持。両系で全byte一致 |
| 構文不正・応答なし | 原本のerrorや欠けた応答を記録。Yices2の構文エラーは終了0でも成功した論理判定にしない |
| Z3のunknown・software FP | 両系の応答が一致。`unknown`を証明成功へ読み替えない |
| Z3のhardware FP | native対照は実行成功、WASIは明示した診断と終了1で拒否。一般のSMT浮動小数点とは区別 |
| Yices2のalarm | WASIの上流alarm要求を診断と終了19で拒否。hostのdeadlineとは別に検査 |
| 停止と古いjob | timeout・cancel、計算要求後の停止、stale通知、終了待ち欠落を検査。古いjobは現在の完了条件にしない |
| 破損と出力上限 | hash不一致、corrupt WASM、worker側例外、出力上限を非成功へ分類 |

A/Aと正式反復の正常3条件について、stdout、stderr、status、exit、frames、signal、framingの7項目をそれぞれ壊し、比較器が拒否することを確認しました。2 solver、7反復、3条件、7改変で294件です。独立監査器の単体テストは、CSV全31列の改変、欠落・重複・順序、CSVとJSONを同時に変えた誤分類、欠測の0への置換、build失敗の隠蔽も拒否します。

### 時間と資源

正式5回の時間は次のとおりです。各セルは最小 / 中央値 / 最大、単位はmsです。workerの開始やWASMの準備を含む検査経路の時間であり、solver内部だけの時間でもブラウザーでの性能でもありません。

| 条件 | Yices2 native | Yices2 WASI | Z3 native | Z3 WASI |
|---|---|---|---|---|
| incremental-bv | 7.719 / 12.328 / 13.262 | 47.382 / 55.077 / 85.191 | 19.693 / 21.211 / 53.921 | 223.692 / 226.891 / 672.468 |
| incremental-array | 7.616 / 9.936 / 13.216 | 53.353 / 63.260 / 117.576 | 22.163 / 23.589 / 155.902 | 231.227 / 245.728 / 1106.365 |
| long-value | 8.213 / 10.266 / 26.587 | 102.122 / 106.257 / 114.755 | 20.826 / 23.981 / 189.272 | 268.814 / 290.743 / 932.315 |

全94 groupの最小・中央値・最大と欠測数は[資源CSV](S15-solver-native-wasi-resources.csv)にあります。nativeの最大RSSとWASMのlinear memoryは別の量です。上記3条件のWASM linear memoryは両solverとも33,554,432 byteでしたが、workerやJavaScript、compile領域を含む総メモリーではありません。欠測はJSONでnull、CSVで空欄に保ちます。失敗までの時間を正常応答の速度へ混ぜません。

buildは各binaryにつき1回で、Yices2 native 186.878秒、WASI 210.229秒、Z3 native 2093.774秒、WASI 1423.789秒でした。これはbuild速度の反復比較ではありません。build時の最大RSSは記録していないため、実行時RSSや推定値で補いません。

## 警告と捨てた試行

成功したbuildも警告なしとは扱いません。Yices2ではAutoconfのbyte order検査、cross tool名、cross時のheader/vsnprintf検査、式・優先順位・errno header、未使用timer、link時の`-wasm-enable-sjlj`の警告を保持しています。SDKのcompiler・target・固定GMPのlogと実行結果を別に監査し、configureの推測だけを動作確認にしません。

Z3 WASIでは、`getpid`の非推奨警告3件、未使用変数4種類とtemplate 3種類、link時の`-wasm-enable-sjlj`の未使用警告1件を保存しています。hostのPIDやthreadを再現するshimは追加していません。link時の警告はcompile時に必要なフラグをdriverが引き継いだもので、未解決symbolとは区別します。警告を消すために原本や数値計算を変えていません。

初回のZ3 link失敗と手動18条件、最初の診断JSONの上書き制約、build scriptの由来の改善は[link記録](S15-z3-wasi-link.md)へ残しました。今回はclean build後の予備47行を31列・42負の対照まで監査してから、清浄なcommitの正式反復へ進みました。予備を正式の5回へ加算していません。

証拠梱包の初回は、手動診断directoryを別checkoutと取り違えて停止しました。正式データは変更せず、既に生成したCSVなどの全byte一致を確かめて再開しました。初回の梱包scriptと経緯もZIPに保存しています。最初のstderrはセッションの作業記録にあり、独立したraw logとしては保存できていません。

## Zstandard配信サイズの確認

同じZ3 WASIを固定Zstandard 1.5.7のlevel 19で圧縮すると5,246,594 byteで、単一配信ファイルの25 MiB未満に収まりました。圧縮物のSHA-256は`68316b43ba3ac8c279a2640a285b5300f15d2d7722f36cc9fe876c14fa248e5e`です。host CLIで展開した31,458,902 byteは上表の元WASMと同じhashでした。このhashと圧縮物のhashは対象が異なります。

```sh
"$ZSTD" -19 -q build/S15/p2-z3-wasi-clean-link-1/objects/z3 \
  -o build/S15/replay-z3.wasm.zst
"$ZSTD" -d -c -q build/S15/replay-z3.wasm.zst | sha256sum
```

これはサイズと損失のない展開を1回確認したもので、圧縮速度の比較でもブラウザーのdecoder確認でもありません。製品のcompressed-asset loader・配布metadata・画面への組み込みはP5以降に残します。プロジェクトの保存・受け渡しはZIP、大きなWeb資材の配信はZstandardという方針を変えていません。

## 再実行

固定source・SDK・GMPを用意し、[buildの手順](S15-solver-build-and-transport.md)と[Z3の明示link](S15-z3-wasi-link.md)から4つのprobeを新規出力先へ作ります。nativeのC++ libraryはホストへ合わせて準備します。元の証拠のbuild argv、環境、compiler出力とhashも比較してください。

```json
{
  "yices2": {"native": "build/S15/replay-yices-native", "wasi": "build/S15/replay-yices-wasi"},
  "z3": {"native": "build/S15/replay-z3-native", "wasi": "build/S15/replay-z3-wasi"}
}
```

上記を`build/S15/replay-probes.json`へ保存し、次を清浄なcommitで実行します。親directoryだけを先に用意し、実行先と監査JSONには未使用の名前を指定します。記録器も監査器も既存の結果を上書きしません。

```sh
node scripts/measure-solver-protocol.mjs \
  --probes build/S15/replay-probes.json \
  --out build/S15/replay-formal --repeats 5 --aa 2
python3 scripts/audit-solver-protocol.py \
  --directory build/S15/replay-formal --out build/S15/replay-formal-audit.json
python3 -m unittest discover -s tests/check-solver-protocol
node --test tests/web/*.test.mjs
node --test tests/synth/wasi-p1.test.mjs
```

## 証拠と結論

[1,763証拠ファイルの目録](S15-solver-native-wasi-files.csv)と、それに対応する`S15-solver-native-wasi-evidence-v1.zip`を保存しました。ZIPは932,750 byte、SHA-256は`a2e0c708bccad4d333b08099cf6cf00a45ac738fd734df433a60abc32262d021`です。ZIPを開き直して目録の全entryのbyte数とhashを照合しました。raw stdout/stderr・frames・各JSON、build log、元scriptとpatchのsnapshot、予備47行、失敗したlinkと手動診断、圧縮確認、梱包のscriptと初回停止の記録を含みます。solver binaryは含みません。

P2の範囲ではWASI CLIと既存workerの方式を継続します。正常3条件の全byte一致、別の正常・異常条件、5回反復・A/A・全列監査が根拠です。Yices2とZ3のどちらを製品の既定にするかは決めていません。

SBY/yosys-smtbmcの上流process APIへの接続、BMC/prove/coverの判定、他solverの比較、schema・ZIP/OPFS・結果と波形の画面、配布とlicense closureは残件です。Node fixtureはisolationを模擬するため、ブラウザーのCOOP/COEP・画面操作を検証したものではありません。Tang Nano実機は本リポジトリでは試していません。
