import {
  beginOpenRouterLogin, callbackParams, completeOpenRouterLogin,
  createKeyStore, PKCE_STORAGE_KEY, scrubCallbackUrl,
} from "./openrouter-auth.mjs";

const ERROR_TEXT = {
  no_pending: "接続の手続きを確認できません。もう一度接続してください。",
  state_mismatch: "接続の確認情報が一致しません。もう一度接続してください。",
  expired: "接続の有効時間（10分）を過ぎました。もう一度接続してください。",
  denied: "接続は完了しませんでした。利用する場合はもう一度接続してください。",
  http_error: "OpenRouter が接続を受け付けませんでした。もう一度接続してください。",
  network_error: "OpenRouter に接続できません。通信を確認してください。",
  bad_response: "OpenRouter の応答を確認できません。もう一度接続してください。",
  storage_error: "接続情報を保存・削除できません。ブラウザーの保存設定を確認してください。",
  login_unavailable: "接続の準備ができません。ブラウザーの一時保存と暗号機能を確認してください。",
  project_save_failed: "プロジェクトを保存できないため移動しません。保存先を確認してください。",
};

export function initializeOpenRouterUI({ panel, showPanel, flushPendingSave }) {
  panel.innerHTML = `<h3>OpenRouter に接続する</h3>
    <p>送信先は openrouter.ai だけです。送るファイルやログは、送信前に自分で選びます。利用料は自分の OpenRouter の残高から支払います。</p>
    <p>チャット機能は今後追加します。現在は接続の設定だけで、設計データは送信しません。</p>
    <p id="ai-auth-status" role="status" aria-live="polite"></p>
    <p id="ai-auth-error" role="alert" hidden></p>
    <button id="ai-connect" type="button">OpenRouter で接続する</button>
    <label id="ai-persist-label" class="ai-persist" hidden><input id="ai-persist" type="checkbox">このブラウザーに保存する</label>
    <p>保存しない場合は、このタブのメモリーだけで保持します。再読み込みやタブを閉じると接続は解除されます。共有端末では保存しないでください。</p>
    <button id="ai-disconnect" type="button" class="secondary" hidden>接続を解除する</button>
    <p>解除すると、このブラウザーの接続情報を削除します。OpenRouter 側の鍵は失効しません。上限額の設定や鍵の無効化は OpenRouter の設定で行ってください。</p>`;
  const status = panel.querySelector("#ai-auth-status");
  const error = panel.querySelector("#ai-auth-error");
  const connect = panel.querySelector("#ai-connect");
  const disconnect = panel.querySelector("#ai-disconnect");
  const persist = panel.querySelector("#ai-persist");
  const persistLabel = panel.querySelector("#ai-persist-label");
  const keys = createKeyStore();
  let busy = false;
  function render() {
    const connected = Boolean(keys.key);
    status.textContent = busy ? "接続しています…" : connected
      ? keys.persisted ? "接続済み（このブラウザーに保存済み）" : "接続済み（このタブを閉じるまで）"
      : "未接続です。";
    connect.hidden = connected;
    disconnect.hidden = !connected && !keys.persisted;
    persistLabel.hidden = !connected;
    if (!busy) persist.checked = keys.persisted;
    for (const control of [connect, disconnect, persist]) control.disabled = busy;
  }
  async function run(operation) {
    busy = true;
    error.hidden = true;
    render();
    try { await operation(); }
    catch (failure) {
      error.textContent = ERROR_TEXT[failure?.code] ?? ERROR_TEXT[failure?.message] ?? "接続の設定を完了できませんでした。もう一度お試しください。";
      error.hidden = false;
    } finally { busy = false; render(); }
  }
  connect.addEventListener("click", () => void run(async () => {
    await flushPendingSave();
    await keys.forget();
    const url = await beginOpenRouterLogin();
    try { location.assign(url); }
    catch {
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      throw new Error("login_unavailable");
    }
  }));
  disconnect.addEventListener("click", () => void run(() => keys.forget()));
  persist.addEventListener("change", () => {
    const selected = persist.checked;
    void run(() => selected ? keys.persist() : keys.useMemoryOnly());
  });
  render();
  void run(async () => {
    const href = location.href;
    if (callbackParams(href)) {
      showPanel();
      try { scrubCallbackUrl(history, location); }
      catch {
        sessionStorage.removeItem(PKCE_STORAGE_KEY);
        throw new Error("login_unavailable");
      }
      const result = await completeOpenRouterLogin({ href });
      keys.set(result.key);
    } else {
      const pending = sessionStorage.getItem(PKCE_STORAGE_KEY);
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      if (pending) { showPanel(); throw new Error("denied"); }
      await keys.restore();
    }
  });
}
