# yomiyasuの更新と監視

## 固定値と根拠

日本語文書用の開発依存を2.4.0から3.1.0へ更新します。取得元は[nanaism/yomiyasu](https://github.com/nanaism/yomiyasu)です。

| 項目 | 更新前 | 更新後 |
|---|---|---|
| スキルの版 | 2.4.0 | 3.1.0 |
| submoduleのcommit | `552c12c472ddfb79e2ee7a15219847782686a945` | `db78b9bc5e868549b517a037df7a4d1c93edac23` |
| ライセンス | MIT | MIT、原文の差分なし |

[全8コミットの比較](https://github.com/nanaism/yomiyasu/compare/552c12c472ddfb79e2ee7a15219847782686a945...db78b9bc5e868549b517a037df7a4d1c93edac23)と、[固定した変更履歴の全文](https://github.com/nanaism/yomiyasu/blob/db78b9bc5e868549b517a037df7a4d1c93edac23/CHANGELOG.md#L5-L445)を読みました。2.5.0、3.0.0、3.0.1、3.1.0の機能、移行上の注意、上流の測定と限界を確認しています。MITの表示はsubmoduleの[LICENSE](https://github.com/nanaism/yomiyasu/blob/db78b9bc5e868549b517a037df7a4d1c93edac23/LICENSE)に保持します。

| commit | 変更 |
|---|---|
| `41e5aec228f0` | Grok Build向けの導入方法をREADMEに追加 |
| `29d67ccb05e3` | 2.5.0。lintの誤検出修正、見出しと読点の差分、推敲手順と許可の設定 |
| `8394e099486a` | 類似名の外部サービスとの関係をREADMEで説明 |
| `7b212ff2f037` | 3.0.0。指示書の短縮、読取り制限、語の一覧と型注釈の変更 |
| `b6115c6a764d` | 上流のpytestを並列化 |
| `b9a69a3791dd` | 3.0.1。組み込み正規表現の遅延コンパイル |
| `2318a6d0820a` | 時間を測らない試験を3組に分割 |
| `db78b9bc5e86` | 3.1.0。スキル内のCodexプラグイン設定を削除し、BOMの表記を修正 |

## 変更の評価と採否

### 互換性

- 3.0.0でSKILL.mdの節とStepの構成が変わり、一部の旧規則も外れました。本リポジトリに旧Step番号を指定する呼出しはなく、リンク先の新しい指示書を使います。推敲の結果が以前と同じになることは保証しません。
- 2.5.0でdiffのJSONに `heading_shapes` と `comma_increase` が加わり、3.0.0でlintの候補が増えます。本リポジトリはCLIを使い、JSONのキーの完全一致や内部の正規表現オブジェクトには依存していません。指摘は文脈で確認し、機械的な置換は行いません。
- 3.0.0から作業フォルダの外や、パスの一部が点で始まる入力を終了コード2で拒否します。通常の `AGENTS.md` や `docs/` は従来のコマンドで検査でき、隠しフォルダ内の文書は標準入力で渡します。検査スクリプトの呼出し元が `.agents/skills/` であることは制限しません。
- 過去のcheck記録はツールの変更で `tool_changed` になるため、更新後に `run` をやり直します。記録の版、既存の状態の行、CLIの既定値は維持されます。
- 3.1.0でCodexの名前が変わるのはスキルのフォルダだけをコピーした導入方法です。本リポジトリは `.agents/skills/yomiyasu` からvendorへリンクし、その上位にある `.claude-plugin/plugin.json` を参照する構成です。[上流の導入方法の説明](https://github.com/nanaism/yomiyasu/blob/db78b9bc5e868549b517a037df7a4d1c93edac23/docs/usage.md)に従い、既存の `$yomiyasu:yomiyasu` を維持します。`.claude/skills/` のリンクも解決されます。

### 安全性

入力の読取り制限と、2.5.0の付属lint・checkだけに限る `allowed-tools` を採用します。ホスト側の許可を広げる個人設定や自動フックは追加しません。3.1.0のBOMのエスケープにより、不可視文字を取り除く外部ツールでスクリプトの条件式が変わる問題を避けます。上流はapmの実行を検証しておらず、本リポジトリでも導入対象にはしません。

### 新機能と速度

lintの誤検出修正、追加の見直し候補、見出しと読点の差分表示、Python標準ライブラリだけで動くCLIを採用します。3.0.1の正規表現の遅延コンパイルもそのまま使います。速度は上流の測定結果であり、このVMで改善量を測ったとは扱いません。

任意の `flag-patterns.txt`、flag.txtの置換語、linked worktreeでの語の一覧の継承は、専用辞書を運用していないため設定を追加しません。必要になれば正規表現の個数・重さや置換語の長さの上限を守って採用します。Pythonの代替コマンドは上流の手順に従いますが、この環境では `python3` が使えるため切替は不要です。上流CIの並列化・分割は上流試験を実行するときに利用し、アプリ側CIの構成は変えません。

### ライセンスと対象範囲

MITの原文と著作権表示に変更はありません。vendorのファイルは編集せず、gitlinkだけを更新し、`.gitmodules` の `shallow = true` を維持します。Web・WASMの生成処理はこのスキルを呼んでいないため、WASMの再ビルド、仮想USBの速度測定、画面の再試験は今回の更新対象から外します。実機Tang Nanoは本リポジトリでは試していません。

## 定期更新監視

[Dependabotの設定](../../.github/dependabot.yml)は `gitsubmodule` の `vendor/yomiyasu` を週次対象にしています。設定値は `cooldown.default-days: 7`、同時PR上限5件です。既存の監視を維持します。この確認は設定の確認であり、Dependabotが次回のPRを作る日時を保証するものではありません。

一方、[固定版の更新確認](../../.github/workflows/pins-check.yml)と、その通知先の[Issue #21](https://github.com/uist1idrju3i/gogo-fpga/issues/21)はyomiyasuを対象にしていません。yomiyasuはDependabotで監視する運用です。

## 検証

更新前後の同じ文書を同じ既定値でlintに渡し、終了コード、指摘の内容、件数を比較しました。

| 文書 | 2.4.0のerror / warn / info | 3.1.0のerror / warn / info | 結果 |
|---|---|---|---|
| 更新前のAGENTS.md | 0 / 2 / 1 | 0 / 2 / 1 | 終了コード0、指摘の内容も一致 |
| dependency-version-detection.md | 0 / 2 / 3 | 0 / 2 / 3 | 終了コード0、指摘の内容も一致 |

これは既存2文書の検査結果です。すべての文章で判定や推敲結果が同じになることの証明ではありません。CodexとClaude Codeの実ホストからの呼出し、Windows、Python 3.9と3.14はこの更新では未確認です。

上流の試験はUbuntu、Python 3.12.16、pytest 8.4.2、pytest-xdist 3.8.0で実行しました。時間を測らない試験は4並列で2,520件が成功し、9件はOSやファイルシステムの条件でskipされました。時間のしきい値を含む試験は別に直列で実行し、72件が成功しました。合計は2,592件成功、9件skipです。skipはWindowsのパス5件、macOSのF_GETPATH 3件、NFCとNFDを同一名として扱うファイルシステム1件です。

submodule内での再実行コマンドは次のとおりです。

```sh
uv run --no-project --with pytest==8.4.2 --with pytest-xdist==3.8.0 python -m pytest -q -ra -n 4 --dist worksteal -m 'not timing'
uv run --no-project --with pytest==8.4.2 --with pytest-xdist==3.8.0 python -m pytest -q -ra --durations=10 -m timing
```

本リポジトリのpin整合性とpin checkerの回帰、文字・リンク・サイズ・個人環境のパスの検査、変更文書のlintとcheck・verifyはいずれも成功しました。初回のpin整合性検査はcommit前のgitlinkを参照して不一致になったため、gitlinkの更新をcommitして再検査しました。初回のリンク検査はsubmodule内のLICENSEを未追跡として拒否したため、上流の固定commitのURLへ直しています。
