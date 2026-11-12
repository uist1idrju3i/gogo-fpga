# S15: Z3 WASIのlinkと単一threadの境界

[実験索引](README.md) / [buildと輸送](S15-solver-build-and-transport.md) / [実応答比較](S15-solver-protocol.md)

その後、`3ea717e965a24b9d5738301b0c1a49c7e83fdf6b`からのclean buildが完了しました。Z3 native/WASIを含む各5回・A/A 2回、全329行31列・294負の対照の監査と、警告・圧縮サイズ・再実行・証拠を[正式比較の記録](S15-solver-native-wasi.md)へ分けています。以下の失敗や手動診断を正式結果へ置き換えずに保持します。

## 目的と事前基準

固定Z3 `430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e`をWASI SDKの実装でlinkし、既存のworker・WASI Preview 1 shim・字句framerへ接続します。solverの意味、丸め、例外を模倣しません。正常応答、異常分類、nativeとの全byte比較の基準は[S15の実応答比較](S15-solver-protocol.md)を維持します。正式採用には清浄なcommitからのbuild、5回反復、A/A 2回と独立監査が必要です。以下の手動診断はその代わりになりません。

## 清浄なbuildの失敗

`537a140b4ba4e233af6606a78071e80e08ce858b`のdriverによる`p2-z3-wasi-2`は全sourceのコンパイル後、linkで終了2になりました。driverの経過時間は4,503.496秒です。未解決symbolは`__cpp_exception`、`__wasm_lpad_context`、`_Unwind_CallPersonality`と`pthread_atfork`でした。metadataのstatusは`error`、artifactはnullです。build logのSHA-256は`a17873911700f93d1df3b57b748564539ba73d0c51bdef38b1eb8261a32d1295`です。失敗したmetadataとlogを変更せずに保持します。

SDKの`wasm32-wasip1/eh/libunwind.a`を`llvm-nm`で読み、最初の3 symbolが定義されていることを確認しました。`clang++ -fwasm-exceptions -###`ではEH用の検索pathを選びますが、`-lunwind`は自動追加されません。driverはSDKの`-lunwind -lsetjmp`をCMakeの標準ライブラリー指定へ追加します。CMakeが実際に出力したファイル名は`objects/z3`であり、driverの従来の`z3.wasm`探索も修正します。

## forkとyield

固定Z3の[`scoped_timer.cpp`](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/util/scoped_timer.cpp)は`Z3_SINGLE_THREADED=ON`と`Z3_POLLING_TIMER=ON`でも、初期化時に`pthread_atfork`を参照します。[patch](../../patches/z3/wasi-no-fork.patch)はforkを提供しないWASIだけでその登録を除外します。pollingによるtimeout計算、native側の登録、solverの判定は変更しません。threadやforkを実装したことにはせず、製品側の期限は専用workerで管理します。

link後のmoduleは標準WASIの`sched_yield`をimportしました。最初の診断はshimにこのimportがなく、起動できませんでした。単一guest threadでは他の実行可能なguest threadがないため、既存shimへ成功を返すyieldを追加します。入力消費、descriptor、memoryを変えず、hostのevent loopを同期的に進める機能やpthread対応とはしません。callbackの期限・取消は既存のhost worker管理を使います。

## 隔離した手動診断

失敗したbuildのobjectを保持したまま、別のsourceへfork登録除外だけを適用し、そのobjectとSDKの例外ライブラリーを別の出力へlinkしました。診断用WASMは31,455,835 byte、SHA-256は`4d00d35f417e9fae2456b17b69e053e3598a70a9d1a9d8cc3557c8ed74162688`です。配信上限25 MiBを超える未stripの診断用資材であり、そのまま製品へ同梱しません。

yield追加後はZ3 WASIの18条件が各1回通りました。bit-vector、array、長い値、構文エラー、応答欠落、待機中と計算要求後の期限切れ・取消、古いjob、hash不一致、破損WASM、worker crash、終了通知欠落、出力上限、unknown、SMT浮動小数点、hardware丸め拒否を含みます。hardware丸めは終了1のerror応答となり、nativeの成功と同等の判定にはしません。

これは手動で作った診断用binaryと未コミットのshimによる結果です。nativeとの正式比較、清浄なdriverの完走、形式検証UIや実ブラウザーでの確認は未完了です。最初のimport不足はconsole logを保存しましたが、診断scriptの再実行で条件別JSONが置き換わりました。最初の条件別JSONを保全済みとは扱いません。正式計測は従来どおり既存出力を拒否し、新しい出力先で行います。

## buildと計測の履歴の分離

証拠format 3では、4つのbinaryごとに実際のbuild script原文を保存し、metadataのhashとbuild commitの原文へ独立照合します。計測時のscriptも別に保存して計測commitと照合します。WASI用driverの修正だけで、変更のないnative binaryやYices2を同じdriverで作ったかのように扱いません。任意の古いhashを許可する仕組みではなく、各build commitを40桁のGit object IDに限定し、原文の不一致や欠落を拒否します。従来のformat 2の監査も残します。

## clean buildの再実行

固定SDKとCMakeを準備し、変更をcommitした清浄なcheckoutで実行します。`CMAKE`は実行するCMakeのpathです。元の出力先は再利用しません。

```sh
python3 scripts/build-solver-probe.py --solver z3 --runtime wasi \
  --jobs 2 --cmake "$CMAKE" --out build/S15/replay-z3-wasi-link \
  --patch patches/z3/unsupported-wasm-hwf-rounding.patch \
  --patch patches/z3/wasi-no-fork.patch
python3 -m unittest discover -s tests/check-solver-protocol
node --test tests/web/solver-protocol.test.mjs tests/web/wasi-stdin.test.mjs
```

この時点ではclean buildと正式反復の成功を主張しません。完了後、各binaryのhash・raw CSV・全列監査とresourceを実応答比較の記録へ同期します。
