# 2セッション再監査の証拠台帳

2026-11-15の再監査を追試する保守者向けに、取得範囲、原資料、件数の訂正、未回収生成物を示します。セッション本文の結論と原資料の実数を分けます。

[再監査の入口](session-review-20261115.md) / [形式検証の詳細](session-review-formal-20261115.md) / [RESEARCH](../../RESEARCH.md#7-分割した調査)

## 1. セッションと取得範囲

| 項目 | 操作レビュー | 実装状況と計画 |
|---|---|---|
| URL | [876fba8b52d442c9ac197f5aa1ec108e](https://app.devin.ai/sessions/876fba8b52d442c9ac197f5aa1ec108e) | [d0a110d3f84f4346b049bc0f51829f8e](https://app.devin.ai/sessions/d0a110d3f84f4346b049bc0f51829f8e) |
| 作成UTC | 2026-11-14 15:17:51 | 2026-11-15 05:32:18 |
| 取得時の状態 | suspended / inactivity / archived | suspended / inactivity / archived |
| 会話API | 5メッセージ | 4メッセージ。選択式回答は別イベント |
| タイムライン | 2,067件、21ページ | 643件、7ページ |
| 全詳細の取得 | 2,067 event ID、42バッチ | 643 event ID、13バッチ |
| 主要操作の別索引 | 458件 | 139件 |
| 原添付 | 6点 | 1点 |

全2,710 event IDについて一覧と詳細を照合し、重複・欠落はありません。公開会話、shell、file操作、terminal、status等を分類しました。主要操作597件は全件と別に検索用の索引を残しています。内部セッション状態はメタデータとして区別し、調査の結論には操作・出力・添付を使います。

書庫の `sessions/<session-id>/events.jsonl` は正規化した索引、`event-details.jsonl` は会話・操作についてAPIが返したJSON本文です。後者には元のterminal圧縮payloadやfile更新の `contents_key` も保持し、前者の要約だけで置き換えていません。返却されたterminal payloadは解凍したテキストも `terminal/` に保存しました。payloadがないイベントや、元から短縮されたstdoutの完全復元を意味するものではありません。

API詳細は `max_content_length=100000` で取得しました。最初に指定した1,000,000は上限違反の422となり、修正後に取得しています。`output_trunc` を持つイベントは操作レビュー115件、実装調査40件です。この名前のフィールドがあるだけで全件が実際に途中切れとは限りませんが、元の全stdoutの復元を保証できません。

第2セッションの選択式回答 `event-01a1ddba4ba6785683fff9d11eb2c47c` は「まだ計画の確認だけで実装は不要」です。今回の依頼はその分析とresearch保存であり、機能実装へ読み替えません。

## 2. 原添付7点

書庫の `attachments/` に原ファイルのbytesをそのまま保存しました。旧報告書の数値を修正してから保存することはしません。15cと16-phoneの個別添付はZIP中の同名PNGと同一SHA-256です。

| 原資料 | byte数 | SHA-256 |
|---|---:|---|
| REPORT.md | 7,816 | `43a0e5c479d8ac6c470ef314cd1822f91a5c3b88de76d78a968f4775aa01607a` |
| USER-ACTIONS.md | 1,596 | `7203f0e9d3d604ba2c6ed093f53f8e69fd86a1d672c6e2fc268448df86b29edc` |
| events.jsonl | 41,314 | `c5e4cbb39a5feeff099cddb81ef41ac21ea6048e684126a3f3635c0e79bb97a6` |
| shots-all.zip | 29,559,622 | `14234d08226f824d293651ab64349f842f37c9ffcf63f5d6909f9c9904d73c61` |
| 15c-formal-reason.png | 427,765 | `4c49f744271c78bf319e4678770896bcb353d42c80a01f6b11e81d86f06c9a81` |
| 16-phone.png | 70,555 | `4b2d43364760481804eb5d1f68a7f6b2293689eb239b0ab68e4c10ce5a3a9449` |
| gogo-fpga-plan-20261115.md | 14,968 | `88f61460204920b490484b215efb1773e785d805b2a0848421b0ce8109cbd18a` |

最後の計画書だけが第2セッションの添付です。原URLは認証が必要なため、アクセス条件を持たない公開URLとしては扱いません。出所は上記セッションの添付一覧とファイルhashでたどれます。

## 3. 件数の訂正

| 項目 | 原報告 | 実体の再集計 | 差分 |
|---|---:|---:|---:|
| events.jsonl | 155行 | 166行。全行JSONとして解析成功 | 11行 |
| 画像 | 83枚 | ZIP内PNG 90枚 | 7枚 |
| ZIPエントリー | 記載なし | 91件。ディレクトリー1件とPNG 90件 | 該当なし |

報告後も操作・画像が追加された可能性はありますが、報告文がどの時点のスナップショットを数えたかは確定できません。差異の原因を推測だけで断言しません。最終梱包後に件数を生成すれば、この不一致を防げます。

`ZipFile.testzip()` は `None` でCRCエラーなしでした。全90枚をImageMagickでデコードし、幅、高さ、byte数、hashを目録にしました。90枚は90個の異なるシナリオを意味しません。ポーリング中や復旧前後の複数画像が含まれます。

## 4. 目視の範囲

10枚の一覧画像に9枚ずつ配置し、90/90枚を目視しました。これは縮小画像による画面状態の再確認であり、全画像の小さな文字を原寸で精読した確認ではありません。細部はevents.jsonlとterminal出力を併用しました。

| 一覧 | 元画像の範囲 | 確認内容 |
|---|---|---|
| 01 | 01から02 | 初期案内、案内を閉じた状態、新規project、VHDL、切替 |
| 02 | 03から03b | 追加、名前重複のエラー、削除、補完と編集 |
| 03 | 03bから04b | upload欄、空になったtopのビルドエラー、問題・log・成果物なし |
| 04 | 04cから05 | ソース復旧、合成成功と資源表示、シミュレーション |
| 05 | 05から06b | 検証tab、波形、SRAM/flashの設定と無効項目 |
| 06 | 07から09b | VHDL 9K合成、仮想USBの初期失敗、書込み設定 |
| 07 | 09cから11 | SRAM/flash結果、全量読み出し、ローカルFSと不一致 |
| 08 | 11から13 | offset拒否、小容量読み出し、20K消去確認と結果、カタログ |
| 09 | 13から15 | ライブラリー追加・読取専用・削除、ZIP、制約不一致、形式設定 |
| 10 | 15bから17 | 形式検証のJSON失敗、AI未接続、狭幅、420px、制約修復後 |

一覧画像、各画像と一覧の対応CSV、原画像ZIPを保存しました。元レビューのREPORTにある「正常」と、実際の画像に一時的な失敗が写ることは両立します。最終成功と途中失敗の両方を追えるようにします。

## 5. 生成物の回収状況

file操作のcreateイベントは第1セッション30パス、第2セッション1パスです。前者はレビュー用 `.mjs` 28本とREPORT/USER-ACTIONS、後者は計画書です。ログ、画像、FS、VCD、ZIPなどはshellやブラウザー側でも生成されており、createイベント31件が生成物総数ではありません。

| 種別 | 回収状態 | 根拠と留保 |
|---|---|---|
| REPORT、USER-ACTIONS、旧計画 | 本文を回収 | 原添付、hashあり |
| events.jsonl | 全166行を回収 | 原添付、全行解析済み |
| スクリーンショット | 原PNG 90枚を回収 | 原ZIP、CRC・デコード・目録あり |
| レビュー用スクリプト28本 | 操作記録・コマンド・ファイル名を回収 | 多くは `contents_key` の参照のみ。本文全体の回収とは言えない |
| VCD、FS、読み出しBIN | 存在と一部の値を確認 | 元の独立ファイルは未添付。全byteの検査はできない |
| project export/import ZIP | 操作結果と画面を確認 | ZIP本体は未添付。収録内容全体の再監査はできない |
| 元セッションの全stdout | API返却範囲を回収 | `output_trunc`、端末差分、出力上限があり完全復元は保証しない |
| 旧計画作成時の途中版 | editイベントを回収 | 添付は最終版。全revisionの本文は取得できていない |

したがって「2セッションの全生成物を一つ残らず回収・再実行済み」とは報告しません。取得可能な添付、会話、全イベントの返却範囲を保存し、未回収を明記した状態です。ログ中の元ファイルパスは原記録の一部であり、現在の再実行手順の根拠には使いません。

## 6. 途中の失敗と最終結果を分ける

主な試行失敗は、非表示の追加dialog、検証tabに移る前のsimulation button、仕様で無効なverify/dump、広すぎるlibrary selector、`fflate` のdefault import、workerへ仮想USBを注入する前の「デバイスなし」、flashの待機timeoutです。その後に状態やスクリプトを直して操作しています。

これらをすべてアプリの不具合として数えることも、最終成功を理由に消すことも避けます。アプリ側のJSON失敗、入力の誤り、期待された安全側の拒否、テスト準備の不備、時間内未完了を区別します。4 MiBの時間内未完了を「異常ではない」と確定するための比較対照は、この添付群にはありません。

代表イベントは、file追加の `event-01a1daa6c456716287e7475cdbc79e88`、仮想USB準備の `event-01a1daaf978b7e1385ed22a20e88ff96`、formalの設定操作の `event-01a1dabfe9587b518aba38e508134e53`、公開manifest取得の `event-01a1dac06fe87d538dca66e8668da5ae` です。書庫内のevent ID索引から元のコマンドと返却出力へ進めます。

## 7. 今回追加した証拠

書庫の `audit/` に次を収録しました。

- HTTP 5応答の本文、headers、取得時刻、status、サイズ、SHA-256。
- 404と200 HTMLのloader診断scriptとJSONL。各条件で同じloaderを2回呼び、fetch回数1を確認。
- `node --test tests/web/formal-*.test.mjs` の全出力。120件成功、失敗・skip 0、14ファイル。公開UI・実solver配布の確認ではない。
- S15のVHDL反例audit CSVとsolver比較CSVの件数・hash照合。前者1,785行27列、後者329行31列。
- Git基準、tool版、作業差分、文書検査の結果。

S15のVHDL CSVは本文記載のhash `62177dd23517e0f26de2b09f401920a3777472d9bff39969b48c217d4f58fcbe` と一致しました。Z3は126行あり、うち98行がexitCode 16のtool-errorです。本文の「13 FAIL件すべて」はBMC反例の条件数であり、反復を含むCSV行数とは区別します。expected=actualが一致しても、expectedがtool-errorなら証明の成功ではありません。

既存S15の大きな証拠ZIP全体の再展開、全実験の再実行、公開UIの再操作、実機、AI実アカウント、Cloudflare管理画面は今回の検査には含めません。

## 8. 保存物と再検査

この文書と同じディレクトリーの `session-review-20261115/` に、次を保存しました。

- [evidence.zip](session-review-20261115/evidence.zip): 原添付7点、会話・操作・全event IDの記録、目録、一覧画像、今回の診断と検査。
- [evidence-files.csv](session-review-20261115/evidence-files.csv): 書庫内の各ファイルのbyte数とSHA-256。目録自身を除く全ファイルを照合できます。書庫内にも同じ目録があります。
- [evidence-summary.json](session-review-20261115/evidence-summary.json): 書庫全体のhash、byte数、収録数、event件数と画像件数。

元の内部推論本文や認証秘密は配布対象にせず、該当する内部イベントはID・種別・時刻のメタデータを残します。操作・出力・添付の検査対象と、内部状態イベントを区別しています。原添付7点は変更しません。

再検査ではPython標準ライブラリーの `zipfile` でCRCを検査し、`evidence-files.csv` の全行について、展開後の長さと `hashlib.sha256` を照合しました。さらに `attachments/shots-all.zip` のCRC、PNG数90、`attachments/events.jsonl` のJSON行数166、両セッションのevent ID数2,067/643も一致しました。再検査用の `audit/verify-evidence.py` を収録し、目録と書庫の収録名が一致することも検査しています。

書庫を展開したディレクトリーで、元のZIPを指定して `python3 audit/verify-evidence.py evidence.zip` を実行できます。loader診断は同じディレクトリーから `node audit/diagnose-assets.mjs <repository-root>` で再実行できます。コードは上記基準commitを用い、Node/Pythonの実測版は `audit/audit-environment.json` に記録しました。

研究資料と原資料は今回の作業ブランチに未コミットで保存しました。持出し用の研究資料ZIPも今回セッションへ添付します。GitHubやPagesへ公開した状態ではありません。
