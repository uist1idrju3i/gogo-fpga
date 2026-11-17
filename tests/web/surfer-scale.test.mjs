import assert from "node:assert/strict";
import test from "node:test";
import { observeSurferScale, surferZoomFactor } from "../../web/lib/surfer-scale.mjs";

test("canvas scaling compensates for backing pixels diverging from DPR", () => {
  assert.equal(surferZoomFactor({ width: 390, clientWidth: 390 }, 3), 1 / 3);
  assert.equal(surferZoomFactor({ width: 2340, clientWidth: 390 }, 3), 2);
});

test("normal and near-normal scaling is untouched", () => {
  for (const dpr of [1, 3]) {
    assert.equal(surferZoomFactor({ width: 390 * dpr, clientWidth: 390 }, dpr), null);
  }
  assert.equal(surferZoomFactor({ width: 101, clientWidth: 100 }, 1), null);
});

test("empty, hidden and invalid canvas dimensions never inject zoom", () => {
  for (const width of [0, -1, NaN, Infinity]) {
    assert.equal(surferZoomFactor({ width, clientWidth: 390 }, 3), null);
  }
  assert.equal(surferZoomFactor(null, 3), null);
  assert.equal(surferZoomFactor({ width: 390, clientWidth: 0 }, 3), null);
  assert.equal(surferZoomFactor({ width: 390, clientWidth: 390 }, 0), null);
});

test("normal scaling resets a previous correction but invalid dimensions retain it", () => {
  assert.equal(surferZoomFactor({ width: 101, clientWidth: 100 }, 1, 1 / 3), 1);
  assert.equal(surferZoomFactor({ width: 100, clientWidth: 100 }, 1, 1), null);
  assert.equal(surferZoomFactor({ width: 100, clientWidth: 0 }, 1, 1 / 3), null);
});

test("scale observers refresh on resize, orientation and DPR changes and dispose on reset", t => {
  const originalWindow = globalThis.window;
  const originalObserver = globalThis.ResizeObserver;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.ResizeObserver = originalObserver;
  });
  const parent = new EventTarget();
  globalThis.window = parent;
  let observer;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    targets = [];
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
  };
  const view = new EventTarget();
  const frames = new Map();
  const queries = [];
  const messages = [];
  let id = 0;
  Object.assign(view, {
    devicePixelRatio: 3,
    location: { origin: "https://example.test" },
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    matchMedia(query) { const media = new EventTarget(); queries.push({ media, query }); return media; },
    postMessage(message, origin) { messages.push({ message: JSON.parse(message.message), origin }); },
  });
  const canvas = { width: 390, clientWidth: 390 };
  const frame = { contentWindow: view, contentDocument: { querySelector: () => canvas } };
  const scale = observeSurferScale(frame);
  function render() {
    while (frames.size) {
      const current = [...frames]; frames.clear();
      for (const [, callback] of current) callback();
    }
  }
  render();
  assert.deepEqual(observer.targets, [frame, canvas]);
  assert.deepEqual(messages[0], { message: { SetUIZoomFactor: 1 / 3 }, origin: view.location.origin });
  for (const trigger of [() => observer.callback(), () => view.dispatchEvent(new Event("resize")),
    () => parent.dispatchEvent(new Event("orientationchange")), () => scale.refresh()]) {
    const count = messages.length;
    trigger(); render();
    assert.equal(messages.length, count + 1);
  }
  view.devicePixelRatio = 1;
  queries[0].media.dispatchEvent(new Event("change"));
  render();
  assert.equal(queries.at(-1).query, "(resolution: 1dppx)");
  assert.equal(messages.at(-1).message.SetUIZoomFactor, 1);
  const count = messages.length;
  scale.refresh(); render();
  assert.equal(messages.length, count);
  scale.refresh();
  scale.dispose();
  assert.equal(frames.size, 0);
  assert.deepEqual(observer.targets, []);
  observer.callback();
  parent.dispatchEvent(new Event("orientationchange"));
  view.dispatchEvent(new Event("resize"));
  render();
  assert.equal(messages.length, count);
});
