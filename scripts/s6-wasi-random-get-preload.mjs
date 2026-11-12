import { webcrypto } from "node:crypto";

const randomSource = globalThis.crypto ?? webcrypto;
const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly);

WebAssembly.instantiate = async (source, imports) => {
  const sourceIsModule = source instanceof WebAssembly.Module;
  const module = sourceIsModule ? source : await WebAssembly.compile(source);
  const requiresRandomGet = WebAssembly.Module.imports(module).some(
    ({ module: moduleName, name }) =>
      moduleName === "wasi_snapshot_preview1" && name === "random_get",
  );
  if (
    !requiresRandomGet
    || imports?.wasi_snapshot_preview1?.random_get !== undefined
  ) {
    return imports === undefined
      ? nativeInstantiate(source)
      : nativeInstantiate(source, imports);
  }

  let instance;
  const randomGet = (pointer, length) => {
    const memory = instance?.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) return 21;
    let view;
    try {
      view = new Uint8Array(memory.buffer, pointer >>> 0, length >>> 0);
    } catch {
      return 21;
    }
    for (let offset = 0; offset < view.length; offset += 65_536) {
      randomSource.getRandomValues(
        view.subarray(offset, Math.min(offset + 65_536, view.length)),
      );
    }
    return 0;
  };
  const adaptedImports = {
    ...(imports ?? {}),
    wasi_snapshot_preview1: {
      ...(imports?.wasi_snapshot_preview1 ?? {}),
      random_get: randomGet,
    },
  };

  if (sourceIsModule) {
    instance = await nativeInstantiate(module, adaptedImports);
    return instance;
  }

  instance = await nativeInstantiate(module, adaptedImports);
  return { module, instance };
};
