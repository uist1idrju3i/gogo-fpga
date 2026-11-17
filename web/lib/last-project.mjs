const key = "toolchain.ide.last-project";

export function lastProjectName(names, storage = () => globalThis.localStorage) {
  try {
    const name = storage().getItem(key);
    if (names.includes(name)) return name;
  } catch {}
  return names[0] ?? null;
}

export function rememberProject(name, storage = () => globalThis.localStorage) {
  try {
    if (name === null) storage().removeItem(key);
    else storage().setItem(key, name);
  } catch {}
}
