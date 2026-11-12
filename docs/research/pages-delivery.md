# Cloudflare Pages公開の承認と配信

[調査索引](../../RESEARCH.md#7-分割した調査)へ戻る。

## 公開までの流れ

mainにpushした[build workflow](../../.github/workflows/build.yml)が全検査に成功したら、[公開準備workflow](../../.github/workflows/pages-delivery.yml)が承認PRを作ります。CIはCloudflareへuploadせず、Git連携がpagesブランチを配信します。人間がpreview URLで実機を確認してPRをマージすることが、本番公開の承認です。エージェントはマージ、承認の代行、Cloudflareの設定変更を行いません。本リポジトリーでは実機のTang Nanoで試していません。

1. 公開準備は`workflow_run`で起動します。成功したpush、main、同じリポジトリーに限り、APIでも元runの種別と成功を再確認します。Build、Playwright、simulation coverage、HDL/CPU parityが成功していないrunは対象外です。PR、schedule、手動run、検査を省略したrunから公開しません。
2. `gogo-fpga-web-<main SHA>`をそのrunから取得します。build側は`public_html/`を組み立て、ファイル上限、配信ヘッダー、Web単体テストを確認してこの名前で保存します。`ci-build-*`はWASMとfixtureであり、公開用ではありません。再ビルドは行いません。
3. artifactのrun・SHA・期限を照合し、ZIPのSHA-256がGitHubのdigestと一致することを確認します。相対パスだけを展開し、重複、親への移動、symlink、Gitの管理情報を拒否します。ファイル数は20,000未満、各ファイルは25 MiB未満とし、`index.html`とCOOP/COEP付き`_headers`も必須です。欠落や解析失敗を無視しません。
4. pagesがなければ、mainの履歴を持たないorphan commitで初期化します。rootは`README.md`と`public_html/`だけです。初期のindexは承認待ちの案内で、FPGAアプリは含めません。初回のアプリ公開もPRの承認を必要とします。
5. 検証したtreeを`pages-update/<main SHA>`にcommitし、pages宛てのPRを作ります。本文にmain SHA、build run、ファイル数、合計bytesと「実機で確認した」のチェック欄を記録します。同じpublic_htmlなら新しいcommitやPRは作りません。未マージの同一候補は再利用し、新しい承認PRを作れた後に古い自動PRを閉じます。すでに同じtreeが公開済みなら古い自動PRも閉じます。
6. より新しいmainの全build成功runがあれば、遅れて終了した古いrunは更新を作りません。処理は同じconcurrency groupで直列化し、force pushは使いません。pages系のpushはbuildの対象外で、pages宛てPRもbuildの対象外です。
7. 人間がpreviewの配信ヘッダー、WASMのMIME、圧縮資材の読み込みと書き込み結果を実機で確認し、チェック欄を記入してマージします。Git連携によりpagesの内容が本番へ配信されます。

`pages-update/<40桁のSHA>`は自動更新専用です。手作業の変更には使いません。初期化後もpagesにアプリのソースやworkflowを混ぜず、生成物を直接編集しません。

公開準備のコードは固定SHAのcheckout actionでmainから取得し、元runの任意のrefを実行しません。artifactも実行せず、Gitのfilterを適用しないblobとして格納します。`workflow_run`一般へのzizmor警告は、この信頼境界とAPI・digestの照合を前提に、そのtriggerの1か所だけに理由付きの例外を置いています。他の監査は無効にしません。

## 管理者が設定すること

これらの設定は自動変更しません。API tokenやCloudflareのsecretを追加する必要はなく、CIはGITHUB_TOKENだけを使います。

| 場所 | 設定 |
| --- | --- |
| GitHub Settings / Actions / General | 「Allow GitHub Actions to create and approve pull requests」を有効にする。CIは作成だけに使い、approveやmergeはしない |
| Cloudflare Pages / Git連携 | `uist1idrju3i/gogo-fpga`を接続し、production branchを`pages`にする |
| Pagesのbuild設定 | framework presetなし、rootはリポジトリーroot、build commandは空欄、output directoryは`public_html` |
| Pagesのpreview branch設定 | customにして`pages-update/*`を対象にする。mainや他の開発branchは配信しない |
| GitHubのpages用ruleset | 下記の承認・保護を設定する |

pages用rulesetはPR経由の更新と少なくとも1人の人間による承認を必須にし、新しいpushで古い承認を取り消します。force pushと削除を禁止し、通常運用でCIが直接更新できるbypassを与えません。previewのCloudflare Pages checkを必須にする場合は、実際のcheck名とappを選びます。pagesにはbuild workflowがないため、main向けのbuild checkを必須にはしません。

初回のorphan作成もrulesetで拒否される構成では、管理者が同じ承認待ちの初期branchを用意してから保護を適用します。保護のためにCIへ恒常的なbypassを付けたり、初回だけ実機未確認のアプリを本番に置いたりしません。Cloudflareを接続する前に初期branchと保護を準備することもできます。

この変更ではGitHubやCloudflareの設定、実際のpreview・本番の配信を確認していません。PR作成が403で拒否された場合は上記のActions設定を管理者が確認します。認証情報や保護規則を回避せず、失敗を解消してから再実行します。artifactは30日保持され、期限切れは失敗になります。

## ローカルでの確認

次のdry-runは一時的なローカルGitリポジトリーだけにcommitとbranchを作り、push、PR作成、Cloudflareへの通信をしません。検証済みのローカル`public_html/`を用意し、リポジトリーrootで実行します。

```sh
mkdir -p build/pages-dry-run
python3 scripts/publish-pages.py --dry-run \
  --source public_html --git-repo build/pages-dry-run/repo \
  --sha "$(git rev-parse HEAD)" \
  --run-url https://github.com/uist1idrju3i/gogo-fpga/actions
python3 -m unittest discover -s tests/check-pages-publish
```

回帰テストは初回orphan、未マージ候補の再利用、マージ後の同一treeの無更新、変更後のcommitを確認します。欠落・上限超過・危険なZIP・元runの不一致と、古い承認PRを閉じる順序も失敗側から検査します。APIのテストは模擬応答であり、GitHubやCloudflareでの実配信の確認ではありません。
