import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function sourcePathLabel(repoRoot, sourcePath) {
  return normalizePath(relative(repoRoot, sourcePath));
}

export function assertFormalDistributionMatches({ repoRoot, distRoot, buildRoot }) {
  const workdir = mkdtempSync(resolve(buildRoot, "e2e-formal-"));
  try {
    execFileSync("python3", [
      resolve(repoRoot, "scripts/formal-distribution.py"), "stage-licenses", workdir,
    ]);
    const pythonRoot = resolve(workdir, "python");
    execFileSync("python3", [
      resolve(repoRoot, "scripts/build-formal-python.py"), "--out", pythonRoot,
    ]);
    return {
      licenses: assertCopiedTreeMatches({
        repoRoot, distRoot,
        sourceRoot: resolve(workdir, "licenses"), distSubdir: "licenses",
      }),
      python: assertCopiedTreeMatches({
        repoRoot, distRoot, sourceRoot: pythonRoot, distSubdir: "formal/python",
      }),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

export function assertCopiedTreeMatches({
  repoRoot,
  distRoot,
  sourceRoot,
  distSubdir,
}) {
  const sourceRootLabel = sourcePathLabel(repoRoot, sourceRoot);
  let sourceFiles;
  try {
    sourceFiles = listFiles(sourceRoot);
  } catch (error) {
    throw new Error(`Playwright preflight: source ${sourceRootLabel} is missing`, {
      cause: error,
    });
  }
  if (sourceFiles.length === 0) {
    throw new Error(
      `Playwright preflight: source ${sourceRootLabel} contains no files`,
    );
  }

  const distPaths = new Set();
  for (const sourceFile of sourceFiles) {
    const sourceRelativePath = normalizePath(relative(sourceRoot, sourceFile));
    const distRelativePath = `${distSubdir}/${sourceRelativePath}`;
    let distContents;
    try {
      distContents = readFileSync(resolve(distRoot, distRelativePath));
    } catch (error) {
      throw new Error(`Playwright preflight: public_html/${distRelativePath} is missing`, {
        cause: error,
      });
    }
    if (!readFileSync(sourceFile).equals(distContents)) {
      throw new Error(
        `Playwright preflight: public_html/${distRelativePath} differs from ` +
          sourcePathLabel(repoRoot, sourceFile),
      );
    }
    distPaths.add(distRelativePath);
  }
  return distPaths;
}

export function assertCopiedFileMatches({
  repoRoot,
  distRoot,
  sourcePath,
  distPath,
}) {
  const sourceLabel = sourcePathLabel(repoRoot, sourcePath);
  let sourceContents;
  try {
    sourceContents = readFileSync(sourcePath);
  } catch (error) {
    throw new Error(`Playwright preflight: source ${sourceLabel} is missing`, {
      cause: error,
    });
  }

  let distContents;
  try {
    distContents = readFileSync(resolve(distRoot, distPath));
  } catch (error) {
    throw new Error(`Playwright preflight: public_html/${distPath} is missing`, {
      cause: error,
    });
  }
  if (!sourceContents.equals(distContents)) {
    throw new Error(
      `Playwright preflight: public_html/${distPath} differs from ${sourceLabel}`,
    );
  }
  return new Set([distPath]);
}
