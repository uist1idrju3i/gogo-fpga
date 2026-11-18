import { createChatPreview, selectableFiles, sendChatPreview } from "./openrouter-chat.mjs";
import { proposalDiff, proposalSnapshot } from "./ai-proposals.mjs";
import { AI_CHAT_INITIAL_STATE, transitionAiChat } from "./ai-chat-flow.mjs";
import { AI_SKILLS } from "./ai-skills.mjs";
import { formatUsage } from "./ai-usage.mjs";
import { compactUserTurn } from "./ai-history.mjs";
import { parseAiAnswer } from "./ai-structured.mjs";
import { parseAiReferences } from "./ai-references.mjs";
import { fetchModels, formatModelPrice, estimatePreviewTokens } from "./openrouter-models.mjs";
export { createProposalEditor } from "./ai-proposals.mjs";
export { selectableFiles } from "./openrouter-chat.mjs";

const ERRORS = {
  empty: "相談文とモデルを入力してください。",
  size: "送受信する内容が大きすぎます。資料や会話を減らしてください。",
  preview: "内容が変わりました。送信内容を確認し直してください。",
  unauthorized: "接続情報を確認できません。OpenRouter に接続し直してください。",
  credit: "OpenRouter の残高が不足しています。残高を確認してください。",
  rate: "送信回数の上限に達しました。しばらくしてから確認し直してください。",
  server: "OpenRouter でエラーが発生しました。しばらくしてから確認し直してください。",
  stopped: "受信を停止しました。途中の応答からは変更を提案しません。",
  incomplete: "応答が途中で終了しました。途中の内容は適用できません。",
  busy: "合成・検証・書き込み・保存の処理中は変更を適用できません。",
  changed: "送信後にファイルが変わりました。現在の内容で相談し直してください。",
  invalid: "安全に適用できない提案です。パスと内容を確認してください。",
};
const errorText = (error) => ERRORS[error?.code] ?? "処理を完了できません。通信と保存先を確認し、送信内容を確認し直してください。";

export function initializeAiChatUI({ panel, getKey, workspace, revisions, showPanel }) {
  const root = document.createElement("section");
  root.id = "ai-chat";
  root.innerHTML = `<h3>AI に相談する</h3>
    <p id="ai-chat-intro">送信先は openrouter.ai だけです。利用料は OpenRouter の残高から支払います。確認後に「送信する」を押すまで、相談や資料は送信しません。</p>
    <p id="ai-chat-status" role="status" aria-live="polite"></p>
    <p id="ai-chat-error" role="alert" hidden></p>
    <fieldset id="ai-compose"><legend>相談文と資料</legend>
      <label for="ai-model">モデル</label><input id="ai-model" type="text" value="openrouter/auto" maxlength="200" autocomplete="off" list="ai-model-options">
      <datalist id="ai-model-options"></datalist>
      <button id="ai-models-fetch" type="button" class="secondary">モデル一覧を取得</button>
      <details id="ai-context-picker"><summary>送る内容を選ぶ</summary>
        <fieldset><legend>プロジェクトのファイル</legend><div id="ai-context-files"></div></fieldset>
        <fieldset><legend>直前のビルドログ</legend><div id="ai-context-logs"></div></fieldset>
        <fieldset><legend>問題</legend><div id="ai-context-problems"></div></fieldset>
      </details><p id="ai-context-selection"></p>
      <label for="ai-skill">相談の種類</label><select id="ai-skill"></select>
      <div id="ai-hint-option" hidden><label for="ai-hint-level">ヒントの段階</label><select id="ai-hint-level">
        <option value="1">1: 見る場所・概念</option><option value="2">2: 具体的な方向</option><option value="3">3: 答えに近い説明（完全なコードなし）</option>
      </select></div>
      <label for="ai-prompt">相談文</label><textarea id="ai-prompt" rows="4" placeholder="エラーや設計について相談してください"></textarea>
      <label id="ai-resend-history-option" hidden><input id="ai-resend-history" type="checkbox">以前の資料も全文で送り直す</label>
      <button id="ai-preview-button" type="button">送信内容を確認</button>
    </fieldset>
    <p id="ai-models-status" role="status"></p>
    <p id="ai-model-details" hidden></p>
    <section id="ai-preview" hidden><h4>送信内容の確認</h4>
      <p id="ai-output-mode"></p>
      <p id="ai-token-estimate"></p><p id="ai-context-warning" role="status" hidden>推定トークン数がコンテキスト長を超えています。資料や会話を減らしてください。</p>
      <p id="ai-preview-target"></p><pre id="ai-preview-headers" tabindex="0"></pre>
      <p>Authorization には接続中の鍵を付けます（鍵は表示しません）。日本語のタイトルは UTF-8 のバイト列で送ります。</p>
      <label for="ai-preview-body">実際に送る JSON 本文（編集不可）</label>
      <textarea id="ai-preview-body" readonly rows="12" spellcheck="false"></textarea>
      <button id="ai-send" type="button">送信する</button>
      <button id="ai-preview-cancel" type="button" class="secondary">内容を編集する</button>
    </section>
    <button id="ai-stop" type="button" class="secondary" hidden>停止</button>
    <section id="ai-answer" hidden><h4>AI の応答</h4><pre id="ai-chat-response" role="log" aria-live="polite" tabindex="0"></pre><p id="ai-usage" role="status"></p></section>
    <button id="ai-dismiss-annotations" type="button" class="secondary" hidden>行のヒント表示を消す</button>
    <section id="ai-proposals" hidden><h4>変更提案の確認</h4>
      <p>各ファイルの差分を確認して採否を選び、まとめて適用で確定します。選んだ変更は1回で保存します。</p>
      <div id="ai-proposal-files"></div><p id="ai-apply-reason" role="status"></p>
      <button id="ai-apply-selected" type="button">選んだ変更をまとめて適用</button>
    </section>
    <div id="ai-rejected-paths" role="status" hidden></div>
    <button id="ai-undo" type="button" class="secondary" hidden>元に戻す</button>
    <section id="ai-local-verify" hidden><h4>適用した変更を手元で確かめる</h4>
      <p>検査はこの端末で実行します。AI には送信しません。</p>
      <button id="ai-verify-build" type="button">合成</button>
      <button id="ai-verify-simulation" type="button">シミュレーション</button>
      <button id="ai-verify-formal" type="button">形式検証</button>
    </section>
    <details id="ai-history"><summary>これまでの会話（このタブだけ）</summary><div id="ai-history-messages"></div></details>
    <button id="ai-clear" type="button" class="secondary">会話を消す</button>`;
  panel.append(root);
  const q = (id) => root.querySelector(`#${id}`);
  for (const { id, label } of AI_SKILLS) {
    const option = document.createElement("option");
    option.value = id; option.textContent = label; q("ai-skill").append(option);
  }
  const choices = { files: new Set(), logs: new Set(), problems: new Set() };
  let history = [], preview = null, proposals = [], snapshot = null, context;
  let state = AI_CHAT_INITIAL_STATE, controller = null, generation = 0, version = 0, applying = false;
  let accepted = new Set(), lastKey = getKey();
  let models = null, loadingModels = false;
  let verificationProject = null;
  let annotationContext = null;
  function dismissAnnotations() {
    annotationContext = null;
    q("ai-dismiss-annotations").hidden = true;
    q("ai-chat-response").textContent = q("ai-chat-response").textContent;
    document.dispatchEvent(new CustomEvent("toolchain:ai-annotations", { detail: { references: [] } }));
  }
  function renderAnswer(text, selected, files) {
    const response = q("ai-chat-response"); response.textContent = "";
    const references = selected.skill === "teach" ? parseAiReferences(text, files) : [];
    let from = 0;
    for (const reference of references) {
      const before = document.createElement("span"); before.textContent = text.slice(from, reference.from);
      const link = document.createElement("a"); link.href = "#editor-mount";
      link.textContent = text.slice(reference.from, reference.to); link.className = "ai-source-reference";
      link.addEventListener("click", event => {
        event.preventDefault();
        if (!annotationContext) return;
        document.dispatchEvent(new CustomEvent("toolchain:ai-reference", { detail: { ...reference, projectId: annotationContext.projectId } }));
      });
      response.append(before, link); from = reference.to;
    }
    const after = document.createElement("span"); after.textContent = text.slice(from); response.append(after);
    if (references.length) {
      annotationContext = { projectId: snapshot.projectId, files };
      q("ai-dismiss-annotations").hidden = false;
      document.dispatchEvent(new CustomEvent("toolchain:ai-annotations", { detail: { ...annotationContext, references } }));
    }
  }
  function send(event, guards) { state = transitionAiChat(state, event, guards); root.dataset.state = state; }
  function busy() { return Boolean(controller); }
  function controls() {
    const current = workspace.getContext();
    q("ai-hint-option").hidden = q("ai-skill").value !== "teach";
    q("ai-local-verify").hidden = verificationProject === null || verificationProject !== current?.projectId;
    for (const kind of ["build", "simulation", "formal"]) {
      const button = q(`ai-verify-${kind}`);
      button.hidden = kind !== "build" && !current?.project?.[kind]?.top?.trim();
      button.disabled = busy() || loadingModels || applying || workspace.isBusy() || current?.verificationReady?.[kind] === false;
    }
    document.dispatchEvent(new CustomEvent("toolchain:ai-request-busy", { detail: { busy: busy() || loadingModels || applying } }));
    q("ai-models-fetch").disabled = loadingModels;
    q("ai-compose").disabled = busy() || applying;
    q("ai-resend-history-option").hidden = history.length === 0;
    q("ai-compose").hidden = !getKey() || state === "previewing";
    q("ai-chat-intro").hidden = !getKey();
    q("ai-history").hidden = q("ai-clear").hidden = !getKey();
    q("ai-preview").hidden = state !== "previewing";
    q("ai-send").disabled = !getKey() || !preview || busy();
    q("ai-stop").hidden = !busy();
    q("ai-clear").disabled = applying;
    q("ai-undo").hidden = !revisions.canUndo;
    q("ai-undo").disabled = busy() || applying || workspace.isBusy();
    q("ai-apply-selected").disabled = !accepted.size || busy() || applying || workspace.isBusy();
    q("ai-apply-reason").textContent = workspace.isBusy() ? ERRORS.busy : "";
    for (const button of q("ai-proposal-files").querySelectorAll("button")) button.disabled = busy() || applying || workspace.isBusy();
    q("ai-chat-status").textContent = applying ? "変更を保存しています。" : ({ composing: getKey() ? "接続済み。相談文を入力できます。" : "接続すると使えます",
      previewing: "この本文と宛先を確認してから送信してください。", sending: "送信しています。", streaming: "応答を受信しています。", proposal_review: "応答を受信しました。変更は自動で適用されません。", failed: "送信または受信を完了できませんでした。" })[state];
  }
  function invalidate() {
    version++;
    if (preview) { preview = null; q("ai-preview-body").value = ""; }
    send("inputs_changed"); controls();
  }
  function showError(error) { q("ai-chat-error").textContent = errorText(error); q("ai-chat-error").hidden = false; }
  function renderModelDetails() {
    const model = models?.find(item => item.id === q("ai-model").value.trim());
    q("ai-model-details").hidden = models === null;
    q("ai-model-details").textContent = model ? `コンテキスト長: ${model.context_length ?? "不明"} トークン・100万トークン当たり: 入力 ${formatModelPrice(model.pricing.prompt)} / 出力 ${formatModelPrice(model.pricing.completion)}・` +
      [["structured_outputs", "構造化出力"], ["tools", "ツール"], ["reasoning", "推論"]].map(([parameter, label]) => `${label}: ${model.supported_parameters === null ? "不明" : model.supported_parameters.includes(parameter) ? "対応" : "非対応"}`).join("・") : "一覧にないモデルです";
    const estimate = preview ? estimatePreviewTokens(preview.body) : null;
    q("ai-token-estimate").textContent = estimate === null ? "" : `推定 ${estimate} トークン（本文の UTF-8 1バイトを1トークンとして計算。実際の使用量とは異なります）`;
    q("ai-context-warning").hidden = estimate === null || !model?.context_length || estimate <= model.context_length;
  }
  q("ai-models-fetch").addEventListener("click", async () => {
    if (loadingModels) return;
    loadingModels = true; models = null; invalidate(); q("ai-model-options").replaceChildren();
    q("ai-models-status").textContent = "モデル一覧を取得しています。"; renderModelDetails(); controls();
    try {
      models = await fetchModels();
      for (const model of models) {
        const option = document.createElement("option"); option.value = model.id; q("ai-model-options").append(option);
      }
      q("ai-models-status").textContent = `${models.length}件のモデルを取得しました。このタブだけに保持します。`;
    } catch (error) {
      q("ai-models-status").textContent = error.code === "size" ? "モデル一覧が大きすぎるため破棄しました。" : "モデル一覧を取得できませんでした。通信や応答の形式を確認してください。";
    } finally { loadingModels = false; invalidate(); renderModelDetails(); controls(); }
  });
  function selectedSummary() {
    q("ai-context-selection").textContent = `選択中: ${[...choices.files, ...choices.logs].join("、") || "ファイル・ログなし"} / 問題 ${choices.problems.size}件`;
  }
  function checkboxes(id, values, selected) {
    const container = q(id); container.replaceChildren();
    if (!values.length) { container.textContent = "選べる項目はありません。"; return; }
    for (const [value, title] of values) {
      const label = document.createElement("label"), input = document.createElement("input");
      label.className = "ai-context-option"; input.type = "checkbox"; input.value = value; input.checked = selected.has(value);
      input.addEventListener("change", () => { if (input.checked) selected.add(value); else selected.delete(value); selectedSummary(); invalidate(); });
      label.append(input, document.createTextNode(title)); container.append(label);
    }
  }
  function refresh() {
    const next = workspace.getContext();
    if (!next) { controls(); return; }
    if (annotationContext && (next.projectId !== annotationContext.projectId ||
        [...annotationContext.files].some(([path, content]) => next.files.get(path) !== content))) dismissAnnotations();
    if (next.projectId !== context?.projectId) {
      verificationProject = null;
      for (const selected of Object.values(choices)) selected.clear();
      if (selectableFiles(next.files).some(([p]) => p === next.activeFile)) choices.files.add(next.activeFile);
    }
    context = next;
    const files = selectableFiles(context.files).map(([p]) => [p, p]);
    const logs = [...context.logs.keys()].map((tool) => [tool, tool]);
    const problems = context.problems.map((p) => [JSON.stringify(p), `${p.file ?? "位置不明"}:${p.line ?? "-"} ${p.message}`]);
    for (const [name, values] of Object.entries({ files, logs, problems })) {
      for (const value of choices[name]) if (!values.some(([key]) => value === key)) choices[name].delete(value);
      checkboxes(`ai-context-${name}`, values, choices[name]);
    }
    selectedSummary(); invalidate();
  }
  function renderHistory() {
    q("ai-history-messages").replaceChildren();
    for (const message of history) {
      const heading = document.createElement("h4"), text = document.createElement("pre");
      heading.textContent = message.role === "user" ? "自分（送信した資料を含む）" : "AI"; text.textContent = message.content;
      q("ai-history-messages").append(heading, text);
    }
  }
  function renderProposals(result, files) {
    const diffs = new Map();
    const rejected = [...result.rejected];
    proposals = result.valid.filter((change) => {
      const diff = proposalDiff(change, files);
      if (diff === undefined) { rejected.push({ path: change.path, reason: "差分の計算量が上限を超えたため適用できません。提案を小さくしてください。" }); return false; }
      diffs.set(change.path, diff); return true;
    });
    accepted.clear();
    q("ai-proposals").hidden = !proposals.length;
    q("ai-proposal-files").replaceChildren();
    q("ai-rejected-paths").replaceChildren(); q("ai-rejected-paths").hidden = !rejected.length;
    for (const { path, reason } of rejected) {
      const card = document.createElement("article"), heading = document.createElement("h4"), p = document.createElement("p");
      card.className = "ai-rejected-proposal";
      heading.textContent = `適用できないパス: ${path.slice(0, 200)}`; p.textContent = reason;
      card.append(heading, p); q("ai-rejected-paths").append(card);
    }
    for (const change of proposals) {
      const card = document.createElement("article"), heading = document.createElement("h4"), reason = document.createElement("p"), diff = document.createElement("pre");
      const accept = document.createElement("button"), reject = document.createElement("button");
      card.className = "ai-proposal"; card.dataset.path = change.path;
      heading.textContent = change.path; reason.textContent = change.reason; diff.className = "ai-diff"; diff.tabIndex = 0;
      for (const line of diffs.get(change.path).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const row = document.createElement("span");
        row.className = line.startsWith("@@") ? "ai-diff-hunk"
          : line.startsWith("+") && !line.startsWith("+++") ? "ai-diff-added"
          : line.startsWith("-") && !line.startsWith("---") ? "ai-diff-removed" : "ai-diff-context";
        row.textContent = line; diff.append(row);
      }
      accept.type = reject.type = "button"; accept.textContent = "この変更を適用"; accept.setAttribute("aria-pressed", "false");
      reject.textContent = "却下"; reject.className = "secondary";
      accept.addEventListener("click", () => { accepted.add(change.path); card.dataset.decision = "accepted"; accept.setAttribute("aria-pressed", "true"); accept.textContent = "適用対象に選択済み"; controls(); });
      reject.addEventListener("click", () => { accepted.delete(change.path); card.dataset.decision = "rejected"; accept.setAttribute("aria-pressed", "false"); accept.textContent = "この変更を適用"; reason.textContent = "却下しました。ファイルは変更しません。"; controls(); });
      card.append(heading, reason, diff, accept, reject); q("ai-proposal-files").append(card);
    }
    controls();
  }
  q("ai-model").addEventListener("input", () => { invalidate(); renderModelDetails(); }); q("ai-prompt").addEventListener("input", invalidate);
  q("ai-skill").addEventListener("change", invalidate);
  q("ai-hint-level").addEventListener("change", invalidate);
  q("ai-resend-history").addEventListener("change", invalidate);
  q("ai-preview-button").addEventListener("click", () => {
    q("ai-chat-error").hidden = true;
    try {
      if (busy()) return;
      verificationProject = null;
      controls();
      if (!context) throw new Error();
      preview = createChatPreview({ model: q("ai-model").value, prompt: q("ai-prompt").value, history, models,
        skill: q("ai-skill").value, hintLevel: Number(q("ai-hint-level").value), resendHistory: q("ai-resend-history").checked, project: { ...context.project, files: context.files },
        files: [...context.files].filter(([p]) => choices.files.has(p)), logs: [...context.logs].filter(([p]) => choices.logs.has(p)).map(([tool, text]) => ({ tool, text })),
        problems: context.problems.filter((p) => choices.problems.has(JSON.stringify(p))), origin: location.origin });
      q("ai-preview-body").value = preview.body;
      q("ai-output-mode").textContent = preview.mode;
      renderModelDetails();
      q("ai-preview-target").textContent = `${preview.url} / ${preview.bytes} バイト`;
      q("ai-preview-headers").textContent = JSON.stringify({ ...preview.headers, "X-OpenRouter-Title": "午後のFPGA" }, null, 2);
      send("preview_requested", { context_valid: true }); controls(); q("ai-preview-body").focus();
      q("ai-preview-body").setSelectionRange(0, 0);
      q("ai-preview-body").scrollTop = 0;
    } catch (error) { showError(error); }
  });
  q("ai-preview-cancel").addEventListener("click", invalidate);
  q("ai-send").addEventListener("click", async () => {
    if (busy() || !preview || !getKey()) return;
    verificationProject = null;
    const selected = preview, key = getKey(), selectedVersion = version, run = ++generation;
    send("send_requested", { connected: true, preview_current: true });
    if (state !== "sending") return;
    dismissAnnotations();
    const abort = new AbortController(); controller = abort;
    q("ai-chat-error").hidden = true; q("ai-chat-response").textContent = ""; q("ai-answer").hidden = false;
    q("ai-usage").textContent = "";
    renderProposals({ valid: [], rejected: [] }, new Map()); controls();
    try {
      snapshot = await proposalSnapshot(workspace.getContext());
      if (version !== selectedVersion || preview !== selected || getKey() !== key || abort.signal.aborted) throw { code: "preview" };
      const answer = await sendChatPreview(selected, { key, signal: abort.signal, onUsage: (usage) => {
        if (run === generation) q("ai-usage").textContent = formatUsage(usage);
      }, onDelta: (_delta, text) => {
        if (run !== generation) return;
        send("chunk_received"); q("ai-chat-response").textContent = selected.structured ? "構造化された応答を受信しています" : text; controls();
      } });
      if (run !== generation) return;
      const compact = await compactUserTurn(selected.user);
      if (run !== generation) return;
      abort.signal.throwIfAborted();
      history.push({ role: "user", content: selected.user, compact }, { role: "assistant", content: answer }); renderHistory();
      const result = parseAiAnswer(answer, selected, snapshot.files);
      const sentFiles = new Map(JSON.parse(selected.user).files.map(({ path, content }) => [path, content]));
      const current = workspace.getContext();
      if (current?.projectId === snapshot.projectId && [...sentFiles].every(([path, content]) => current.files.get(path) === content)) renderAnswer(result.answer, selected, sentFiles);
      else q("ai-chat-response").textContent = result.answer;
      send("response_completed"); renderProposals(result.proposals, snapshot.files);
    } catch (error) {
      if (run !== generation) return;
      send(error.code === "stopped" ? "stop_requested" : "send_failed"); showError(error);
    } finally {
      if (run === generation) { controller = null; preview = null; controls(); }
    }
  });
  q("ai-stop").addEventListener("click", () => controller?.abort());
  q("ai-apply-selected").addEventListener("click", async () => {
    if (applying || busy()) return;
    applying = true; controls(); q("ai-chat-error").hidden = true;
    try { await revisions.apply(proposals.filter((p) => accepted.has(p.path)), snapshot); verificationProject = workspace.getContext()?.projectId ?? null; renderProposals({ valid: [], rejected: [] }, new Map()); q("ai-chat-status").textContent = "変更を保存しました。合成し直してください。"; }
    catch (error) { showError(error); }
    finally { applying = false; controls(); }
  });
  q("ai-undo").addEventListener("click", async () => {
    if (applying || busy()) return;
    verificationProject = null;
    applying = true; controls(); q("ai-chat-error").hidden = true;
    try { await revisions.undo(); } catch (error) { showError(error); }
    finally { applying = false; controls(); }
  });
  function clear(event = "clear_requested") {
    dismissAnnotations();
    verificationProject = null;
    generation++; controller?.abort(); controller = null; history = []; preview = null; snapshot = null;
    q("ai-resend-history").checked = false;
    q("ai-preview-body").value = ""; q("ai-prompt").value = ""; q("ai-chat-response").textContent = ""; q("ai-answer").hidden = true; q("ai-chat-error").hidden = true;
    q("ai-usage").textContent = "";
    send(event); renderHistory(); renderProposals({ valid: [], rejected: [] }, new Map()); controls();
  }
  q("ai-clear").addEventListener("click", () => clear());
  q("ai-dismiss-annotations").addEventListener("click", dismissAnnotations);
  for (const kind of ["build", "simulation", "formal"]) {
    q(`ai-verify-${kind}`).addEventListener("click", () => {
      const current = workspace.getContext();
      if (verificationProject === null || verificationProject !== current?.projectId || busy() || loadingModels || applying || workspace.isBusy() ||
          current?.verificationReady?.[kind] === false ||
          kind !== "build" && !current.project?.[kind]?.top?.trim()) return;
      document.dispatchEvent(new CustomEvent("toolchain:ai-verify", { detail: { kind } }));
    });
  }
  panel.addEventListener("toolchain:ai-auth-change", () => { const key = getKey(); if (lastKey && key !== lastKey) clear("disconnected"); lastKey = key; controls(); });
  document.addEventListener("toolchain:ai-context-changed", refresh);
  document.addEventListener("toolchain:flow-change", controls);
  document.addEventListener("toolchain:ai-busy-change", controls);
  document.addEventListener("toolchain:ai-explain", ({ detail }) => {
    if (busy()) return;
    refresh();
    const problem = detail?.problem;
    if (problem) choices.problems.add(JSON.stringify(problem));
    const file = problem?.file ?? context?.activeFile;
    if (file && selectableFiles(context.files).some(([p]) => p === file)) choices.files.add(file);
    const tool = detail?.tool ?? problem?.tool ?? (/\.vhdl?$/.test(file ?? "") ? "ghdl" : /\.cst$/.test(file ?? "") ? "nextpnr" : "yosys");
    if (context.logs.has(tool)) choices.logs.add(tool); else for (const name of context.logs.keys()) choices.logs.add(name);
    q("ai-skill").value = "explain";
    q("ai-prompt").value = `次の問題の原因、根拠、修正の手順を説明してください。\n${detail?.message ?? problem?.message ?? "直前のビルドが失敗しました。"}`;
    refresh(); showPanel(); q("ai-prompt").focus();
  });
  refresh(); send("clear_requested"); controls();
}
