import { createChatPreview, selectableFiles, sendChatPreview } from "./openrouter-chat.mjs";
import { parseProposals, proposalDiff, proposalSnapshot } from "./ai-proposals.mjs";
import { AI_CHAT_INITIAL_STATE, transitionAiChat } from "./ai-chat-flow.mjs";
export { createProposalEditor } from "./ai-proposals.mjs";

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
      <label for="ai-model">モデル</label><input id="ai-model" type="text" value="openrouter/auto" maxlength="200" autocomplete="off">
      <details id="ai-context-picker"><summary>送る内容を選ぶ</summary>
        <fieldset><legend>プロジェクトのファイル</legend><div id="ai-context-files"></div></fieldset>
        <fieldset><legend>直前のビルドログ</legend><div id="ai-context-logs"></div></fieldset>
        <fieldset><legend>問題</legend><div id="ai-context-problems"></div></fieldset>
      </details><p id="ai-context-selection"></p>
      <label for="ai-prompt">相談文</label><textarea id="ai-prompt" rows="4" placeholder="エラーや設計について相談してください"></textarea>
      <button id="ai-preview-button" type="button">送信内容を確認</button>
    </fieldset>
    <section id="ai-preview" hidden><h4>送信内容の確認</h4>
      <p id="ai-preview-target"></p><pre id="ai-preview-headers" tabindex="0"></pre>
      <p>Authorization には接続中の鍵を付けます（鍵は表示しません）。日本語のタイトルは UTF-8 のバイト列で送ります。</p>
      <label for="ai-preview-body">実際に送る JSON 本文（編集不可）</label>
      <textarea id="ai-preview-body" readonly rows="12" spellcheck="false"></textarea>
      <button id="ai-send" type="button">送信する</button>
      <button id="ai-preview-cancel" type="button" class="secondary">内容を編集する</button>
    </section>
    <button id="ai-stop" type="button" class="secondary" hidden>停止</button>
    <section id="ai-answer" hidden><h4>AI の応答</h4><pre id="ai-chat-response" role="log" aria-live="polite" tabindex="0"></pre></section>
    <section id="ai-proposals" hidden><h4>変更提案の確認</h4>
      <p>各ファイルの差分を確認して採否を選び、まとめて適用で確定します。選んだ変更は1回で保存します。</p>
      <div id="ai-proposal-files"></div><p id="ai-apply-reason" role="status"></p>
      <button id="ai-apply-selected" type="button">選んだ変更をまとめて適用</button>
    </section>
    <div id="ai-rejected-paths" role="status" hidden></div>
    <button id="ai-undo" type="button" class="secondary" hidden>元に戻す</button>
    <details id="ai-history"><summary>これまでの会話（このタブだけ）</summary><div id="ai-history-messages"></div></details>
    <button id="ai-clear" type="button" class="secondary">会話を消す</button>`;
  panel.append(root);
  const q = (id) => root.querySelector(`#${id}`);
  const choices = { files: new Set(), logs: new Set(), problems: new Set() };
  let history = [], preview = null, proposals = [], snapshot = null, context;
  let state = AI_CHAT_INITIAL_STATE, controller = null, generation = 0, version = 0, applying = false;
  let accepted = new Set(), lastKey = getKey();
  function send(event, guards) { state = transitionAiChat(state, event, guards); root.dataset.state = state; }
  function busy() { return Boolean(controller); }
  function controls() {
    q("ai-compose").disabled = busy() || applying;
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
    if (next.projectId !== context?.projectId) {
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
      const p = document.createElement("p"); p.textContent = `適用できないパス: ${path.slice(0, 200)}: ${reason}`; q("ai-rejected-paths").append(p);
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
  q("ai-model").addEventListener("input", invalidate); q("ai-prompt").addEventListener("input", invalidate);
  q("ai-preview-button").addEventListener("click", () => {
    q("ai-chat-error").hidden = true;
    try {
      if (!context) throw new Error();
      preview = createChatPreview({ model: q("ai-model").value, prompt: q("ai-prompt").value, history,
        files: [...context.files].filter(([p]) => choices.files.has(p)), logs: [...context.logs].filter(([p]) => choices.logs.has(p)).map(([tool, text]) => ({ tool, text })),
        problems: context.problems.filter((p) => choices.problems.has(JSON.stringify(p))), origin: location.origin });
      q("ai-preview-body").value = preview.body;
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
    const selected = preview, key = getKey(), selectedVersion = version, run = ++generation;
    send("send_requested", { connected: true, preview_current: true });
    if (state !== "sending") return;
    const abort = new AbortController(); controller = abort;
    q("ai-chat-error").hidden = true; q("ai-chat-response").textContent = ""; q("ai-answer").hidden = false;
    renderProposals({ valid: [], rejected: [] }, new Map()); controls();
    try {
      snapshot = await proposalSnapshot(workspace.getContext());
      if (version !== selectedVersion || preview !== selected || getKey() !== key || abort.signal.aborted) throw { code: "preview" };
      const answer = await sendChatPreview(selected, { key, signal: abort.signal, onDelta: (_delta, text) => {
        if (run !== generation) return;
        send("chunk_received"); q("ai-chat-response").textContent = text; controls();
      } });
      if (run !== generation) return;
      history.push({ role: "user", content: selected.user }, { role: "assistant", content: answer }); renderHistory();
      send("response_completed"); renderProposals(parseProposals(answer, snapshot.files), snapshot.files);
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
    try { await revisions.apply(proposals.filter((p) => accepted.has(p.path)), snapshot); renderProposals({ valid: [], rejected: [] }, new Map()); q("ai-chat-status").textContent = "変更を保存しました。合成し直してください。"; }
    catch (error) { showError(error); }
    finally { applying = false; controls(); }
  });
  q("ai-undo").addEventListener("click", async () => {
    if (applying || busy()) return;
    applying = true; controls(); q("ai-chat-error").hidden = true;
    try { await revisions.undo(); } catch (error) { showError(error); }
    finally { applying = false; controls(); }
  });
  function clear(event = "clear_requested") {
    generation++; controller?.abort(); controller = null; history = []; preview = null; snapshot = null;
    q("ai-preview-body").value = ""; q("ai-prompt").value = ""; q("ai-chat-response").textContent = ""; q("ai-answer").hidden = true; q("ai-chat-error").hidden = true;
    send(event); renderHistory(); renderProposals({ valid: [], rejected: [] }, new Map()); controls();
  }
  q("ai-clear").addEventListener("click", () => clear());
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
    const tool = problem?.tool ?? (/\.vhdl?$/.test(file ?? "") ? "ghdl" : /\.cst$/.test(file ?? "") ? "nextpnr" : "yosys");
    if (context.logs.has(tool)) choices.logs.add(tool); else for (const name of context.logs.keys()) choices.logs.add(name);
    q("ai-prompt").value = `次の問題の原因と修正案を説明してください。変更はファイルごとの全文で提案してください。\n${problem?.message ?? "直前のビルドが失敗しました。"}`;
    refresh(); showPanel(); q("ai-prompt").focus();
  });
  refresh(); send("clear_requested"); controls();
}
