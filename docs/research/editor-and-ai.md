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
| prism-code-editor | あり | あり | 5.4.0 の `dist/languages/verilog.js`、`vhdl.js` |

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

鍵の扱い：鍵は `localStorage` ではなく IndexedDB などに保存し、保存するかどうかを利用者が選べるようにします。画面上で鍵の上限額の設定を促します。送るデータ（ファイル、ログ）は、送る前に利用者に見せます。

## 6. エディターと接続方式の相性

- コード補完の種類で決まる部分：インライン補完は FIM の API（Mistral、Ollama、端末内のモデル）か、チャットの API に前後の文脈を渡す方式で作ります。チャットの API でも作れますが、遅延と費用が増えます。OpenRouter で FIM を使えるかは、本リポジトリでは試していません。AI 機能は将来計画で、現時点では調査結果の記録にとどめます。
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
