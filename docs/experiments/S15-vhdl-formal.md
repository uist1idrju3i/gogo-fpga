# S15 P1: GHDLの形式property保持

## 目的と事前基準

基準は`962434ed27d9762ed4da0d0a1b72c6778a0dd1a5`です。上流GHDLのVHDL・PSL解析とmonitor生成は再実装せず、既存のassert/assume/cover gateを、明示した形式出力のときだけYosysの内部cellへ渡します。通常のVerilog出力は変更しません。

nativeとWASMを同じソースから作り直し、通常出力の既存19件、plain assertion、PSLコメントの明示選択、assert/assume/coverとassertion activation coverの種類、元のlabelとsource位置を照合します。Yosys準備前後の一覧保持、深さN-1/N/N+1、矛盾したassume、property消失、PSL未有効化、非boolean設定、古いWASMへの形式設定、unknownと途中終了を確認します。native/WASMのVerilogとproperty一覧は全バイト一致を条件とし、ソルバーの反例は元の回路での独立再実行も必要です。

この段階は実装を検査する診断です。正式な5回以上の反復、A/A、ブラウザーへの統合、VHDL原文での独立再実行を終えるまで、T6 P1全体の完了には数えません。SMTソルバーとSBYの実行結果に読み替えません。

## 予備調査

GHDLの従来出力はassertが`$fatal`、assume/coverがVHDL形式であり、そのままは利用できません。Yosysの`read_verilog -formal -icells`では、明示した`$assert`と`$assume`が元の`src`属性とinstance名を保持することを予備入力で確認しました。一方、手続き内で属性とSVA labelを組み合わせた予備入力は構文エラーになりました。どちらのログもS15の証拠に残します。

GHDLのsource位置は開始位置のみなので、形式出力の`src`は同じ開始位置を両端に記録します。これは原文の完全な範囲を復元したものではありません。PSL assertion activation用の`Id_Assert_Cover`はassertではなくcoverへ渡す必要があります。

## 状態

清浄な実装commitでも通常合成の既存19件と形式出力14件、計33件が成功しました。生CSVの全44行11列も監査して保存しています。反例は独立再実行の前なので`pending`のままです。正式反復とT6全体は未完了です。実機Tang NanoとCloudflare Pages公開は本リポジトリでは試していません。

## 初回の失敗と修正

最初のビルドは成功しましたが、比較30件のうちPSL4件が失敗しました。nativeではpropertyが残り、WASMではPSLコメントが読み落とされました。[上流options.adbの`-fpsl`](https://github.com/ghdl/ghdl/blob/e589c698c351369ac5bcfe7abe1f1152ac5d4727/src/options.adb#L250-L252)は、`Flag_Psl_Comment`だけでなく`Flag_Comment_Keyword`も有効にしています。WASM APIを同じ設定に直し、別の出力先で再ビルドしました。

2回目の比較は29件成功、1件失敗でした。単純な`always`にはactivation stateがない場合があり、矛盾するassumeのfixtureにはcoverを生成しません。上流の`Get_Active_State`による条件を確認し、このfixtureの期待値をassert 1・assume 2・cover 0へ直しました。基準を削るのではなく、`a = '1' -> next (count < 3)`という時間性質を別に追加し、`p_bound_cover`がassertでなくcoverであることも検査します。3回目は33件すべて成功しました。

検査用の小さなWASMにも初回はconstructor exportがなく、単体8件のうち2件が失敗しました。fixtureへexportを加えた後は8件すべて成功しています。各失敗ログと途中のproperty一覧も保全します。

提出前の差分検査は、patchの空行contextにある末尾空白を検出しました。空行を含まないcontextへ直したbuild3では、末尾にcontextのないimport追加hunkが適用に失敗しました。追加位置を既存importの間へ移し、dry runで確認してからbuild4を新規に開始しました。上流のproperty処理と通常出力を変える修正ではありません。build2のsource hashはこのpatch変更後と一致しないので、最終検証には使いません。

## 固定条件と再実行

ホストはUbuntu 22.04.5 LTS、x86_64、2論理CPU、MemTotal 8,132,568 KiBです。GHDLはUbuntu 26.04.1 LTSの隔離環境でビルドし、比較も同じ環境で実行しました。nativeの実行表示はGHDL 6.0.0、GNAT 14.3.0、mcodeです。Nodeはv24.21.0、WASMのbuild manifestはAdaWebPack 24.0.0・WASI SDK 34.0・clang 23.1.0を記録しています。Yosysは前層と同じ製品用0.70のnative/WASIを再利用し、JSONのcreatorをpinと照合します。ホストではnative GHDLが要求するGLIBC 2.38を満たさないため、native実行も隔離環境で行います。

新しいビルドは`GHDL_WASM_BUILD_ROOT=build/S15/vhdl-formal-build2`を指定しました。初回の失敗を残したbuild1は上書きしていません。通常のCIでは既定の`build/`を使います。

```sh
GHDL_WASM_BUILD_ROOT=build/S15/vhdl-formal-build2 JOBS=1 scripts/build-ghdl-wasm.sh
GHDL_WASM_BUILD_ROOT=build/S15/vhdl-formal-build2 node --test --test-concurrency=1 tests/synth/formal-vhdl.test.mjs tests/synth/ghdl-wasm.test.mjs
node --test --test-concurrency=1 tests/web/*.test.mjs tests/synth/formal-sat.test.mjs tests/synth/formal-replay.test.mjs tests/synth/iverilog-wasm.test.mjs
```

各比較は`build/S15/p1-vhdl-<一意名>/`を新規作成します。manifestにrevision・未コミット差分・Node・native GHDLの実表示とhash・WASM hash・build manifestを保存します。11シナリオそれぞれで、GHDLの2出力をYosysの2実行系へ渡した計44行11列の生CSVを保存します。全44行の期待値・実値・property数・3つのhashを監査し、反例28行、有界安全8行、PSL無効のerror4行、前提矛盾4行に分類できました。error4行では一覧が得られず、3種類のproperty数は空欄です。0個と解釈しません。反例を独立検証済みとは表示しません。

元VHDL、GHDLの全stdout/stderr、生成Verilog、Yosysのscript・中間JSON・RTLIL・結果・反例を保存します。入力hashと通常出力も同じ証拠に含め、CIでは既存のGHDL/Yosys資材を使い`ci-formal-vhdl-<run_id>`へ7日間保存する構成です。CIは全実装後の確認とし、この段階では未確認です。

| build2で比較した成果物 | SHA-256 |
|---|---|
| GHDL native | `42d7a51d735f826ee7c05d9e41c73b067df81ec78445765dc20c4a68a8ab9adc` |
| GHDL WASM | `a0bd7fe303e7531d606aac5181ee67bb1ee6ce88fce2360947a7d5e1399c85e8` |
| 標準library archive | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` |

## 清浄な実装commitでの診断結果

`72080be6aa96821660c52ac5d9f3f351f5dba233`を固定し、build4を新規にビルドしました。source manifestが現在のpatch・Ada APIと一致し、比較時の`workingTree`も空文字列です。前述のGHDL比較コマンドのbuild rootだけを`build/S15/vhdl-formal-build4`へ変えて実行し、33件成功、失敗・skip・cancel各0件でした。Web・SAT・Verilog反例再実行・Icarusの213件も、実装が同じ清浄な`4001f2f666f26cb4bbbbacc9a29b06c489b723ec`で成功しています。後続の差分はGHDL patchのimport位置と本記録だけで、最終提出する版でも両方を再検査します。

[生CSV](S15-vhdl-formal.csv)の全44行11列、計484値を監査しました。元VHDLのhash、native/WASMの生成Verilog・property一覧のhash、期待値・実値・実行系と4通りの組合せを照合しています。property数の空欄は一覧のないerror4行だけです。28反例の結果JSONでは`replay: pending`とVCD・WaveJSONの存在も確認しました。CSVはSHA-256 `a5cbd44dfbdf5a53e0f11bd4b0bbaaac30e7d5168433403859ebe16b5b91df10`、実行manifestは`32dbd62f389575a53e6f4fbe12aa8cde13d16eb0767e5e1d7f41aa241988ad6c`、33件の全ログは`b7d62778be659d5d19c8c358b96d4cf83549d24682e78aa8466953c34fc57fd7`です。

build4のWASMとlibrary archiveはbuild2と同じhashでした。nativeは`ccb93bf7a700b692cff3fe16e833f5ba6b5842393cfd07e8af062c8c441ff6d5`、形式出力patchは`dd0869c96d23d97f6d4d298aaf1ca14146979f9c90e98590b863d1ca06fcf02b`です。開始位置だけのsource属性、GHDLの小文字化したlabel、activation coverの生成条件は変えていません。ビルドには既存の`-nostartfiles`未使用警告がありましたが、比較でunknownを成功へ読み替えてはいません。

## 未確認の範囲

この層はpropertyの保持とSATまでの接続です。通常合成の名前付きlibrary回帰19件は確認しましたが、一般の階層・複数assertion・library依存・reset・X・memory・組合せloopを含む形式検証、PSL全構文、VHDL原文での独立再実行は未完了です。activation coverを実際に到達させるcover engine、vacuity、worker、ブラウザー、SMT/SBY、5回反復とA/Aも残っています。
