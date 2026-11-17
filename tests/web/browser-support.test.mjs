import assert from "node:assert/strict";
import test from "node:test";
import { browserSupportMessage, checkBrowserSupport } from "../../web/lib/browser-support.mjs";

function supported() {
  return { navigator: { usb: { requestDevice() {} } }, crossOriginIsolated: true,
    WebAssembly: { Suspending() {}, promising() {} } };
}

test("supported browser needs no guidance", () => {
  assert.deepEqual(checkBrowserSupport(supported()), []);
  assert.equal(browserSupportMessage([]), "このブラウザーを利用できます。");
});

test("missing JSPI recommends a compatible browser, not localhost", () => {
  for (const name of ["Suspending", "promising"]) {
    const environment = supported();
    delete environment.WebAssembly[name];
    const missing = checkBrowserSupport(environment);
    assert.deepEqual(missing, ["WebAssembly JSPI"]);
    assert.match(browserSupportMessage(missing), /Chrome 137 以降/);
    assert.doesNotMatch(browserSupportMessage(missing), /localhost|COOP/);
  }
});

test("absent WebAssembly is detected without accessing its properties", () => {
  const environment = supported();
  delete environment.WebAssembly;
  assert.deepEqual(checkBrowserSupport(environment), ["WebAssembly"]);
  const message = browserSupportMessage(checkBrowserSupport(environment));
  assert.match(message, /サイトの設定で WebAssembly を許可/);
  assert.doesNotMatch(message, /localhost|JSPI/);
});

test("isolation and WebUSB failures give their own guidance and combine", () => {
  const environment = supported();
  environment.crossOriginIsolated = false;
  assert.match(browserSupportMessage(checkBrowserSupport(environment)), /COOP\/COEP ヘッダー.*localhost/);
  assert.doesNotMatch(browserSupportMessage(checkBrowserSupport(environment)), /Chrome 137/);
  delete environment.navigator;
  const message = browserSupportMessage(checkBrowserSupport(environment));
  assert.match(message, /WebUSB/);
  assert.match(message, /Chrome 137/);
  assert.match(message, /COOP\/COEP/);
});
