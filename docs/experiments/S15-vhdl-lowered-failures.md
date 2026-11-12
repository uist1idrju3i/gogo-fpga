# S15 P1 下位化比較の失敗記録と制約

[実験記録](S15-vhdl-lowered-replay.md)へ戻る。

この記録は予備実行での失敗を保持します。成功した試行へ改名したり、失敗行を削除したりしません。正式な反復の採否とは分けます。

- 最初はYosysの`proc`を行わずにVerilogを出力し、初期値の定数化で停止しました。`proc`を明示してから上流の出力機能を使います。
- coverが残るとIcarusが扱えません。Icarusのassertion再実行用だけからcoverを除去し、元のproperty一覧とPSLレポートを保持します。
- native Icarusの補助コードが前処理・コンパイル段階のwarningを捨てていました。各段階の標準出力・標準エラー・終了状態を独立保存し、最終診断にも連結しました。感度信号のない`always @*`のwarningをnative/WASMで照合する回帰を加えました。
- shared build配下でimport元のcheckoutを取り違えるprobeがありました。作業するcheckoutを起点に読み込むようにし、検査したrevisionと資材を記録します。
- native合成のflagを`--formal`としていたprobeはWASMと出力が一致しませんでした。明示した形式出力には`--formal-verilog`を使います。
- 壊す出力を`dut.q`としていた最初のmutationは、実際のharnessの`p2`と一致せず、何も変更していませんでした。生成されたポート参照を対象にし、変更後の内容と拒否結果を保存します。
- GHDLとIcarusで同じpredicateの診断回数が異なりました。全イベントの完全一致という仮定を捨て、元ログを保持したまま、propertyごとの最初の違反とIcarusの全違反の包含を検査します。
- 複数propertyではGHDLがprocessの後にソース位置を添える場合がありました。省略可能なsuffixを受け入れますが、存在する場合はdiagnosticのファイル・行との一致を要求します。
- resetのfixtureで無関係な入力変化まで曖昧として拒否しました。YosysのA/EN依存を追い、当該propertyに関わる入力を特定します。依存解析が不明な場合の拒否は維持します。
- 階層の通常assertionで、初期delta cycleのunknownに伴う数値演算warningが出ました。clocked PSLへ変えても、process footerが`numeric_std-body.vhdl:3842`を指し、元のproperty位置と一致しませんでした。未知の外部位置まで許す案は採用せず、厳密な照合へ戻しました。成功fixtureは数値関数を呼ばないbit条件とし、任意の階層演算の対応は未完了です。
- 状態検査の追加時、最適化前の3bitのPSL monitorと、準備後の2bit monitorをそのまま比較して停止しました。coverだけに関係する未使用bitが消えるため、出力直前に使用する準備済みモデルと再読込モデルを比較します。共通witnessの初期状態検査には最適化前の一覧も保持します。
- 最初の全列監査で、同じ意味のfailureオブジェクトをJSONのキー順まで比較して停止しました。id・source・stepの値で照合します。次の監査は再構成時のdepth引数が欠けて停止しました。保存済みのstepsを指定し、境界の初期状態検査も元の深さで行います。CSV検査は緩めません。
- 組合せループを前提矛盾へ誤分類しないように、Yosysの準備段階へ`check -assert`を追加しました。循環を初期化で隠しません。
- 最初の正式反復は、監査器が組合せループの診断に`logic loop`という文字列を要求して停止しました。上流Yosysはこのfixtureのループを最適化中に未駆動の`ring`へ置換し、`check -assert`が`used but has no driver`で拒否していました。回路を通す変更はせず、実際のwire名を含む診断と終了状態1を検査します。失敗した反復のログも保持します。
- 次の反復では、WASI側のANSI色コードが`Warning:`とwire名の間に入り、診断の文字列比較が停止しました。生ログとhashを保持したまま、診断の読取りに限りNode.js標準の`stripVTControlCharacters`を使います。回路・終了状態・診断本文の条件は変えません。
- スクリプト生成の単体回帰では、Yosysコマンドの区切りを改行と仮定して最初は失敗しました。実際の`; `に合わせてfixtureの期待を修正しました。
- CIの清浄なcheckoutでは、下位化比較が最初に走ると証拠の親`build/S15`がまだなく、`mkdtemp`がENOENTで停止しました。別の検査の実行順に頼らず、この検査自身が親を作ってから専用の証拠フォルダーを作ります。資材だけを用意して証拠の親を作らない作業コピーでも、修正前の失敗を確認しました。

boundary fixtureは、Xや未初期化を0に置き換えたり、memoryを無条件に展開して成功扱いにしたりしません。vacuousな有界結果を証明と呼ばず、activation coverの到達性も主張しません。生ログの出力先は`build/S15/p1-vhdl-lowered-*`で、実験全体の証拠とともに保全します。
