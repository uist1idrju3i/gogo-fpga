# DeepWikiの構成と検査

この文書はWikiを保守する開発者向けです。[調査の索引](../../RESEARCH.md#7-分割した調査)から参照できます。設定の正本は [`.devin/wiki.json`](../../.devin/wiki.json) です。Wikiは派生した案内であり、実装、テスト、原記録の代わりではありません。

## 公式仕様と採用した範囲

2026-11-13に[DeepWiki repository wikisの公式説明](https://docs.devin.ai/work-with-devin/deepwiki)を確認しました。設定には `repo_notes` と、空でない `pages` が必要です。設定がある場合は自動のページ選定を置き換え、列挙したページだけを生成する仕様です。足りない主題が自動で補われることを前提にしません。

[Validation Limits](https://docs.devin.ai/work-with-devin/deepwiki#validation-limits)には次の上限があります。

| 項目 | 公式説明 | 本リポジトリーの検査 |
| --- | --- | --- |
| ページ数 | Maximum 30 pages (80 for enterprise) | 通常枠の1から30ページ |
| ノート総数 | Maximum 100 total notes | repo_notesと全page_notesの合計100件まで |
| ノート本文 | Maximum 10,000 characters per note | 各contentを10,000文字まで |
| タイトル | Page titles must be unique and non-empty | 重複・空白だけのタイトルを拒否 |

`repo_notes` の要素は必須の `content` と任意の `author` を持ちます。ページには必須の `title`・`purpose` と任意の `parent`・`page_notes` を使います。`page_notes` は既存設定と同じく `content` を持つノート配列として検査します。親の省略と `null` を受け付け、ページの順序には依存しません。

確認した公式ページにはWikiの言語を英語に限定する規定や、言語専用の設定項目はありません。AGENTS.mdに従って本文と見出しを日本語にし、その生成指示もrepo_notesへ明記します。識別子やパスは英語のままです。

## 構成を変えた理由

変更前は10ページ・15ノートで、書き込みだけのT0を前提とし、合成やIDEを将来機能としていました。現在の実装と時点が合わないため、20ページ・27ノートへ組み直しました。

- 全体像から、ブラウザー内の構成、IDE、ボード、ビルド・CI、開発参加へ進めます。
- 構成の子ページは合成、配置配線、pack、書き込み、シミュレーション、形式検証です。Yosys・GHDLからnextpnr、Apicula・Pyodide、openFPGALoader・WebUSBまでの境界と入出力を追います。
- IDEの子ページはUX契約、PKCEとキー、AI相談と差分採否、HDLライブラリーです。接続時の通信と本文確認後の送信を分け、研究中の教師役や補完を実装済みとしないよう指示します。
- ビルド・CIの子ページは再現性と配布、Pagesの承認、仮想USBです。mainの成功と人間による公開承認、案内ページと生成アプリ、仮想の成功と実機未確認を区別します。

各ページのpage_notesに、読んでほしい実装・テスト・調査のパスを置きました。依存の版や性能値を設定へ転記せず、pin checkerや固定条件付きの実験へ戻る構成です。IDCODE、FAILログによる失敗検出、実機未確認はrepo_notesと書き込み・テストのページで保持します。

RESEARCH.md、docs/research 、docs/experiments 、docs/ux を説明の根拠として優先します。ただし初期計画と後続の実装が食い違う場合は、コードとテストで現在の到達範囲を確認し、時点を分けるよう指示します。vendor/、third_party/、生成public_html、docs/ux/out は説明の優先度を下げます。これは索引からの強制除外ではなく、外部ソースの接続やライセンスが必要なら参照します。

## 検査と更新

```sh
python3 .github/scripts/check-deepwiki.py
python3 -m unittest discover -s tests/check-deepwiki -v
```

lint workflowで両方を実行します。検査はPython標準ライブラリーだけを使い、公式の通常枠の上限に加え、このリポジトリーの保守方針として次を拒否します。

- 読取り失敗、不正なUTF-8・JSON、重複JSONキー、NaNなどの非標準値
- 必須項目の欠落、型の不一致、未知の項目、空白だけの本文・目的・author
- タイトル前後の空白、存在しない親、自分自身や複数ページを巡る親の循環

文字数はUTF-8のバイト数でなく、Pythonの文字列長で数えます。公式説明には文字数の具体的な数え方の記載がないため、この方式をローカル検査の基準とします。30ページ、合計100ノート、10,000文字の境界と、正常・空・不正入力をテストします。公式に新項目が増えた場合は、未知の項目の検査を外すのではなく、仕様を読み直して検査とテストを更新します。

実際のDeepWiki再生成、公開Wikiへの反映、日本語やページ構成が生成結果に従われることは、この変更では確認していません。JSONと階層の検査は文章の正確さを保証しないため、再生成後はソースリンク、対応範囲、安全上の制約を人間が確認します。
