import { autocompletion, completeFromList } from "@codemirror/autocomplete";
import { basicSetup } from "codemirror";
import { StreamLanguage } from "@codemirror/language";
import { lintGutter, setDiagnostics as setLintDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { collectIdentifiers, KEYWORDS_BY_LANGUAGE } from "../lib/hdl-keywords.mjs";
import { wrapVhdlMode } from "../lib/hdl-mode.mjs";
import { COMPLETION_LIMITS, completionContext, createLocalCompleter, initializeCompletionUI } from "../lib/local-completion.mjs";

const setGhost = StateEffect.define();
const ghostText = StateField.define({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) if (effect.is(setGhost)) value = effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value
    ? Decoration.set([Decoration.widget({ widget: new CompletionWidget(value.text), side: 1 }).range(value.position)]) : Decoration.none),
});
class CompletionWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return this.text === other.text; }
  get lineBreaks() { return this.text.split("\n").length - 1; }
  toDOM() {
    const node = document.createElement("span"); node.className = "cm-local-completion";
    node.textContent = this.text; node.setAttribute("aria-label", "端末内 AI の補完候補");
    return node;
  }
  ignoreEvent() { return true; }
}

const VERILOG_LANGUAGE = StreamLanguage.define(verilog);
const VHDL_LANGUAGE = StreamLanguage.define(wrapVhdlMode(vhdl));
const VALID_LANGUAGES = new Set(["verilog", "vhdl", "plain"]);
const DIAGNOSTIC_SEVERITIES = new Set(["error", "warning", "info", "hint"]);
const setHintLines = StateEffect.define();
const hintLines = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none;
    for (const effect of transaction.effects) if (effect.is(setHintLines)) value = effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

function normalizeLanguage(language) {
  return VALID_LANGUAGES.has(language) ? language : "plain";
}

function languageExtension(language) {
  if (language === "verilog") return VERILOG_LANGUAGE;
  if (language === "vhdl") return VHDL_LANGUAGE;
  return [];
}

function readOnlyExtension(readOnly) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ "aria-readonly": String(readOnly) }),
  ];
}

function completionSource(language, getProjectTexts) {
  return (context) => {
    const keywords = KEYWORDS_BY_LANGUAGE[language] ?? [];
    const options = [
      ...keywords.map((label) => ({ label, type: "keyword" })),
      ...collectIdentifiers(getProjectTexts()).map((label) => ({
        label,
        type: "variable",
      })),
    ];
    return completeFromList(options)(context);
  };
}

function normalizeDiagnostics(diagnostics, documentLength) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.flatMap((diagnostic) => {
    if (
      diagnostic === null ||
      typeof diagnostic !== "object" ||
      !Number.isInteger(diagnostic.from) ||
      !Number.isInteger(diagnostic.to) ||
      typeof diagnostic.message !== "string"
    ) {
      return [];
    }
    const from = Math.min(Math.max(0, diagnostic.from), documentLength);
    const to = Math.min(
      Math.max(from, diagnostic.to),
      documentLength,
    );
    return [{
      ...diagnostic,
      from,
      to,
      severity: DIAGNOSTIC_SEVERITIES.has(diagnostic.severity)
        ? diagnostic.severity
        : "error",
    }];
  });
}

export function languageForPath(path) {
  if (typeof path !== "string") return "plain";
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".v") || lowerPath.endsWith(".vh")) return "verilog";
  if (lowerPath.endsWith(".vhd") || lowerPath.endsWith(".vhdl")) return "vhdl";
  return "plain";
}

export function createHdlEditor(
  parent,
  {
    doc = "",
    language = "plain",
    readOnly = false,
    onChange = () => {},
    onDiagnostics = () => {},
    getProjectTexts = () => [doc],
    getFileContext = () => null,
    completionPanel = null,
  } = {},
) {
  let activeLanguage = normalizeLanguage(language);
  const languageCompartment = new Compartment();
  const completionCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  let timer = null, requestVersion = 0, fileKey = getFileContext()?.key;
  let renderCompletion = () => {};
  const completer = createLocalCompleter({ onStatus: state => renderCompletion(state) });
  function cancelCompletion() {
    clearTimeout(timer); requestVersion++; completer.cancel();
  }
  function clearCompletion() {
    cancelCompletion(); view.dispatch({ effects: setGhost.of(null) });
  }
  async function requestCompletion() {
    clearCompletion();
    const selection = view.state.selection.main, file = getFileContext();
    if (!file?.path || !selection.empty || view.state.readOnly || !view.hasFocus) return;
    const version = requestVersion, position = selection.head;
    const text = await completer.complete(completionContext({ text: view.state.doc.toString(), cursor: position, ...file }));
    if (version === requestVersion && text && view.hasFocus) view.dispatch({ effects: setGhost.of({ text, position }) });
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        hintLines,
        ghostText,
        Prec.highest(keymap.of([
          { key: "Tab", run() {
            const ghost = view.state.field(ghostText);
            if (!ghost || view.state.readOnly) return false;
            cancelCompletion();
            view.dispatch({ changes: { from: ghost.position, insert: ghost.text }, selection: { anchor: ghost.position + ghost.text.length }, userEvent: "input.complete" });
            return true;
          } },
          { key: "Escape", run() { if (!view.state.field(ghostText)) return false; clearCompletion(); return true; } },
          { key: "Alt-\\", run() { if (!completer.state.enabled) return false; void requestCompletion(); return true; } },
        ])),
        readOnlyCompartment.of(readOnlyExtension(readOnly)),
        languageCompartment.of(languageExtension(activeLanguage)),
        completionCompartment.of(
          autocompletion({
            override: [completionSource(activeLanguage, getProjectTexts)],
          }),
        ),
        lintGutter(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet) {
            cancelCompletion();
            if (update.docChanged && completer.state.enabled && update.transactions.some(transaction => transaction.isUserEvent("input") && !transaction.isUserEvent("input.complete"))) {
              timer = setTimeout(() => void requestCompletion(), COMPLETION_LIMITS.delay);
            }
          }
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  if (completionPanel) {
    renderCompletion = initializeCompletionUI(completionPanel, completer, clearCompletion);
    renderCompletion(completer.state); void completer.probe();
  }

  function setLanguage(nextLanguage) {
    activeLanguage = normalizeLanguage(nextLanguage);
    view.dispatch({
      effects: [
        languageCompartment.reconfigure(languageExtension(activeLanguage)),
        completionCompartment.reconfigure(
          autocompletion({
            override: [completionSource(activeLanguage, getProjectTexts)],
          }),
        ),
      ],
    });
  }

  function setEditorDiagnostics(diagnostics) {
    const normalized = normalizeDiagnostics(diagnostics, view.state.doc.length);
    view.dispatch(setLintDiagnostics(view.state, normalized));
    onDiagnostics(normalized);
  }

  return {
    getText() {
      return view.state.doc.toString();
    },
    setText(text) {
      const nextText = String(text);
      const currentLength = view.state.doc.length;
      if (view.state.doc.toString() !== nextText) {
        view.dispatch({
          changes: { from: 0, to: currentLength, insert: nextText },
        });
      }
    },
    setLanguage,
    setFileContext(key) {
      if (key !== fileKey) { fileKey = key; clearCompletion(); }
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtension(readOnly)) });
    },
    setDiagnostics: setEditorDiagnostics,
    setLineAnnotations(lines) {
      const ranges = [...new Set(lines)].filter(line => Number.isInteger(line) && line > 0 && line <= view.state.doc.lines)
        .sort((a, b) => a - b).map(line => Decoration.line({ class: "cm-ai-hint-line", attributes: { title: "AI のヒント" } }).range(view.state.doc.line(line).from));
      view.dispatch({ effects: setHintLines.of(Decoration.set(ranges)) });
    },
    revealLocation(line = 1, column = 1) {
      const target = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, Number.isInteger(line) ? line : 1)));
      const anchor = target.from + Math.min(target.length, Math.max(0, Number.isInteger(column) ? column - 1 : 0));
      view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
      view.focus();
    },
    focus() {
      view.focus();
    },
    destroy() {
      cancelCompletion(); completer.disable();
      view.destroy();
    },
  };
}
