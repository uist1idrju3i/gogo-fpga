# リポジトリー統合と配信の確認事項

[調査の索引](../../RESEARCH.md#7-分割した調査)へ戻る。

製品名は「午後のFPGA」、正規リポジトリーは [uist1idrju3i/gogo-fpga](https://github.com/uist1idrju3i/gogo-fpga) です。npm の識別子と配布archive名には `gogo-fpga` を使います。書き込みは製品内の機能として扱います。

## M0: 履歴とファイルの保存

統合時の比較対象は旧toolchainの `544f5cf` と旧flasherの `dcbeb67` です。[toolchainの統合commit](https://github.com/uist1idrju3i/gogo-fpga/commit/30cf64b)と[flasherの統合commit](https://github.com/uist1idrju3i/gogo-fpga/commit/00379e7)で履歴を取り込みました。両方の旧mainは現在のmainの祖先です。2026-11-12の再照合でも、mainから到達するオブジェクトの欠落は0件でした。

| 統合完了時 `00379e7` との比較 | 結果 |
| --- | --- |
| toolchainの同一パス | 804パスのオブジェクトとmodeが一致。例外は統合先の条件を残したroot `LICENSE` だけ |
| flasherの同一パス | 66件が一致。45件は後継toolchain版を採用。root `LICENSE` は統合先のBSD-3-Clauseを保持 |
| flasherだけにあった実験記録 | S0、S1a、S1b、S2、S3の各MarkdownとCSV、計10ファイルを同じパス・内容で保存 |
| submodule | 共通6件のSHAが一致。toolchainだけの35件を含め、全41件のgitlinkを保存 |

10ファイルの組は `S0-wasm-build`、`S1a-program-sim`、`S1b-option-matrix`、`S2-ci-sim-environment`、`S3-ci-speed` です。[実験索引](../experiments/README.md)から原記録を参照できます。45件の差は欠落ではなく後継版の採用であり、現在のtreeが移行時のtreeと同一という意味ではありません。

履歴と比較対象は、旧リポジトリーを取得し直さずに次で確認できます。`--missing=print` の出力に `?` で始まる行があれば欠落です。tree比較では内容だけでなくmodeとgitlinkも照合します。

```sh
git merge-base --is-ancestor 544f5cf origin/main
git merge-base --is-ancestor dcbeb67 origin/main
git rev-list --objects --missing=print origin/main
git ls-tree -r 544f5cf
git ls-tree -r dcbeb67
git ls-tree -r 00379e7
```

## 旧リポジトリーの削除前確認

2026-11-12の削除前確認では、両リポジトリーにtagとReleaseはなく、GitHub Pages APIは404を返しました。main以外のbranchはDependabotによるものだけでした。flasherのApycula 0.35更新案は、旧書き込み部のfixtureが0.32を固定していたため採用しませんでした。これは当時の更新案の扱いで、後継toolchainの採用版を0.32へ戻す判断ではありません。

移行時のsubmodule設定と実行用workflowに、旧リポジトリーへの依存が残っていないことも確認しました。保存した履歴やAPI生データ内の旧名は、実行時の依存とは区別します。Cloudflare project、独自ドメイン、secret、webhook、deploy keyはエージェントが確認できた範囲に含めません。GitHub Actionsのsecret・variableの取得も403だったため、「存在しない」とは扱いません。これらは所有者による削除前確認が必要です。

## 旧リポジトリーの参照

旧toolchain・flasherのファイルは本リポジトリー内の相対リンクで参照します。PR・issue・Actionsの実行やartifactは削除後に取得できないため、旧リポジトリーでの識別番号を本文に残し、リンクは使いません。書き込み部の元の調査記録は[初期調査記録](flasher-history.md)、S0〜S3は[実験索引](../experiments/README.md)から読めます。

例外は [S8](../experiments/S8-ci-speed.md) の `docs/experiments/S8/raw/` に保存したGitHub API応答24件です。`36afaf3`、`M1`、`M2`、`M3`、`R7`、`R8`、`W1`、`W2`、`W3`、`W4`、`failed-5d752ee`、`fix-6a5e595` の各 `-jobs.json` と `-run.json` を改変せず保持します。これらのURLやリポジトリー名は取得当時の生データで、現在の参照先や再取得の手順ではありません。旧リポジトリーの削除後にURLが使えるとは扱いません。

## 著作権と第三者ライセンス

独自コードの条件はBSD-3-Clause、著作権表記は `Copyright (c) 2026, Y.Yamashiro` です。第三者の原文と条件は変更しません。

`licenses/synth-explorer-LICENSE` は、GitHubユーザーcachanovaの [synth-explorer](https://github.com/cachanova/synth-explorer) から採用したコードに対応します。固定commit `d4dab3def346cb9fdac5bc171d801bd091df72e1` の [LICENSE原文](https://github.com/cachanova/synth-explorer/blob/d4dab3def346cb9fdac5bc171d801bd091df72e1/LICENSE) とバイト単位で一致し、SHA-256は `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` です。旧flasherのroot LICENSEも標準のApache-2.0本文だったため一致しますが、旧製品への帰属を示すファイルではありません。[第三者表記](../../THIRD_PARTY_NOTICES.md)に列挙したbuild script・adapter・patch・testのために保持します。本文末の `[yyyy]` と `[name of copyright owner]` はApache本文の適用例で、cachanova個人の法的な著作権所有を確定する記載ではありません。

## Cloudflare Pages: 記録と未確認の範囲

M1統合時点で旧toolchainの最終treeと本リポジトリーのworkflows、scripts、package設定、文書を調べた範囲では、Pagesへのdeploy job、Wrangler設定、Wrangler依存、Pages project名や `pages.dev` のURLはありませんでした。build workflowはWeb一式をActions artifactとして保存し、release workflowは配布zipとsource archiveを作成します。これらをCloudflareへのデプロイとは扱いません。

[配信調査](browser-build-and-delivery.md)は、Cloudflare Pagesを目標とし、実機確認後に公開すると記載しています。同文書には「デプロイは行っていません」とあります。これは文書上の状態です。Cloudflareの管理画面・APIやPagesのGit連携設定は確認していないため、手動uploadや外部のGit連携が存在しなかったとは断定できません。GitHub Pagesの設定とは別です。

現在は、mainの全build成功runの検証済み成果物からpages宛ての承認PRを作り、人間の実機確認とマージ後にGit連携で本番へ配信する方式を採ります。Pages側では再ビルドせず、build commandは空欄、output directoryは`public_html`です。[Pages公開手順](pages-delivery.md)に初期化、preview、Actionsとrulesetの管理者設定をまとめました。

公開先では`public_html/_headers`のCOOP/COEPとSurferの経路、WASMのMIME、HTTPS、1ファイル25 MiB未満・ファイル数の制限を確認します。圧縮済み資材はブラウザー内で展開するため、そのbytesが変わらず届くことも必要です。この変更ではdeployやCloudflare設定の変更を行っていません。
