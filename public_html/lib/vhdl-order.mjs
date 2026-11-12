function maskNonCode(source) {
  const characters = [...source];
  const blank = (index) => {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  };
  for (let index = 0; index < characters.length;) {
    if (characters[index] === "-" && characters[index + 1] === "-") {
      while (index < characters.length && characters[index] !== "\n") blank(index++);
    } else if (characters[index] === "/" && characters[index + 1] === "*") {
      blank(index++);
      blank(index++);
      while (
        index < characters.length &&
        !(characters[index] === "*" && characters[index + 1] === "/")
      ) {
        blank(index++);
      }
      if (index < characters.length) {
        blank(index++);
        blank(index++);
      }
    } else if (characters[index] === '"') {
      blank(index++);
      while (index < characters.length) {
        if (characters[index] === '"' && characters[index + 1] === '"') {
          blank(index++);
          blank(index++);
        } else if (characters[index] === '"') {
          blank(index++);
          break;
        } else {
          blank(index++);
        }
      }
    } else if (
      characters[index] === "'" &&
      index + 2 < characters.length &&
      characters[index + 2] === "'" &&
      characters[index + 1] !== "\n"
    ) {
      blank(index++);
      blank(index++);
      blank(index++);
    } else {
      index += 1;
    }
  }
  return characters.join("");
}

function tokensWithLines(source) {
  const masked = maskNonCode(source);
  const tokens = [];
  const pattern = /[a-z][a-z0-9_]*|[^\s]/gi;
  for (const match of masked.matchAll(pattern)) {
    tokens.push({
      text: match[0].toLowerCase(),
      line: masked.slice(0, match.index).split("\n").length,
    });
  }
  return tokens;
}

function reference(tokens, start, references, kind, usage = "reference") {
  const library = tokens[start + 1]?.text;
  if (!/^[a-z][a-z0-9_]*$/.test(library ?? "") || tokens[start + 2]?.text !== ".") return;
  const name = tokens[start + 3];
  if (name && /^[a-z][a-z0-9_]*$/i.test(name.text)) {
    references.push({ library, name: name.text, line: tokens[start].line, kind, usage });
  }
}

function analyzeFile(file) {
  const source = typeof file.content === "string"
    ? file.content
    : new TextDecoder().decode(file.content ?? new Uint8Array());
  const tokens = tokensWithLines(source);
  const declarations = [];
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index].text;
    if (word === "entity") {
      if (tokens[index + 2]?.text === ".") {
        reference(tokens, index, references, "entity", "instantiation");
      } else if (tokens[index + 2]?.text === "is") {
        declarations.push({
          name: tokens[index + 1].text,
          kind: "entity",
          line: tokens[index].line,
        });
      }
    } else if (word === "package") {
      if (tokens[index + 1]?.text === "body") {
        const name = tokens[index + 2];
        if (name && tokens[index + 3]?.text === "is") {
          declarations.push({
            name: name.text,
            kind: "package-body",
            line: tokens[index].line,
          });
          references.push({ name: name.text, line: tokens[index].line, kind: "package" });
        }
      } else if (tokens[index + 2]?.text === "is") {
        declarations.push({
          name: tokens[index + 1].text,
          kind: "package",
          line: tokens[index].line,
        });
      }
    } else if (word === "context") {
      if (tokens[index + 2]?.text === ".") {
        reference(tokens, index, references, "context");
      } else if (tokens[index + 2]?.text === "is") {
        declarations.push({
          name: tokens[index + 1].text,
          kind: "context",
          line: tokens[index].line,
        });
      }
    } else if (word === "architecture" && tokens[index + 2]?.text === "of") {
      declarations.push({
        name: tokens[index + 1].text,
        kind: "architecture",
        entity: tokens[index + 3]?.text,
        line: tokens[index].line,
      });
      if (tokens[index + 3]) {
        references.push({
          name: tokens[index + 3].text,
          line: tokens[index].line,
          kind: "entity",
          usage: "architecture",
        });
      }
    } else if (word === "configuration" && tokens[index + 2]?.text === "of") {
      declarations.push({
        name: tokens[index + 1].text,
        kind: "configuration",
        line: tokens[index].line,
      });
      if (tokens[index + 3]) {
        references.push({
          name: tokens[index + 3].text,
          line: tokens[index].line,
          kind: "entity",
          usage: "configuration",
        });
      }
    } else if (word === "use" || word === "new") {
      reference(tokens, index, references, "reference");
    }
  }
  return { declarations, references };
}

export function getVhdlLibrary(file) {
  const name = file.library === undefined ? "work" : file.library;
  if (typeof name !== "string" || !/^[A-Za-z](?:[A-Za-z0-9]|_(?=[A-Za-z0-9]))*$/.test(name)) {
    throw new TypeError(`Invalid VHDL library: ${name}`);
  }
  return name.toLowerCase();
}

export function analyzeVhdlDesign(files) {
  if (!Array.isArray(files)) {
    throw new TypeError("VHDL files must be an array");
  }
  return files.map((file) => ({
    file,
    ...analyzeFile(file),
  }));
}

export function orderVhdlFiles(files) {
  if (!Array.isArray(files)) {
    throw new TypeError("VHDL files must be an array");
  }
  const units = analyzeVhdlDesign(files);
  const declarations = new Map();
  const errors = [];
  const libraries = new Set(files.map(getVhdlLibrary));
  const designUnits = new Map();
  units.forEach(({ file, declarations: fileDeclarations }, fileIndex) => {
    const library = getVhdlLibrary(file);
    for (const declaration of fileDeclarations) {
      const primary = ["entity", "package", "context", "configuration"].includes(declaration.kind);
      const key = `${library}.${declaration.name}`;
      const unitKey = primary ? key : `${key}:${declaration.kind}:${declaration.entity ?? ""}`;
      if (designUnits.has(unitKey)) {
        errors.push({ file: file.path, line: declaration.line, message: `Duplicate ${library} design unit "${declaration.name}"` });
      }
      designUnits.set(unitKey, declaration);
      if (!primary) continue;
      const filesForName = declarations.get(key) ?? [];
      filesForName.push(fileIndex);
      declarations.set(key, filesForName);
    }
  });

  const edges = files.map(() => []);
  units.forEach(({ file, references }, fileIndex) => {
    for (const reference of references) {
      const library = !reference.library || reference.library === "work" ? getVhdlLibrary(file) : reference.library;
      if (reference.library && reference.library !== "work" && !libraries.has(library)) continue;
      const providers = declarations.get(`${library}.${reference.name}`);
      if (!providers?.length) {
        errors.push({
          file: files[fileIndex].path,
          line: reference.line,
          message: reference.kind === "reference"
            ? `Unresolved ${library} reference "${reference.name}"`
            : `Unresolved ${library} ${reference.kind} reference "${reference.name}"`,
        });
        continue;
      }
      const provider = providers.find((index) => index !== fileIndex) ?? fileIndex;
      if (provider !== fileIndex) {
        edges[fileIndex].push({
          dependency: provider,
          line: reference.line,
          name: reference.name,
        });
      }
    }
  });

  const indegree = files.map(() => 0);
  const dependents = files.map(() => []);
  edges.forEach((fileEdges, fileIndex) => {
    const dependencies = new Set();
    for (const edge of fileEdges) {
      if (dependencies.has(edge.dependency)) continue;
      dependencies.add(edge.dependency);
      indegree[fileIndex] += 1;
      dependents[edge.dependency].push(fileIndex);
    }
  });
  const ready = files
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0);
  const order = [];
  while (ready.length) {
    ready.sort((left, right) => left - right);
    const current = ready.shift();
    order.push(files[current]);
    for (const dependent of dependents[current]) {
      indegree[dependent] -= 1;
      if (indegree[dependent] === 0) ready.push(dependent);
    }
  }

  if (order.length !== files.length) {
    const remaining = new Set(
      files.map((_, index) => index).filter((index) => indegree[index] > 0),
    );
    for (const fileIndex of remaining) {
      const edge = edges[fileIndex].find(({ dependency }) => remaining.has(dependency));
      if (!edge) continue;
      errors.push({
        file: files[fileIndex].path,
        line: edge.line,
        message:
          `VHDL dependency cycle: ${files[fileIndex].path}:${edge.line} depends on ` +
          `${files[edge.dependency].path} through "${edge.name}"`,
      });
    }
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, order };
}
