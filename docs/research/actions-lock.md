# Actions.lock の調査結果と導入の採否

確認日: 2026-11-01。調査対象の main: `61636eefac53b83808adad3e2344d7497cecaf68`。

## 1. 今回の判断

**今回は Actions.lock の導入を見送り、現行の完全長 SHA 固定を維持する。** 利用者が見送りを選択した。workflow、pin checker、zizmor、Dependabot、リポジトリ設定は変更しない。

調査では、SHA 固定と lockfile を併用する案に追加価値があると評価した。ただし、これは採用決定ではない。今回の見送りは Actions.lock が無効、または危険だと判断したという意味でもない。以下に、確認した追加価値、制限、未確認の事項と再検討条件を残す。

CLI のインストール、lockfile の生成、GitHub runner での lockfile 使用、Dependabot による lockfile 更新、負の対照は、本リポジトリでは試していない。

## 2. 記事と公式仕様

調査の起点は [GitHub Actions のバージョン固定を説明した記事](https://zenn.dev/progate/articles/24b1140180300c)である。可変タグの危険、完全長 SHA 固定、推移依存の固定という説明を、GitHub の公式資料と CLI の実装で照合した。

| 項目 | 確認した仕様 |
|---|---|
| 提供状況 | 2026-10-28に一般提供。GitHub Free、Team、Enterprise Cloud などで利用できる |
| 配置 | `.github/workflows/actions.lock`。GitHub runner が解釈する依存 lockfile |
| 固定対象 | 直接 Action と、composite Action が呼ぶ Action などの推移依存 |
| 取得元の確認 | commit に加えて `owner_id`、`repo_id` を記録し、同名の別リポジトリへの置換を検査する |
| 更新単位 | `workflows` に workflow ごとの依存、`dependencies` に ref、commit、取得元 ID を記録する |
| CLI | `github/gh-actions-lock`。調査時の最新公開版は v0.4.0、MIT、2026-10-23公開 |
| 形式の安定性 | サービスの一般提供と CLI の0.x系は別。README は形式・引数・動作の変更可能性を注意事項としている |

調べた CLI の commit は `759f9c2d44e8599fa5b29224e5a30c58b3555211`。README の lockfile 例は `version: 'v0.0.3'` である。GitHub Enterprise Server は、この CLI の対応対象外である。

記事にある「workflow だけを変えると Invalid lockfile」は、登録済み workflow の依存を変更した場合の説明として読む。lockfile が一つあるだけで、未登録の新規 workflow まで強制されるわけではない。

根拠: [一般提供の告知](https://github.blog/changelog/2026-10-28-github-actions-workflow-lockfiles-are-generally-available/)、[公式の概念説明](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)、[導入手順](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies)、[CLI v0.4.0](https://github.com/github/gh-actions-lock/releases/tag/v0.4.0)、[調査した README](https://github.com/github/gh-actions-lock/blob/759f9c2d44e8599fa5b29224e5a30c58b3555211/README.md)。

## 3. 現行 CI の棚卸し

リポジトリ内の workflow は5ファイル、`uses:` は合計92か所。重複を除くと6参照、取得元は5リポジトリである。GitHub が別途生成する CodeQL の workflow は、この集計に含めていない。

| Workflow | `uses:` の出現数 |
|---|---:|
| agent-docs.yml | 1 |
| lint.yml | 2 |
| build.yml | 78 |
| pins-check.yml | 1 |
| release.yml | 10 |
| 合計 | 92 |

| 参照 | 固定 commit | 出現数 |
|---|---|---:|
| actions/checkout | `3d3c42e5aac5ba805825da76410c181273ba90b1` | 20 |
| actions/setup-node | `949feb2413d6458794dcd2491c4babbbce0c15c1` | 13 |
| actions/cache/restore | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | 10 |
| actions/cache/save | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | 10 |
| actions/download-artifact | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | 24 |
| actions/upload-artifact | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | 15 |

92か所すべて40桁 SHA 固定である。指定 commit の6つの `action.yml` を取得して調べると、すべて `runs.using: node24` で、内部の `uses:` はなかった。したがって、現在の Action グラフには追加で固定する composite Action の推移依存を見つけていない。

この確認は JS の同梱ライブラリーや実行時ダウンロードの安全性を証明するものではない。

既存の保護には、次のものがある。

- [pin checker](../../.github/scripts/check-pins.py): workflow の完全長 SHA、バージョンコメント、workflow 間の固定値の一致と runner label を確認する。
- [Dependabot](../../.github/dependabot.yml): GitHub Actions を週次、cooldown 7日で更新対象にする。
- [lint workflow](../../.github/workflows/lint.yml): actionlint と、ハッシュ付きで固定した [zizmor 1.31.1](../../.github/zizmor-requirements.txt)による監査を行う。
- workflow は読み取りを基本とした権限を使い、checkout には `persist-credentials: false` を指定している。

棚卸しの根拠: [調査対象の workflows](https://github.com/gogo-fpga/toolchain/tree/61636eefac53b83808adad3e2344d7497cecaf68/.github/workflows)、各 Action の定義（[checkout](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml)、[setup-node](https://github.com/actions/setup-node/blob/949feb2413d6458794dcd2491c4babbbce0c15c1/action.yml)、[cache/restore](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/restore/action.yml)、[cache/save](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/save/action.yml)、[download-artifact](https://github.com/actions/download-artifact/blob/9000827ccba6bdab643e8b6fd33ac0654aef8333/action.yml)、[upload-artifact](https://github.com/actions/upload-artifact/blob/cf430e030ddbb5b0abf93d22962f4752f3646cd9/action.yml)）。

## 4. 追加で得られる保護と対象外

| 対象 | 現行 SHA 固定との差分 |
|---|---|
| 直接 Action のタグ移動 | 現行でも完全長 SHA により対策済み。追加の利点は限定的 |
| 親が呼ぶ推移 Action | 親の SHA だけでは、内部の可変タグまでは固定できない。lockfile の追加価値がある |
| 同名の別リポジトリへの置換 | `owner_id` と `repo_id` の確認が加わる |
| Action 自体の安全性 | 保証しない。由来と commit の確認は、ソースの安全性審査の代わりではない |
| 外部の再利用 workflow | `jobs.<id>.uses` の呼び出しは対象外。呼び出し側の SHA 固定と、定義側リポジトリでの依存管理が必要 |
| container image、runner image | lockfile による固定の対象外。digest や runner の別管理が必要 |
| `run:` で取得するツール、npm、pip、コンパイラー | 対象外。別の固定・ハッシュ検証が必要 |
| input、secrets、実行権限 | 固定・審査しない。既存の権限制限とレビューが必要 |

CLI にも、ローカル Action、外部の再利用 workflow、container 参照などに制限がある。導入するとしても、workflow の全入力が固定されたとは表現できない。製品の静的ファイル配信や、T6後に扱うオフライン機能とは別の主題である。

根拠: [公式の保護範囲](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)、[CLI の制限](https://github.com/github/gh-actions-lock/tree/759f9c2d44e8599fa5b29224e5a30c58b3555211#limitations)、[再利用 workflow の issue](https://github.com/github/gh-actions-lock/issues/179)。

## 5. 既存検査との関係と運用負担

### SHA 固定を残す案には互換性上の利点がある

現行 pin checker は完全長 SHA とバージョンコメントを要求する。zizmor 1.31.1 の既定方針も `HashPin` であり、Action 参照自体が SHA かを判定する。lockfile を置くだけでタグ表記がこれらの検査を通るようになるわけではない。

CLI v0.4.0 には、既存 SHA を維持する `--no-narrow` がある。ソースと `no-narrow preserves bare SHA through ReverseLookup` というテストを読み、workflow の書き換えが空になることを検査していると確認した。今回、そのテストや生成処理を実行したわけではない。

根拠: [CLI の実装](https://github.com/github/gh-actions-lock/blob/759f9c2d44e8599fa5b29224e5a30c58b3555211/internal/pin/plan.go#L445-L482)、[SHA 維持のテスト](https://github.com/github/gh-actions-lock/blob/759f9c2d44e8599fa5b29224e5a30c58b3555211/internal/pin/plan_test.go#L1015-L1039)、[zizmor の判定](https://github.com/zizmorcore/zizmor/blob/v1.31.1/crates/zizmor/src/audit/unpinned_uses.rs)、[既定方針](https://github.com/zizmorcore/zizmor/blob/v1.31.1/crates/zizmor/src/config/mod.rs#L408-L414)。

### 導入後に増える管理

workflow の依存変更と lockfile 更新を同じ PR で扱い、commit、取得元 ID、workflow との対応をレビューする必要がある。GitHub 公式資料によれば、Dependabot は導入済み workflow の更新時に lockfile も更新する。未導入 workflow の初回登録は行わない。SHA 併用時の実際の更新 PR は、今回は確認していない。

`--verify-local` はネットワーク・認証なしの静的な網羅性検査で、由来を確認しない。`--verify` は認証とネットワークを使い、由来や runner と同等の解決も検査する。前者だけで後者を代替できない。

CLI 自体の固定版、配布物のハッシュ・利用できる配布証明、更新監視も必要になる。ネットワーク障害や API の回数制限で検証が停止する可能性もある。時間、API 使用量、追加費用は測定していない。

`--relock` は可変 ref の再解決を伴う。`--accept-moved` による移動の受け入れや、エラー時の lockfile 削除・再生成で検証を通すことは、自動化の候補にしない。導入を再検討する際にも、失敗を成功扱いにしないことが条件となる。

根拠: [導入・Dependabot 更新の公式説明](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies)、[CLI の検証モード](https://github.com/github/gh-actions-lock/blob/759f9c2d44e8599fa5b29224e5a30c58b3555211/cmd/gh-actions-lock/verify.go)、[CLI の使い方](https://github.com/github/gh-actions-lock/blob/759f9c2d44e8599fa5b29224e5a30c58b3555211/README.md)。

## 6. 強制設定とレビューの境界

未登録 workflow も含めて lockfile を強制するには、Require lockfile ポリシーが別途必要になる。検証ジョブが失敗したことだけでは、それ以前に別のジョブが実行されていないとは保証できない。

Evaluate モードは Enterprise Cloud 限定であり、Free/Team でも同じ評価手順を使えるとは案内できない。強制した場合には、`uses:` がゼロの未登録 workflow、既存 PR、古い tag、過去 commit での手動実行、再利用 workflow の定義側への影響も確認する必要がある。allowed actions の制限は導入後には lockfile の commit SHA と照合される。現在の許可リスト設定は、本調査では確認していない。

workflow と lockfile の両方を変更できる人は悪意のある依存も提案できる。lockfile はレビューの代わりではない。CODEOWNERS やレビュー必須化は別の保護である。本リポジトリでは、エージェントによるルールセット・リポジトリ設定の変更を禁止しており、今回はいずれも変更しない。

根拠: [公式の強制手順](https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles)、[導入と許可リストの注意](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies)。

## 7. 選択肢と再検討条件

| 案 | 評価と今回の採否 |
|---|---|
| 現行の完全長 SHA 固定を継続 | **今回選択した案**。直接依存の既存の保護を維持する。取得元 ID と推移依存固定の追加は行わない |
| SHA 固定 + lockfile | 追加価値はあるが今回は見送り。既存検査を残せる一方、生成物・更新経路・検証ツールの管理が増える |
| 完全版タグ + lockfile | 今回は採らない。読みやすさの利点はあるが、pin checker、zizmor、更新手順も同時に見直す必要がある |

composite Action や外部依存の増加、取得元 ID の検査が必要になった場合、または CLI と更新運用の検証材料がそろった場合には、改めて採否を判断する。その際に必要な確認事項は次のとおりである。

- CLI の版・形式・ライセンス・配布物と監視方法を再確認し、既存 SHA と既存検査を維持できること。
- 直接・推移依存と取得元 ID の固定を、runner のログも含めて確認できること。
- fork PR と Dependabot の読み取り権限で検証でき、書き込み用 PAT や CI の権限拡大が不要なこと。
- lockfile の削除・破損・依存欠落、workflow だけの依存変更、新規 workflow、ID 不一致、commit/ref 不整合を安全な負の対照で検出できること。
- Dependabot と手動更新で workflow・lockfile が同じ PR で更新され、API 障害時も検査が失敗すること。

これらは未実施の確認事項であり、承認済みの実装計画ではない。今回は新しい lockfile、CLI、検証ジョブや強制設定を追加しない。
