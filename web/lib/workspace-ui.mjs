export const WELCOME_STORAGE_KEY = "gogo-fpga.welcome.dismissed";

export function welcomeDismissed(storage) {
  try { return storage.getItem(WELCOME_STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function rememberWelcomeDismissal(storage) {
  try { storage.setItem(WELCOME_STORAGE_KEY, "true"); return true; }
  catch { return false; }
}

export function initializeWorkspaceUI(boards) {
  const pane = document.querySelector("#board-pane");
  const files = document.querySelector("#files-pane");
  const writer = pane.querySelector(".writer-controls");
  const information = pane.querySelector(".board-information");
  const tabs = document.createElement("div");
  tabs.className = "workspace-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "設定の種類");
  const panels = new Map();
  const heading = information.querySelector(".pane-heading");
  heading.querySelector("h2").textContent = "設定";
  pane.prepend(heading, tabs);
  for (const [name, label] of [["board", "ボード"], ["write", "書き込み"], ["verify", "検証"], ["ai", "AI"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `right-tab-${name}`;
    button.textContent = label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `right-panel-${name}`);
    const panel = document.createElement("section");
    panel.id = `right-panel-${name}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panels.set(name, panel);
    pane.append(panel);
    tabs.append(button);
    button.addEventListener("click", () => selectTab(name));
  }
  function selectTab(name) {
    for (const [key, panel] of panels) {
      panel.hidden = key !== name;
      const button = document.querySelector(`#right-tab-${key}`);
      button.setAttribute("aria-selected", String(key === name));
      button.tabIndex = key === name ? 0 : -1;
    }
  }
  tabs.addEventListener("keydown", (event) => {
    const buttons = [...tabs.children];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowRight" ? (index + 1) % buttons.length
      : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next].click();
    buttons[next].focus();
  });
  panels.get("board").append(information, document.querySelector(".support-status"));
  panels.get("write").append(writer);
  for (const id of ["simulation-button", "formal-button"]) {
    panels.get("verify").append(document.querySelector(`#${id}`).closest(".synthesis-control"));
  }
  for (const section of files.querySelectorAll(".simulation-settings")) panels.get("verify").append(section);
  panels.get("ai").innerHTML = "<h3>AI に相談する</h3><p>今後の対応を予定しています。このタブから外部への通信やデータの送信は行いません。</p>";
  files.append(document.querySelector("#licenses"));
  selectTab("board");

  const actions = document.querySelector(".header-actions");
  const primary = document.createElement("div");
  primary.id = "primary-action";
  const secondary = document.createElement("div");
  secondary.id = "writer-secondary-action";
  writer.prepend(secondary);
  const feedback = document.createElement("div");
  feedback.id = "workflow-feedback";
  for (const id of ["synthesis-stage", "synthesis-reason", "synthesis-asset-size"]) feedback.append(document.querySelector(`#${id}`));
  document.querySelector("#workflow-guidance").after(feedback);
  actions.prepend(primary);
  const buildButton = document.querySelector("#synthesis-button");
  const wrapper = buildButton.closest(".synthesis-control");
  primary.append(buildButton);
  wrapper.remove();
  document.querySelector("#toggle-board-pane").textContent = "設定";

  const welcome = document.querySelector("#welcome-card");
  let storage;
  try { storage = globalThis.localStorage; } catch { storage = null; }
  welcome.hidden = welcomeDismissed(storage);
  const welcomeBoard = document.querySelector("#welcome-board");
  for (const board of boards) welcomeBoard.add(new Option(board.label, board.id));
  welcomeBoard.value = "tangnano9k";
  const support = document.querySelector("#support-status");
  const copySupport = () => { document.querySelector("#welcome-support").textContent = support.textContent; };
  new MutationObserver(copySupport).observe(support, { childList: true });
  copySupport();
  document.querySelector("#welcome-dismiss").addEventListener("click", () => {
    const remembered = rememberWelcomeDismissal(storage);
    welcome.hidden = true;
    if (!remembered) {
      document.querySelector("#project-action-status").dataset.outcome = "error";
      document.querySelector("#project-action-status").textContent = "案内を閉じた状態をこのブラウザーに保存できません。";
    }
  });
  document.querySelector("#welcome-start").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("toolchain:welcome-start", { detail: { board: welcomeBoard.value } }));
  });

  const media = matchMedia("(max-width: 820px)");
  const boardPicker = document.querySelector("#board-select").closest("label");
  const headerControls = document.querySelector(".header-controls");
  const backdrop = document.querySelector("#sheet-backdrop");
  let previousSheet = null;
  function syncSheets() {
    const open = media.matches ? [files, pane].find((element) => element.dataset.open === "true") : null;
    backdrop.hidden = !open;
    document.querySelector(".editor-pane").inert = Boolean(open);
    document.querySelector(".brand").inert = Boolean(open);
    for (const element of [files, pane]) {
      element.setAttribute("role", media.matches ? "dialog" : "complementary");
      if (element === open) element.setAttribute("aria-modal", "true");
      else element.removeAttribute("aria-modal");
    }
    if (open && open !== previousSheet) open.querySelector(".pane-close").focus();
    if (!open && previousSheet && media.matches) document.querySelector(previousSheet === files ? "#toggle-files-pane" : "#toggle-board-pane").focus();
    previousSheet = open;
  }
  function closeSheets() {
    for (const [element, id] of [[files, "toggle-files-pane"], [pane, "toggle-board-pane"]]) {
      element.dataset.open = "false";
      document.querySelector(`#${id}`).setAttribute("aria-expanded", "false");
    }
    syncSheets();
  }
  backdrop.addEventListener("click", closeSheets);
  document.addEventListener("toolchain:show-editor", closeSheets);
  document.addEventListener("keydown", (event) => {
    if (!previousSheet) return;
    if (event.key === "Escape") {
      const opener = previousSheet === files ? "toggle-files-pane" : "toggle-board-pane";
      closeSheets();
      document.querySelector(`#${opener}`).focus();
    }
    if (event.key !== "Tab") return;
    const targets = [...previousSheet.querySelectorAll("button, input, select, a[href], summary, [tabindex='0']")]
      .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = targets[0];
    const last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  new MutationObserver(syncSheets).observe(files, { attributes: true, attributeFilter: ["data-open"] });
  new MutationObserver(syncSheets).observe(pane, { attributes: true, attributeFilter: ["data-open"] });
  const resize = () => {
    document.querySelector("#welcome-details").open = !media.matches;
    if (media.matches) panels.get("board").prepend(boardPicker);
    else headerControls.prepend(boardPicker);
    closeSheets();
  };
  media.addEventListener("change", resize);
  resize();
  return {
    syncPrimary(writing) {
      const program = document.querySelector("#program-button");
      const primaryButton = writing ? program : buildButton;
      const secondaryButton = writing ? buildButton : program;
      if (primaryButton.parentElement !== primary) primary.append(primaryButton);
      if (secondaryButton.parentElement !== secondary) secondary.append(secondaryButton);
    },
    updateWelcome(view) {
      document.querySelector("#welcome-built").checked = !view.stale && ["built", "writing", "written", "write_failed"].includes(view.state);
      document.querySelector("#welcome-written").checked = !view.stale && view.state === "written";
      const led = document.querySelector("#welcome-led");
      led.disabled = view.stale || view.state !== "written";
      if (led.disabled) led.checked = false;
    },
    selectTab,
  };
}
