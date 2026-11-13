# エディターと AI 機能の調査（2026-10-26）

T1 で使うエディターと、将来の AI 機能（チャットによる Vibe Coding、教師役、採点、コード補完）の接続方式を調べた結果です。npm の版、ライセンス、大きさは、npm registry と各パッケージの tarball で確かめました。大きさは esbuild 0.28.2 で「エディター + Verilog と VHDL の色分け + 診断の表示」の最小構成を `--bundle --minify` した値です（gzip は `gzip -9`）。AI の接続方式は、各社の公開文書で確かめました。実際に API を呼んだ試験は、本リポジトリでは試していません。

## 1. エディターの候補

| 候補 | 版 | ライセンス | 最小構成の大きさ（gzip） | 状況 |
|---|---|---|---|---|
| CodeMirror 6 | `codemirror` 6.0.2、`@codemirror/view` 6.43.15 | MIT | 408 KB（133 KB） | 部品を ES Modules で組み合わせる。2026-10 も更新が続いている |
| Monaco Editor | `monaco-editor` 0.57.0 | MIT | 本体 2.73 MB + CSS 91 KB + Worker 307 KB（本体 704 KB + Worker 95 KB） | VS Code のエディター部分。展開すると 101.7 MB |
| Ace | `ace-code` 1.45.2 | BSD-3-Clause | 432 KB（123 KB） | 2026-10-21 に更新 |
| prism-code-editor | 5.4.0 | MIT | 測っていない | Prism の文法で色分けする軽量のエディター |
| CodeJar | 4.3.0 | MIT | 測っていない（展開 26 KB） | 色分けは自分でつなぐ。行番号、診断、差分はない |
| Yace など textarea 重ね型 | — | — | — | 大きな文書、複数カーソル、装飾は対象外と明記されている |
| `@codingame/monaco-vscode-api` | 38.0.4 | MIT | 測っていない（展開 53 MB） | Monaco の上で VS Code の拡張や各種サービスを動かす |
| Eclipse Theia、OpenVSCode Server | — | — | — | IDE 全体。サーバーを前提とする構成が多く、npm での確認はしていない |

textarea 重ね型、CodeJar、prism-code-editor は、診断の表示、差分の採否、LSP の部品が足りないため、本命の候補から外します。`monaco-vscode-api` と Theia は、T1 には重すぎます。VS Code の拡張を使いたくなった将来に見直します。

## 2. HDL への対応

| | Verilog | VHDL | 根拠 |
|---|---|---|---|
| CodeMirror 6 | あり（IEEE 1800-2012 のキーワード。`always_ff`、`logic` も色分け） | あり。`force`、`release`、`protected` がキーワードにない | `@codemirror/legacy-modes` 6.5.5 の `mode/verilog.js`、`mode/vhdl.js` |
| Monaco Editor | あり（`verilog` と `systemverilog` の 2 つの ID が同じ定義を使う） | なし。Monarch の定義を自分で書く | 0.57.0 の `esm/vs/languages/definitions/` に vhdl がない |
| Ace | あり（`always_ff`、`logic` はキーワードにない） | あり。`force`、`release`、`protected` も含む | 1.45.2 の `src/mode/verilog.js`、`vhdl.js` |
| prism-code-editor | あり | あり | 5.4.0 の `public_html/languages/verilog.js`、`vhdl.js` |

どれも、構文木ではなく字句の規則による色分けです。足りないキーワードは、自分のコードで規則を足せば補えます。構文の理解（補完の候補、定義への移動、エラーの即時表示）は、エディターではなく LSP（VHDL は rust_hdl の vhdl_ls、Verilog は Verible など。[oss-survey.md](oss-survey.md) を参照）か、合成・シミュレーションのツールの診断に任せます。

## 3. 機能の比較

| 機能 | CodeMirror 6 | Monaco Editor | Ace |
|---|---|---|---|
| コード補完（一覧） | 公式 `@codemirror/autocomplete` | 標準 `registerCompletionItemProvider` | 標準 `ext/language_tools` |
| インライン補完（薄い文字の候補） | 公式にはない。`@marimo-team/codemirror-ai` 0.3.10（Apache-2.0、2026-10-22 更新）に次の編集の予測。`codemirror-copilot` 0.0.7 は 2024-01 から更新がない | 標準 `registerInlineCompletionsProvider`（VS Code と同じ仕組み）。`monacopilot` 1.2.12（MIT） | 標準 `ext/inline_autocomplete` |
| AI の提案の差分と、部分ごとの採否 | 公式 `@codemirror/merge` 6.12.3（MIT）の `unifiedMergeView`、`acceptChunk`、`rejectChunk` | 標準 `createDiffEditor`。`InlineEdit` の型もある | 標準 `ext/diff`（並べた表示、行内の表示） |
| 選択範囲への編集指示 | marimo 版に Cmd+K の入力欄と採否 | 自分で作る（content widget などで） | 標準 `ext/prompt`、`ext/command_bar` を土台にできる |
| 診断の表示 | 公式 `@codemirror/lint` | 標準 `setModelMarkers` | 標準 `setAnnotations` |
| 教師役の解説の表示（行内の吹き出し、行の間の説明） | 装飾と widget で自由に作れる | hover、CodeLens、content widget、view zone | line widget、tooltip |
| LSP の部品 | `codemirror-languageserver` 1.23.0（2026-10-25 更新） | `monaco-languageclient` 11.0.3（2026-10-15 更新） | `ace-linters` 2.2.1（2026-07-17 更新） |
| スマートフォン・タブレット | 対応（タッチで使える） | 公式に「モバイルのブラウザーは対象外」 | 調べていない |
| VHDL の色分け | あり（一部キーワードを補う） | 自分で書く | あり |

Monaco の「モバイルのブラウザーは対象外」は、公式サイトの文言（`microsoft/monaco-editor` の `website/src/website/pages/home/Home.tsx`）と、未解決の Issue microsoft/monaco-editor#1504 で確かめました。書き込みに必要な WebUSB はデスクトップの Chromium だけですが、学習用の閲覧や採点結果の確認はスマートフォンでも使える余地を残せます。

## 4. AI 機能の設計の前提

想定する AI 機能は次の 4 つです。

1. チャットで会話しながら設計を進める（Vibe Coding）。AI は複数のファイルへの変更を提案し、ユーザーが差分を見て採否を決める。
2. 教師役。エラーや設計の誤りを、答えを直接書かずに段階的なヒントで教える。行内に説明を表示する。
3. 採点。課題に対する提出物を評価する。
4. コード補完。一覧の補完と、薄い文字のインライン補完。

エディターに求めるのは、提案の見せ方（差分、行内の説明、薄い文字）と採否の操作です。AI の呼び出し先、送るデータ、プロンプトは、エディターに依存しない層で持ちます。どのエディターを選んでも、この層は同じに作れます。

採点は、LLM の判断だけに頼りません。課題ごとのテストベンチによるシミュレーション（NVC、Icarus Verilog）、lint、合成の結果（使用資源、タイミング）、形式検証を先に機械的に判定し、LLM はその結果の説明と、コードの読みやすさなど機械で測れない観点の講評に使います。同じ提出物を同じ設定で採点したときのばらつきは、実装時に測ります。

## 5. AI の接続方式

### A1: OpenRouter 接続の実装

AI タブに、同じタブで移動する OAuth PKCE（S256）の接続・解除と保存設定を実装しました。
A1 は接続と保存設定だけを扱います。相談と資料の送信は次の A2 で加えました。
接続先は自サイトと `https://openrouter.ai` に限り、CSP の `connect-src` でも制限します。
`frame-ancestors 'self'` は自サイト内の Surfer の埋め込みを許可し、外部サイトからの埋め込みを拒否します。
Pages とローカル配信の CSP は同じで、経路による区別はありません。
鍵の交換は OpenRouter の `/api/v1/auth/keys` だけに送信し、転送先へのリダイレクトは拒否します。
この CSP では Blob URL への `fetch` も遮断されるため、Surfer の波形は上流の `LoadFromData` にバイト列を渡して読み込みます。
Blob URL は波形のダウンロードだけに使います。

- 接続の前に、編集中のプロジェクトの保存を待ちます。保存に失敗したら移動しません。
- 戻り先は現在の origin と pathname から作り、クエリーとフラグメントを含めません。
- verifier と state は sessionStorage に置き、戻った時点で取り出して削除します。
  state の一致と発行から10分未満であることを確かめます。失敗や拒否の場合も削除します。
- URL の code と state は、鍵を交換する前に履歴から除きます。
- 鍵は既定でメモリーだけに保持します。再読み込みやタブを閉じると接続は解除されます。
  「このブラウザーに保存する」を選んだ場合だけ IndexedDB の `gogo-fpga-ai` に保存し、次回復元します。
  未選択の状態で資格情報用のデータベースは作りません。localStorage には保存しません。
- 保存を外すと IndexedDB の鍵を削除し、解除時はメモリーの鍵も消します。
  OpenRouter 側の鍵の失効は行いません。共有端末では保存せず、利用者が OpenRouter で上限額を設定してください。
- 鍵・認可コード・verifier をログやエラー文に含めません。鍵を URL に入れません。

実装は `web/lib/openrouter-auth.mjs` と `web/lib/openrouter-ui.mjs`、
検査は `tests/web/openrouter-auth.test.mjs` と `tests/e2e/openrouter-auth.spec.mjs` にあります。
RFC 7636 Appendix B のベクトル、拒否・期限切れ・応答不正、保存の選択と削除、外部通信の遮断を検査します。
S256の正しい組はverifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` とchallenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` です。当初の指定値との差をWeb CryptoとOpenSSLで独立に確かめ、検査の期待値を[RFC 7636 Appendix B](https://www.rfc-editor.org/rfc/rfc7636#appendix-B)に合わせて訂正しました。
Cloudflare Pagesでは複数の経路規則に一致したCSPも同時に効くため、Surferだけの例外ではなく、全経路を `frame-ancestors 'self'` にそろえました。`connect-src 'self' https://openrouter.ai` は変えていません。
OpenRouter の実際のアカウントでのログインは、本リポジトリでは試していません。

### A2: 相談・エラー説明・変更提案

AI タブでモデル、相談文、送るファイル・直前のツール別ログ・問題を選べます。ファイルは最初に開いているものだけを既定で選び、ライブラリーとバイナリーは候補に出しません。「エラーを AI に説明してもらう」は相談文を入力し、問題と関連ファイル・ログを選ぶだけです。自動送信はしません。教師役とインライン補完は未実装です。

「送信内容を確認」で、システムへの指示と過去の会話を含む実際の JSON 本文、UTF-8 のバイト数、宛先、付加ヘッダーを表示します。「送信する」だけが `https://openrouter.ai/api/v1/chat/completions` に送信し、確認した文字列を再生成せずそのまま本文に使います。入力や資料が変わると確認を取り消します。鍵は Authorization だけに付け、表示やエラー文には含めません。日本語の `X-OpenRouter-Title` は Fetch の ByteString 制限に合わせて UTF-8 のバイト列に変換し、`HTTP-Referer` は現在の origin にします。

応答は SSE で逐次表示し、「停止」で中断できます。正常な `[DONE]` まで受信した最終応答だけから `gogo-fpga-changes` の JSON を解析します。中断・通信失敗・不正な JSON からは適用対象を作りません。会話とモデル名はメモリーだけに置き、再読み込み・接続解除・「会話を消す」で会話を消します。CSP と A1 の鍵の保存方法は変えていません。

変更は最大8ファイル、各128 KiB、全体512 KiBの全文置換です。プロジェクトのパス規則に合わない指定、親への移動、絶対パス、制御文字、重複、ファイルとディレクトリーの衝突、ライブラリー、バイナリー、`.cst` を拒否し、理由を表示します。`.cst` はボードのピン設定から生成します。新規ファイルは既存のプロジェクト検査を通る HDL に限り、`src/` または `tests/` の下に作ります。SystemVerilog の対応範囲は広げません。

各ファイルの unified diff を確認し、「この変更を適用」で適用対象に選びます。「却下」ではファイルを変更しません。「選んだ変更をまとめて適用」が選択を確定し、既存の `store.save` を1回呼び、設計の変更を1回通知します。成果物は古い状態になります。合成・検証・書き込み・保存中は適用できず、送信時の SHA-256 と現在の内容が違う場合も拒否します。別のプロジェクトへの適用も拒否します。「元に戻す」は直前の AI 適用だけを1回の保存で戻し、新規ファイルは削除します。適用後にそのファイルを編集した場合は上書きせずに拒否します。

送信本文は最大2 MiBです。応答や差分の計算量にも上限を設け、差分を計算できない提案は適用できません。`openrouter-chat.mjs`、`ai-proposals.mjs`、`ai-chat-ui.mjs` と対応する単体・画面テストが実装と根拠です。[UX契約](../ux/README.md)の `ai_chat` を固定イメージで生成し、状態・event・guard の照合テストを加えました。実際の OpenRouter のアカウントでのログイン、課金、モデルからの応答と、実機の Tang Nano は、本リポジトリでは試していません。画面テストは OpenRouter の応答を模擬します。

#### OpenRouterの逐次受信と提案形式

初期モデルは `openrouter/auto` で、利用者が変更できます。[Chat Completionsのstreaming](https://openrouter.ai/docs/api-reference/streaming)を使い、`choices[0].delta.content` を連結します。keep-aliveの `:` コメントと内容を持たない行は表示せず、CRLF、通信chunkの途中で分かれた行やUTF-8文字を保持して処理します。HTTP失敗、providerのerror、正常な `[DONE]` のない終了、中断は正常完了と区別します。[アプリ帰属のヘッダー](https://openrouter.ai/docs/app-attribution)は本文の確認時にも表示し、HTTP-Refererを現在のorigin、X-OpenRouter-Titleを製品名にします。これらは利用者の鍵を第三者へ転送する設定ではありません。

提案はunified diffの適用ではなく、次の名前付きコードフェンス内のJSONによる全文置換です。差分はこの全文と送信時の内容から表示用に生成します。

```gogo-fpga-changes
{"changes":[{"path":"src/top.v","content":"module top; endmodule\n","reason":"変更の理由"}]}
```

上記の上限・パス検査を全提案に適用し、採用したファイルだけを一括保存します。追加行・削除行・hunkに背景色を付けても `+` と `-` は残し、長い行は折り返さず横にスクロールします。OpenRouterの接続操作を相談より先に置き、未接続なら「接続すると使えます」と表示します。狭い画面の適用ボタンは、下部barのborder-boxの高さに合わせたsheetの余白で隠れないようにします。受信と失敗の検査は `tests/web/openrouter-chat.test.mjs`、画面と適用の検査は `tests/e2e/ai-chat.spec.mjs` にあります。教師モードと行内補完はA2に含めません。

#### 差分の依存と採否

既存の依存に差分計算の部品はなく、npm `diff`（jsdiff）9.0.0を exact pin と lock の integrity で追加しました。既存の npm 全体の Dependabot 設定で監視します。esbuild で静的に同梱し、実行時に外部 CDN へ取りに行きません。BSD-3-Clause の著作権表示と原文は、配信ツリーと Web ZIP の `licenses/jsdiff-LICENSE` に含めます。[ライセンス一覧](../../THIRD_PARTY_NOTICES.md)にも記録しました。

[9.0.0 の変更履歴](https://github.com/kpdecker/jsdiff/blob/v9.0.0/release-notes.md)をすべて確認しました。初採用のため旧版からの更新ではありません。

- 破壊的変更: ES5 の終了とヘッダー・型の変更があります。Chromium の ESM で `createTwoFilesPatch` だけを使うため旧版への互換対応は不要です。
- 安全性: 先行版8.0.3で patch 解析の無限ループと ReDOS を修正済みです。今回は外部の unified diff を解析・適用せず、検証した全文から表示だけを生成します。
- 機能: 9.0.0のファイル名のエスケープ修正を含む unified diff 生成を採用します。Git 拡張ヘッダーの解析は使いません。
- ライセンス: BSD-3-Clause です。WASM や既存の固定版は変更せず、回帰は Web 単体・全 Playwright で確認します。実機の速度や動作の比較ではありません。

### 接続方式の調査

本プロジェクトはサーバーを持たず、ブラウザーから直接呼びます。そのため、利用者の鍵や権限で、利用者自身の負担で呼ぶ方式（Bring Your Own Key）が前提です。

| 方式 | 鍵の受け取り方 | ブラウザーから直接呼べるか | コード補完（FIM）への向き | 注意点 |
|---|---|---|---|---|
| OpenRouter OAuth PKCE | `https://openrouter.ai/auth` へ移動し、戻りの `code` を `POST /api/v1/auth/keys` で利用者の API キーに替える。`code_challenge_method=S256` と `state` が使える | 使える（第三者の検査で `Access-Control-Allow-Origin: *`、2026-07-30） | `/api/v1/chat/completions` は `prompt` も受け付けるが、`suffix` の指定は文書にない（未確認） | 1 つの鍵で多数のモデルを選べる。利用者は鍵ごとに上限額を設定できる。鍵はブラウザーに残るので保存方法を決める |
| 各社の API キーを直接入力（OpenAI、Anthropic、Google Gemini、Mistral など） | 利用者が鍵を貼り付ける | OpenAI、Gemini は使える（第三者の検査、2026-07-30）。Anthropic は `anthropic-dangerous-direct-browser-access: true` の指定が必要 | Mistral の `/v1/fim/completions` は `prompt` と `suffix` を受け付ける（ブラウザーから呼べるかは未確認） | Google は、本番の Web アプリで API キーをクライアントに置かないよう求めている |
| Hugging Face OAuth（PKCE、`inference-api` スコープ） | 秘密鍵のない公開アプリとして PKCE で access token を得る | 未確認 | Inference Providers の各モデルによる | 利用者の Hugging Face の契約で課金される |
| Chrome 内蔵 AI（Prompt API、Gemini Nano） | 不要 | Chrome 148 から Web で使える | 小さいモデルなので短い補完向き。性能は未確認 | 22 GB 以上の空き、4 GB 超の VRAM または 16 GB 以上の RAM が必要。Chrome 149 から日本語の入出力に対応 |
| WebLLM（MLC、WebGPU） | 不要 | 端末内で動く。OpenAI 互換の API。`completions.create()` も持つ | 端末の GPU と、最初のモデルの取得量による | モデルの取得に時間と容量がかかる |
| Transformers.js v3（ONNX Runtime Web） | 不要 | 端末内で動く。WebGPU か WASM | 小さいモデル向け | 同上 |
| Ollama（利用者の PC で動かす） | 不要 | `OLLAMA_ORIGINS` に本アプリの配信元を加えれば呼べる | FIM に対応したモデルを使える | 利用者が Ollama を入れて設定する |
| Puter.js | Puter のアカウントでログイン | 使える（同社の文書） | 未確認 | Puter のアカウントと利用枠に依存する |

COOP/COEP との関係：本アプリは WebUSB と pthread のため COOP `same-origin` と COEP を付けて配信します。この設定では別のウィンドウとの `window.opener` が切れるため、OAuth はポップアップではなく、同じタブでの移動と戻りで行います。外部の API への `fetch` は CORS で許可されていれば COEP の下でも使えます。

鍵の扱いは上の A1、ファイルやログの選択と送信は A2 のとおりです。下の比較は将来の候補も含む調査で、接続先の追加ではありません。

## 6. エディターと接続方式の相性

- コード補完の種類で決まる部分：インライン補完は FIM の API（Mistral、Ollama、端末内のモデル）か、チャットの API に前後の文脈を渡す方式で作ります。チャットの API でも作れますが、遅延と費用が増えます。OpenRouter で FIM を使えるかは、本リポジトリでは試していません。教師役・採点・インライン補完は将来計画で、現時点では調査結果の記録にとどめます。
- エディター側の差は、提案の見せ方の部品がどれだけ揃っているかです。Monaco は標準で最も揃っています。CodeMirror は公式の差分の部品と外部の部品で揃います。Ace は標準の拡張で揃います。どの接続方式とも組み合わせられ、接続方式によってエディターの選択が変わることはありません。
- 端末内のモデル（Chrome 内蔵 AI、WebLLM）は、ログインなしで教師役のヒントや短い補完を出す用途に向きます。採点や Vibe Coding のような長い文脈の作業は、OpenRouter などのクラウドのモデルに向きます。

## 7. 推奨

エディターは CodeMirror 6 を推奨します。

- VHDL と Verilog の両方を、すぐに色分けできます（Monaco は VHDL を自分で書きます）。
- 最小構成は Ace とほぼ同じで、Monaco の約 6 分の 1 です。スマートフォンでも動きます。
- AI の提案を 1 か所ずつ採否する画面を、公式の `@codemirror/merge` で作れます。教師役の行内の説明は、装飾と widget で作れます。
- インライン補完は公式にないので、marimo の部品を使うか、自分で作ります。

AI の接続方式は、OpenRouter OAuth PKCE を主にし、端末内のモデル（Chrome 内蔵 AI）と、各社の API キーの直接入力を選べるようにする構成を推奨します。採点は、テストベンチなどの機械的な判定を先に行い、LLM はその説明と講評に使います。

背反は次のとおりです。
- Monaco：AI の部品が標準で最も揃い、作る量は減ります。VHDL の定義を自分で書き、配布物が重くなり、スマートフォンは対象外です。
- Ace：VHDL のキーワードが最も揃い、ライセンスが本リポジトリと同じ BSD-3-Clause です。インライン補完と差分も標準の拡張にあります。拡張を作る人や部品は CodeMirror より少なく、LSP の部品の最終更新は 2026-07-17 です。

## 8. 参照した資料

- OpenRouter OAuth PKCE：https://openrouter.ai/docs/use-cases/oauth-pkce
- OpenRouter の認証と鍵の上限額：https://openrouter.ai/docs/api-reference/authentication
- 各社の CORS の検査結果（第三者、2026-07-30）：https://github.com/open-pencil/open-pencil/blob/master/packages/docs/programmable/byok-provider-compatibility.md
- Anthropic のブラウザーからの呼び出し：https://github.com/anthropics/anthropic-sdk-typescript/pull/504
- Gemini API キーの扱い：https://ai.google.dev/gemini-api/docs/api-key
- Mistral FIM：https://docs.mistral.ai/api/endpoint/fim
- Hugging Face OAuth：https://huggingface.co/docs/hub/oauth
- Chrome 内蔵 AI：https://developer.chrome.com/docs/ai/built-in-apis 、https://developer.chrome.com/docs/ai/get-started
- WebLLM：https://github.com/mlc-ai/web-llm
- Transformers.js：https://huggingface.co/docs/transformers.js/index
- Ollama の CORS：https://docs.ollama.com/faq
- Puter.js：https://developer.puter.com/ai/
- Monaco のモバイル対応：https://github.com/microsoft/monaco-editor/issues/1504
