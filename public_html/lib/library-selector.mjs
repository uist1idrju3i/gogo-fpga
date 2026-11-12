import { inspectInstalledLibraries, prepareLibrarySelection, resolveLibraryClosure } from "./libraries.mjs";
import { changeProjectLibraries } from "./project.mjs";
import { BOARDS } from "./boards.mjs";

const BOARD_STATES = {
  confirmed: "確認済み",
  "capacity-exceeded": "容量超過",
  "frontend-unsupported": "フロントエンド非対応",
  unverified: "未検証",
};

export function createLibrarySelector(container, { getWorkspace, getBoard, canChange, beforeChange, onChange, onBusy }) {
  const status = container.querySelector("[data-library-status]");
  const list = container.querySelector("[data-library-list]");
  const base = new URL("./libraries/", document.baseURI);
  let catalogPromise;
  let version = 0;
  let busy = false;

  async function load(path) {
    const url = new URL(path, base);
    if (url.origin !== location.origin || !url.href.startsWith(base.href)) throw new Error("資材は同一オリジンの専用領域から読み込んでください。");
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`資材を取得できません（HTTP ${response.status}）。`);
    return new Uint8Array(await response.arrayBuffer());
  }

  function getCatalog() {
    catalogPromise ??= load("catalog.json").then((content) => {
      const catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
      resolveLibraryClosure(catalog, [], { requireConfirmed: false });
      return catalog;
    }).catch((error) => { catalogPromise = null; throw error; });
    return catalogPromise;
  }

  function text(parent, tag, content) {
    const element = document.createElement(tag);
    element.textContent = content;
    parent.append(element);
    return element;
  }

  async function change(selection, remove = false) {
    if (busy || !canChange()) return;
    const original = getWorkspace();
    if (!original.project) return;
    busy = true;
    try {
      onBusy(true);
      beforeChange();
      const catalog = remove ? null : await getCatalog();
      const entry = catalog?.entries.find(({ id }) => id === selection.id);
      if (!remove && entry.deprecated && !window.confirm(`${entry.label} は保守終了です。固定版とライセンスを確認して利用しますか。`)) return;
      const add = remove ? null : await prepareLibrarySelection(catalog, selection, ({ asset }) => load(asset), {
        board: getBoard(), explicitSelections: [...original.project.libraries, selection],
      });
      const next = await changeProjectLibraries(original.project, original.files, { add, remove: remove ? selection : null });
      if (original.project !== getWorkspace().project) throw new Error("プロジェクトが切り替わったため変更を中止しました。");
      await onChange(next, original.project);
      status.textContent = "依存ソースとライセンスを検査して保存しました。";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      onBusy(false);
      void refresh(false);
    }
  }

  async function refresh(updateStatus = true) {
    const current = ++version;
    const workspace = getWorkspace();
    if (!workspace.project) return;
    try {
      let catalog = null;
      let catalogError = null;
      try { catalog = await getCatalog(); }
      catch (error) { catalogError = error; }
      const inspection = await inspectInstalledLibraries(workspace.project, workspace.files, catalog);
      if (current !== version || workspace.project !== getWorkspace().project) return;
      list.replaceChildren();
      if (updateStatus) status.textContent = catalog
        ? `${catalog.entries.length} 候補。未検証・非対応の候補も理由付きで表示します。`
        : `カタログを利用できません: ${catalogError.message}`;
      for (const record of inspection.records) {
        const item = document.createElement("li");
        item.className = "installed-library";
        text(item, "strong", `${record.id}/${record.component}`);
        text(item, "p", `${record.revision} / ${record.matched ? "配布カタログと一致" : catalog ? "持ち込みソース（現行カタログとは不一致）" : "同梱ソース（配布カタログとの照合なし）"}`);
        const remove = text(item, "button", "選択を解除");
        remove.type = "button";
        remove.disabled = busy;
        remove.addEventListener("click", () => void change(record, true));
        list.append(item);
      }
      for (const entry of catalog?.entries ?? []) {
        const item = document.createElement("li");
        item.className = "library-candidate";
        item.dataset.library = entry.id;
        const details = document.createElement("details");
        const state = entry.status === "available" ? "検証済み部品あり" : entry.status === "unsupported" ? "非対応" : entry.status === "frontend-unsupported" ? "フロントエンド非対応" : "未検証";
        text(details, "summary", `${entry.label} / ${entry.kind === "cpu" ? "CPU" : entry.kind === "verification" ? "検証用" : "ライブラリー"} / ${state}${entry.deprecated ? " / 保守終了" : ""}`);
        text(details, "p", `HDL: ${entry.language} / ライセンス: ${entry.license.expression}`);
        text(details, "p", `固定版: ${entry.source.revision}`);
        const source = text(details, "a", "上流の取得元");
        source.href = entry.source.url;
        source.target = "_blank";
        source.rel = "noopener";
        for (const notice of entry.license.files) {
          const link = text(details, "a", `許諾原文: ${notice.path}`);
          link.href = new URL(notice.asset, base).href;
          link.target = "_blank";
          link.rel = "noopener";
        }
        if (entry.license.note) text(details, "p", entry.license.note);
        if (entry.reason) text(details, "p", entry.reason);
        for (const component of entry.components.length ? entry.components : [null]) {
          if (component) text(details, "h4", component.label);
          text(details, "p", BOARDS.map(({ id, label }) => `${label}: ${BOARD_STATES[component?.boards[id]] ?? "非対応"}`).join(" / "));
          const button = text(details, "button", component ? "プロジェクトへ追加" : "選択できません");
          button.type = "button";
          let reason = entry.reason;
          try {
            if (!component) throw new Error(reason);
            if (workspace.project.libraries.some(({ id, component: selected }) => id === entry.id && selected === component.id)) throw new Error("選択済みです。");
            resolveLibraryClosure(catalog, [{ id: entry.id, component: component.id }], {
              board: getBoard(), explicitSelections: [...workspace.project.libraries, { id: entry.id }],
            });
            reason = "";
          } catch (error) { reason = error.message; }
          button.disabled = busy || Boolean(reason);
          button.title = reason;
          if (reason) text(details, "p", reason);
          if (component) {
            text(details, "p", "パラメーターは HDL のインスタンス側で指定します。");
            for (const [name, value] of Object.entries(component.parameters ?? {})) {
              text(details, "p", `パラメーターの参照値: ${name} = ${value}`);
            }
            text(details, "p", `依存: ${component.dependencies.join(", ") || "なし"} / define: ${JSON.stringify(component.defines)}`);
            button.addEventListener("click", () => void change({ id: entry.id, component: component.id }));
          }
        }
        item.append(details);
        list.append(item);
      }
      if (!catalog) {
        const retry = text(list, "li", "");
        const button = text(retry, "button", "カタログを再取得");
        button.type = "button";
        button.disabled = busy;
        button.addEventListener("click", () => void refresh());
      }
    } catch (error) {
      if (current === version) status.textContent = `カタログを利用できません: ${error.message}`;
    }
  }
  return { refresh };
}
