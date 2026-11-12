function capability(entry) {
  return Object.freeze({ ...entry, modes: Object.freeze(entry.modes), blockers: Object.freeze(entry.blockers) });
}

export const FORMAL_SOLVERS = Object.freeze([
  capability({ id: "yices2", label: "Yices2", smtbmc: "yices", command: "yices-smt2", source: "vendor/yices2",
    status: "probe-verified", modes: ["bmc", "prove", "cover"], blockers: [], deprecated: false,
    reason: "原本SBY・SMTBMCとnative/WASIの正式反復で照合済み。製品画面と配布の接続は別に確認します。" }),
  capability({ id: "z3", label: "Z3", smtbmc: "z3", command: "z3", source: "vendor/z3",
    status: "probe-verified", modes: ["bmc", "prove", "cover"], blockers: [], deprecated: false,
    reason: "原本SBY・SMTBMCとnative/WASIの正式反復で照合済み。製品画面と配布の接続は別に確認します。" }),
  capability({ id: "bitwuzla", label: "Bitwuzla", smtbmc: "bitwuzla", command: "bitwuzla", source: "vendor/bitwuzla",
    status: "product-unqualified", modes: [], blockers: ["product-qualification-missing", "dependency-distribution-unreviewed"], deprecated: false,
    reason: "原本SMTBMC/SBYの正式反復は照合済みですが、製品用資材・依存の配布条件・製品認定は未確認です。" }),
  capability({ id: "boolector", label: "Boolector", smtbmc: "boolector", command: "boolector", source: "vendor/boolector",
    status: "product-unqualified", modes: [], blockers: ["product-qualification-missing", "dependency-distribution-unreviewed", "maintenance-ended"], deprecated: true,
    reason: "保守終了で後継はBitwuzlaです。原本SMTBMC/SBYの正式反復は照合済みですが、製品用資材・依存の配布条件・製品認定は未確認です。" }),
  capability({ id: "cvc4", label: "CVC4", smtbmc: "cvc4", command: "cvc4", source: null,
    status: "distribution-unreviewed", modes: [], blockers: ["source-unpinned", "build-unverified", "adapter-unverified", "distribution-unreviewed"], deprecated: false,
    reason: "上流SMTBMCの選択肢です。固定ソース・配布条件・WASIビルド・仮想process接続は未確認です。" }),
  capability({ id: "cvc5", label: "cvc5", smtbmc: "cvc5", command: "cvc5", source: null,
    status: "distribution-unreviewed", modes: [], blockers: ["source-unpinned", "build-unverified", "adapter-unverified", "distribution-unreviewed"], deprecated: false,
    reason: "上流SMTBMCの選択肢です。固定ソース・配布条件・WASIビルド・仮想process接続は未確認です。" }),
  capability({ id: "mathsat", label: "MathSAT", smtbmc: "mathsat", command: "mathsat", source: null,
    status: "distribution-unreviewed", modes: [], blockers: ["source-unpinned", "build-unverified", "adapter-unverified", "distribution-unreviewed"], deprecated: false,
    reason: "上流SMTBMCの選択肢です。固定ソース・配布条件・WASIビルド・仮想process接続は未確認です。" }),
  capability({ id: "abc", label: "ABC (SMTBMC)", smtbmc: "abc", command: "yosys-abc", source: "vendor/yosys/abc",
    status: "adapter-missing", modes: [], blockers: ["adapter-missing", "formal-execution-unverified"], deprecated: false,
    reason: "合成内のABC利用とは別です。yosys-abc -Sの独立process接続と形式検証の実行は未確認です。" }),
  capability({ id: "dummy", label: "dummy", smtbmc: "dummy", command: null, source: "vendor/yosys",
    status: "diagnostic-only", modes: [], blockers: ["diagnostic-only"], deprecated: false,
    reason: "記録済み応答を読む検査用backendです。solverによる証明ではないため、証明用には有効化しません。" }),
]);

export const FORMAL_ENGINES = Object.freeze([
  capability({ id: "smtbmc", label: "SBY / SMTBMC", kind: "sby", status: "probe-verified",
    modes: ["bmc", "prove", "cover"], blockers: [],
    reason: "初期実装は単一slotです。BMC・prove・coverを区別し、検証済みsolverが必要です。" }),
  capability({ id: "abc", label: "SBY / ABC", kind: "sby", status: "adapter-missing",
    modes: ["bmc", "prove"], blockers: ["adapter-missing", "formal-execution-unverified"],
    reason: "ABCのSBY engine接続は未実装です。合成やSMTBMCのABC選択肢とは別です。" }),
  capability({ id: "aiger", label: "SBY / AIGER", kind: "sby", status: "adapter-missing",
    modes: ["bmc", "prove", "live"], blockers: ["adapter-missing", "formal-execution-unverified"],
    reason: "外部AIGER engineは未接続です。witnessの形式変換試験はengineの証明を確認したものではありません。" }),
  capability({ id: "btor", label: "SBY / BTOR", kind: "sby", status: "adapter-missing",
    modes: ["bmc", "prove", "cover"], blockers: ["adapter-missing", "formal-execution-unverified"],
    reason: "外部BTOR engineは未接続です。witnessの形式変換試験はengineの証明を確認したものではありません。" }),
  capability({ id: "itp", label: "SBY / ITP", kind: "sby", status: "adapter-missing",
    modes: ["bmc", "prove"], blockers: ["adapter-missing", "formal-execution-unverified"],
    reason: "itp-bmcの固定資材とprocess接続は未実装です。" }),
  capability({ id: "none", label: "SBY / none", kind: "sby", status: "model-only",
    modes: ["bmc", "prove", "cover", "live"], blockers: ["model-only"],
    reason: "モデル生成用であり、証明を実行するengineではありません。証明用には有効化しません。" }),
  capability({ id: "yosys-sat", label: "Yosys SAT", kind: "builtin", status: "probe-verified",
    modes: ["bmc", "prove"], blockers: [],
    reason: "Yosys内蔵SATの限定比較経路です。SMT solverやSBY engineとは別で、coverは扱いません。" }),
]);

function availableIds(value, catalog) {
  if (!Array.isArray(value) || value.length > catalog.length || new Set(value).size !== value.length ||
      ![...value].every(id => typeof id === "string" && catalog.some(entry => entry.id === id))) {
    throw new TypeError("Invalid formal available capabilities");
  }
  return new Set(value);
}

export function formalCapabilities({ mode = "bmc", availableSolvers = [], availableEngines = [] } = {}) {
  if (!["bmc", "prove", "cover", "live"].includes(mode)) throw new Error("Unsupported formal mode");
  const solverIds = availableIds(availableSolvers, FORMAL_SOLVERS);
  const engineIds = availableIds(availableEngines, FORMAL_ENGINES);
  function option(entry, available, dependencyReady = true) {
    if (entry.status !== "probe-verified") return { ...entry, disabled: true };
    if (!entry.modes.includes(mode)) return { ...entry, disabled: true, reason: "この検証モードは未対応です。" };
    if (!available.has(entry.id)) return { ...entry, disabled: true, reason: "製品用の配布資材が準備されていません。" };
    if (!dependencyReady) return { ...entry, disabled: true, reason: "利用できる検証済みSMT solverがありません。" };
    return { ...entry, disabled: false };
  }
  const solvers = FORMAL_SOLVERS.map(entry => option(entry, solverIds));
  const solverReady = solvers.some(entry => !entry.disabled);
  const engines = FORMAL_ENGINES.map(entry => option(entry, engineIds, entry.id !== "smtbmc" || solverReady));
  return { mode, solvers, engines };
}
