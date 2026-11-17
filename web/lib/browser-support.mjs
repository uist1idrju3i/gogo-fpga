export function checkBrowserSupport(environment = globalThis) {
  const missing = [];
  if (typeof environment.navigator?.usb?.requestDevice !== "function") missing.push("WebUSB");
  if (!environment.crossOriginIsolated) missing.push("Cross-Origin Isolation");
  const wasm = environment.WebAssembly;
  if (!wasm) missing.push("WebAssembly");
  else if (typeof wasm.Suspending !== "function" || typeof wasm.promising !== "function") {
    missing.push("WebAssembly JSPI");
  }
  return missing;
}

export function browserSupportMessage(missing) {
  if (missing.length === 0) return "このブラウザーを利用できます。";
  const guidance = [];
  if (missing.includes("WebAssembly")) {
    guidance.push("サイトの設定で WebAssembly を許可してください。");
  }
  if (missing.includes("WebAssembly JSPI") || missing.includes("WebUSB")) {
    guidance.push("Chrome 137 以降、または必要な機能に対応した最新版のブラウザーを利用してください。");
  }
  if (missing.includes("Cross-Origin Isolation")) {
    guidance.push("COOP/COEP ヘッダーが有効な配信先、または COOP/COEP が有効な localhost で開いてください。");
  }
  return `このブラウザーでは操作できません。足りない機能：${missing.join("、")}。${guidance.join("")}`;
}
