# Chrome 内蔵 AI による端末内補完

[エディターと AI の比較・接続方式](editor-and-ai.md)から分けた、補完の利用者と保守担当者向けの実装記録です。

## 採用した API と有効化

補完には [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api) の `LanguageModel` だけを採用しました。Ollama、WebLLM、OpenRouter などへの切り替えはしません。AI タブの「補完（この端末の Chrome 内蔵 AI）」は既定で無効です。`availability()` の unavailable / downloadable / downloading / available を日本語で案内し、API がない場合も無効にします。Android では使えません。有効にするクリックで `create()` を呼び、`monitor` の `downloadprogress` を表示します。モデルの取得は Chrome の機能です。設定や補完用のコードをアプリから外へ送ることはありません。

## 文脈とセッション

`web/lib/local-completion.mjs` が上限とセッションを管理します。入力が止まって600 ms後、または Alt+\\ で、現在のパス・言語とカーソル前2 KiB・後1 KiBだけを渡します。UTF-8 の境界を保ち、他のファイルやログは含めません。空の基セッションから要求ごとに `clone()` し、完了時に `destroy()` するため、過去のファイルを文脈に残しません。利用できる容量は `contextUsage` と `inputQuota`（現行 API では `contextWindow`）で確認し、容量超過や生成失敗では候補を出さずに知らせます。編集・カーソル移動・ファイル切り替えは `AbortController` で中止し、一度に一件だけ扱います。

## 候補の表示と検査

CodeMirror の widget に候補を `textContent` で表示します。制御文字を除き、400文字・8行に制限し、後続の本文を繰り返すだけの候補は捨てます。Tab は表示中の候補だけを通常の編集として挿入し、取り消せます。Esc は候補を閉じ、候補がない Tab の動作は変えません。単体検査は文脈の上限・制御文字・中止・対応状況・通信 API の不在を、画面検査は模擬 `LanguageModel` と通信先の監視で確かめます。実モデルの品質や対応端末での動作は本リポジトリーでは試していません。

## 配信の前提

公式資料ではトップレベルと同じオリジンの iframe で既定の利用を許しています。このアプリはトップレベルで呼ぶので Permissions-Policy の追加は不要です。CSP、`web/_headers`、`web/serve.py` は変更しません。API がない環境で、別のサービスを自動利用することもありません。
