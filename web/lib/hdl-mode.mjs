const VHDL_EXTENSION_KEYWORDS = new Set(["force", "release", "protected"]);

export function wrapVhdlMode(mode) {
  return {
    ...mode,
    token(stream, state) {
      const style = mode.token.call(mode, stream, state);
      if (
        style !== "keyword" &&
        VHDL_EXTENSION_KEYWORDS.has(stream.current().toLowerCase())
      ) {
        return "keyword";
      }
      return style;
    },
  };
}
