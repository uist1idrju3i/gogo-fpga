# Cloudflare Pages公開の承認と配信

[調査索引](../../RESEARCH.md#7-分割した調査)へ戻る。

## 公開までの流れ

mainにpushした[build workflow](../../.github/workflows/build.yml)が全検査に成功したら、[公開準備workflow](../../.github/workflows/pages-delivery.yml)が承認PRを作ります。CIはCloudflareへuploadせず、Git連携がpagesブランチを配信します。人間がpreview URLで実機を確認してPRをマージすることが、本番公開の承認です。エージェントはマージ、承認の代行、Cloudflareの設定変更を行いません。本リポジトリーでは実機のTang Nanoで試していません。

1. 公開準備は`workflow_run`で起動します。成功したpush、main、同じリポジトリーに限り、APIでも元runの種別と成功を再確認します。Build、Playwright、simulation coverage、HDL/CPU parityが成功していないrunは対象外です。PR、schedule、手動run、検査を省略したrunから公開しません。
2. `gogo-fpga-web-<main SHA>`をそのrunから取得します。build側は`public_html/`を組み立て、ファイル上限、配信ヘッダー、Web単体テストを確認してこの名前で保存します。`ci-build-*`はWASMとfixtureであり、公開用ではありません。再ビルドは行いません。
3. artifactのrun・SHA・期限を照合し、ZIPのSHA-256がGitHubのdigestと一致することを確認します。相対パスだけを展開し、重複、親への移動、symlink、Gitの管理情報を拒否します。ファイル数は20,000未満、各ファイルは25 MiB未満とし、`index.html`とCOOP/COEP付き`_headers`も必須です。欠落や解析失敗を無視しません。
4. pagesがなければ、mainの履歴を持たないorphan commitで初期化します。rootは`README.md`と`public_html/`だけです。初期のindexは承認待ちの案内で、FPGAアプリは含めません。初回のアプリ公開もPRの承認を必要とします。
5. 検証したtreeを`pages-update/<main SHA>`にcommitし、pages宛てのPRを作ります。本文にmain SHA、build run、ファイル数、合計bytesと「実機で確認した」のチェック欄を記録します。同じpublic_htmlなら新しいcommitやPRは作りません。未マージの同一候補は再利用し、新しい承認PRを作れた後に古い自動PRを閉じ、そのheadブランチを削除します。すでに同じtreeが公開済みの場合も、古い自動PRを閉じてheadブランチを削除します。

承認PRを整理するたびに、公開内容が変わらない場合も含め、同じリポジトリーに残る不要な候補ブランチを削除します。対象は名前全体が `pages-update/<小文字の16進40桁>` に一致し、pages宛ての開いているPRに使われていないブランチだけです。以前に閉じたPRのブランチも次回の公開準備で削除します。マージ済みPRのブランチはGitHubのマージ後の自動削除に任せます。pages、現在の承認候補、ほかの名前のブランチ、fork側のheadは削除しません。forkからの開いているPRと同名の候補も念のため残します。

削除前にブランチと開いているPRを全ページ取得し、応答の形式を検査します。古いPRを閉じた後にも開いているPRを取得し直します。どちらかの一覧の取得や検査に失敗した場合は、ブランチを一つも削除せず公開準備を失敗させます。削除APIの404は削除済みとして扱い、422は参照の再取得が404になる場合だけ許容します。それ以外の削除エラーも失敗です。権限は既存の `contents: write` と `pull-requests: write` を使います。新しい全検査済みbuildがある場合など、承認PRの整理に到達せず処理を見送るrunでは削除しません。
6. より新しいmainの全build成功runがあれば、遅れて終了した古いrunは更新を作りません。処理は同じconcurrency groupで直列化し、force pushは使いません。pages系のpushはbuildの対象外で、pages宛てPRもbuildの対象外です。
7. 人間がpreviewの配信ヘッダー、WASMのMIME、圧縮資材の読み込みと書き込み結果を実機で確認し、チェック欄を記入してマージします。Git連携によりpagesの内容が本番へ配信されます。

`pages-update/<40桁のSHA>`は自動更新専用です。手作業の変更には使いません。初期化後もpagesにアプリのソースやworkflowを混ぜず、生成物を直接編集しません。

公開準備のコードは固定SHAのcheckout actionでmainから取得し、元runの任意のrefを実行しません。artifactも実行せず、Gitのfilterを適用しないblobとして格納します。`workflow_run`一般へのzizmor警告は、この信頼境界とAPI・digestの照合を前提に、そのtriggerの1か所だけに理由付きの例外を置いています。他の監査は無効にしません。

## mainの案内ページと生成物

Cloudflare Pagesのブランチ指定に対する回避策として、mainにも `public_html/` を置きます。追跡するのは案内用の `index.html` だけで、アプリの公開先 `https://fpga.moe/` とpagesブランチを示します。外部資材やscriptは読み込まず、検索対象から外すmetaを付けます。アプリの配信ヘッダーは従来どおりビルドで `web/_headers` から取得し、案内用の別の `_headers` は追跡しません。

`scripts/build-web.sh` は案内を含む出力先を作り直し、`web/index.html` を含む完全なアプリを `public_html/` に生成します。ビルド直後に追跡中のindexが変更扱いになるのは想定内です。`site-distribution` の検査後に、そのアプリをWeb artifactへ保存します。後続stepにclean treeへの依存がないため、CIでは案内へ戻しません。公開準備workflowはmainの案内ではなく、従来どおり検査済みartifactだけを取り込みます。pagesブランチの構成と承認手順は変えません。

lintの [main用案内検査](../../.github/scripts/check-main-placeholder.py) は作業treeではなくcommitのtreeを読みます。追跡対象が通常ファイルの `public_html/index.html` だけであること、案内のmarker、製品名、pagesと公開先リンクを要求し、script・資材の参照や想定外の要素・属性を拒否します。生成したアプリや余分な生成物を誤ってcommitすると失敗します。

ローカルではアプリの検査やartifact作成を終えてから、次で案内へ戻せます。案内への未commitの変更も戻るため、必要な変更は先に保存してください。無視された生成物は残り、再びアプリを動かすにはビルドし直します。

```sh
git checkout -- public_html
```

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

導入時にはGitHubやCloudflareの設定、実際のpreview・本番の配信を確認していませんでした。後続の配信確認は下節に分けます。PR作成が403で拒否された場合は上記のActions設定を管理者が確認します。認証情報や保護規則を回避せず、失敗を解消してから再実行します。artifactは30日保持され、期限切れは失敗になります。

### 推奨するGitHub設定と確認の限界

以下は管理者への推奨であり、設定済みと確認した記録ではありません。

- mainのrequired checksには `check`、`lint`、`zizmor`、`Build`、`Playwright E2E`、`Simulation shard coverage`、`Pyodide gowin_pack (hdl)`、`Pyodide gowin_pack (cpu)` を指定し、上流の合成・配置配線・比較jobも含めて保護対象を選びます。依存jobの失敗によるskipを成功と取り違えないようにします。
- マージ方式はsquashだけにし、Actionsの既定権限はread-onlyにします。公開準備だけに `contents: write` と `pull-requests: write` を明示し、PR作成の許可を有効にします。
- Releaseの `v*` tag作成をrulesetで制限するなら、作成用の規則に限ってGitHub Actionsのbypassを検討します。tag更新・削除の禁止は別に保ち、mainやpagesの保護にはbypassを与えません。

`GITHUB_TOKEN` によるpushやPR作成は、通常は別のActions workflowを起動しません（[GitHubの説明](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)）。承認PRに通常のPR検査が付かないことを、成果物の検査を省いてよい理由にはしません。元main runの全build成功とartifact検証を公開準備側で要求します。

通常の開発PRに現れるCloudflare Pages checkは、所有者が管理するGit連携の設定です。main向けCIの推奨必須項目には含めません。previewを配信する承認PRで必要なcheckと、通常の開発PRのcheckは区別します。

## Pagesの設定判断と配信確認

build watch pathsのincludeは `*` のままにします。配信対象をpages系branchだけに絞っているため、さらにパスを狭める利点は小さく、rootの設定変更や下位の生成資材の更新を見落とすおそれがあります。root directoryはリポジトリーroot、output directoryだけを `public_html` にします。両方に `public_html` を指定して二重のパスにしません。

[PR #8](https://github.com/uist1idrju3i/gogo-fpga/pull/8)のpreviewが404になった事象を確認しました。production branchの変更時にcustom preview対象の `pages-update/*` が外れた可能性がありますが、管理画面の設定履歴を確認していないため原因は未確定です。後の[PR #10](https://github.com/uist1idrju3i/gogo-fpga/pull/10)ではpreviewの配信を確認しました。404だけから成果物の破損やbranch controlの変更を断定しません。

2026-11-12 23:53 UTCに、[fpga.moe](https://fpga.moe/)と[gogo-fpga.pages.dev](https://gogo-fpga.pages.dev/)をheadless Chromiumで読み込み、両方で次を確認しました。公開設定の管理画面を調べた結果や、実機での書き込み成功ではありません。

| 対象 | 両originでの結果 |
| --- | --- |
| browser機能 | `crossOriginIsolated === true`、`SharedArrayBuffer` と `WebAssembly.Suspending` はfunction、`navigator.usb` はobject |
| `/`、`/surfer/surfer_bg.wasm`、`/synth/yosys.wasm.zst` | HTTP 200、COOP `same-origin`、COEP `require-corp`、CORP `same-origin` |
| Surfer WASM | `Content-Type: application/wasm` |
| `.zst` | `Content-Type: application/octet-stream`、`Content-Encoding` なし。ブラウザー内で展開する圧縮済みbytesとして配信 |

再確認はChromiumの `page.evaluate` で上記の機能を読み、同じURLにHEADを送ってヘッダーを調べます。USB APIが存在することは、機器へのアクセスや書き込みを確認したことにはなりません。公開側が今後のmainと常に同じ内容であることも、この確認では保証しません。

## 公開元の表示とDeepWiki

画面上部に「公開版」と元のmainコミットの短いSHAを表示します。リンク先はGitHubの元コミットで、リンクの説明に完全なSHA、コミット日時とbuild runを載せます。「仕組みを読む · DeepWiki」はツールの説明を別タブで開きます。アプリの読み込み時にDeepWikiへの通信や外部画像の読み込みは行いません。

公開準備はGitHub APIで元コミットのSHAとcommitter日時を確認し、`public_html/publication-info.json` だけを追加・置換します。アプリのartifactには元コミットを埋め込まず、開発用の同名ファイルには `null` だけを置きます。既存の `build-info.json` はWASMの検証情報なので変更せず、比較からも除きません。artifactのZIP digestと全ファイルの検査は従来どおり行い、公開用のメタデータ以外は同じバイト列を保存します。

同一内容の判定から除くのは `public_html/publication-info.json` だけです。アプリが変わらなければ承認PRを作らず、公開中のメタデータも元のまま保ちます。本番の公開版は最後に承認された配布物の出自を示し、最新mainへの追従を意味しません。previewでは承認候補の出自を表示します。ファイルが欠落、不正、取得失敗の場合は「開発版」のまま表示し、編集やビルドを妨げません。取得は同一originだけに制限し、外部へのredirectも拒否します。CSPは変更しません。

## ローカルでの確認

次のdry-runは一時的なローカルGitリポジトリーだけにcommitとbranchを作り、push、PR作成、Cloudflareへの通信をしません。検証済みのローカル`public_html/`を用意し、リポジトリーrootで実行します。

```sh
mkdir -p build/pages-dry-run
python3 scripts/publish-pages.py --dry-run \
  --source public_html --git-repo build/pages-dry-run/repo \
  --sha "$(git rev-parse HEAD)" \
  --run-url https://github.com/uist1idrju3i/gogo-fpga/actions/runs/1 \
  --commit-date "$(TZ=UTC git show -s --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd HEAD)"
python3 -m unittest discover -s tests/check-pages-publish
```

回帰テストは初回orphan、未マージ候補の再利用、マージ後の同一treeの無更新、変更後のcommitを確認します。欠落・上限超過・危険なZIP・元runの不一致と、古い承認PRを閉じてheadを削除する順序も失敗側から検査します。不要ブランチの削除、開いているPRの保護、名前とforkの除外、一覧の取得失敗と不正な応答、削除済みの参照、APIのページ分割も検査します。APIのテストは模擬応答であり、GitHubやCloudflareでの実配信の確認ではありません。
