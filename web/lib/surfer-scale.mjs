export function surferZoomFactor(canvas, dpr) {
  const ratio = canvas?.width / (canvas?.clientWidth * dpr);
  return Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 0.02
    ? ratio : null;
}

export function observeSurferScale(frame) {
  const view = frame.contentWindow;
  const canvas = frame.contentDocument.querySelector("canvas");
  let pending = null;
  let disposed = false;
  let resolution;
  function refresh() {
    if (disposed || pending !== null) return;
    pending = view.requestAnimationFrame(() => {
      pending = view.requestAnimationFrame(() => {
        pending = null;
        if (disposed) return;
        const ratio = surferZoomFactor(canvas, view.devicePixelRatio);
        if (ratio !== null) view.postMessage({ command: "InjectMessage",
          message: JSON.stringify({ SetUIZoomFactor: ratio }) }, view.location.origin);
      });
    });
  }
  function watchResolution() {
    resolution?.removeEventListener("change", watchResolution);
    resolution = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
    resolution.addEventListener("change", watchResolution);
    refresh();
  }
  const observer = new ResizeObserver(refresh);
  observer.observe(frame);
  if (canvas) observer.observe(canvas);
  window.addEventListener("orientationchange", refresh);
  view.addEventListener("resize", refresh);
  watchResolution();
  return {
    refresh,
    dispose() {
      disposed = true;
      observer.disconnect();
      resolution.removeEventListener("change", watchResolution);
      window.removeEventListener("orientationchange", refresh);
      view.removeEventListener("resize", refresh);
      if (pending !== null) view.cancelAnimationFrame(pending);
    },
  };
}
