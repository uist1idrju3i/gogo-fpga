import { autocompletion, completeFromList } from "@codemirror/autocomplete";
import { basicSetup } from "codemirror";
import { StreamLanguage } from "@codemirror/language";
import { lintGutter, setDiagnostics as setLintDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { collectIdentifiers, KEYWORDS_BY_LANGUAGE } from "../lib/hdl-keywords.mjs";
import { wrapVhdlMode } from "../lib/hdl-mode.mjs";

const VERILOG_LANGUAGE = StreamLanguage.define(verilog);
const VHDL_LANGUAGE = StreamLanguage.define(wrapVhdlMode(vhdl));
const VALID_LANGUAGES = new Set(["verilog", "vhdl", "plain"]);
const DIAGNOSTIC_SEVERITIES = new Set(["error", "warning", "info", "hint"]);

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
  } = {},
) {
  let activeLanguage = normalizeLanguage(language);
  const languageCompartment = new Compartment();
  const completionCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        readOnlyCompartment.of(readOnlyExtension(readOnly)),
        languageCompartment.of(languageExtension(activeLanguage)),
        completionCompartment.of(
          autocompletion({
            override: [completionSource(activeLanguage, getProjectTexts)],
          }),
        ),
        lintGutter(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

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
    setReadOnly(readOnly) {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtension(readOnly)) });
    },
    setDiagnostics: setEditorDiagnostics,
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
