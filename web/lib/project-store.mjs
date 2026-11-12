import {
  createProjectSnapshot,
  migrateProject,
  validateProject,
  validateProjectName,
} from "./project.mjs";
import { exportProjectZip, importProjectZip } from "./project-zip.mjs";

function parseProjectJson(projectJson, name) {
  let project;
  try {
    project = JSON.parse(projectJson);
  } catch (error) {
    throw new Error(`project.json を解析できません: ${name}`, { cause: error });
  }
  project = migrateProject(project);
  const validation = validateProject(project);
  if (!validation.ok) {
    throw new Error(`project.json の内容が不正です: ${validation.errors.join(" ")}`);
  }
  if (project.name !== name) {
    throw new Error(`project.json のプロジェクト名が一致しません: ${name}`);
  }
  return project;
}

function assertProjectName(name) {
  const validation = validateProjectName(name);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }
}

export function createMemoryStore({ records = new Map() } = {}) {
  if (!(records instanceof Map)) {
    throw new TypeError("records must be a Map");
  }

  return {
    async listProjects() {
      return [...records.keys()].sort();
    },

    async load(name) {
      assertProjectName(name);
      const record = records.get(name);
      if (!record) {
        throw new Error(`プロジェクトが見つかりません: ${name}`);
      }
      const project = parseProjectJson(record.projectJson, name);
      const snapshot = await createProjectSnapshot(project, record.files);
      return { project: snapshot.project, files: snapshot.files };
    },

    async save(project, files) {
      const record = await createProjectSnapshot(project, files);
      records.set(record.project.name, { projectJson: record.projectJson, files: record.files });
    },

    async remove(name) {
      assertProjectName(name);
      return records.delete(name);
    },
  };
}

async function getProjectsDirectory(storage, create) {
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("このブラウザーでは OPFS を利用できません。");
  }
  const root = await storage.getDirectory();
  return root.getDirectoryHandle("projects", { create });
}

async function getFileDirectory(projectDirectory, path, create) {
  const segments = path.split("/");
  let directory = projectDirectory;
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return { directory, fileName: segments.at(-1) };
}

async function readOpfsFile(projectDirectory, path) {
  const { directory, fileName } = await getFileDirectory(
    projectDirectory,
    path,
    false,
  );
  const handle = await directory.getFileHandle(fileName);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

export function createOpfsStore(storage) {
  return {
    async listProjects() {
      let projects;
      try {
        projects = await getProjectsDirectory(storage, false);
      } catch (error) {
        if (error?.name === "NotFoundError") return [];
        throw new Error("プロジェクト一覧を読み込めません。", { cause: error });
      }

      const names = [];
      for await (const [name, handle] of projects.entries()) {
        if (handle.kind === "directory" && validateProjectName(name).ok) {
          for (const manifest of ["workspace.zip", "project.json"]) {
            try {
              const file = await (await handle.getFileHandle(manifest)).getFile();
              if (file.size > 0) {
                names.push(name);
                break;
              }
            } catch (error) {
              if (error?.name !== "NotFoundError") throw error;
            }
          }
        }
      }
      return names.sort();
    },

    async load(name) {
      assertProjectName(name);
      try {
        const projects = await getProjectsDirectory(storage, false);
        const projectDirectory = await projects.getDirectoryHandle(name);
        let archive;
        try { archive = await projectDirectory.getFileHandle("workspace.zip"); }
        catch (error) { if (error?.name !== "NotFoundError") throw error; }
        if (archive) {
          const file = await archive.getFile();
          if (file.size > 0) {
            const loaded = await importProjectZip(new Uint8Array(await file.arrayBuffer()));
            if (loaded.project.name !== name) throw new Error("プロジェクト名が一致しません。");
            return loaded;
          }
        }
        const manifest = await projectDirectory.getFileHandle("project.json");
        const project = parseProjectJson(
          await (await manifest.getFile()).text(),
          name,
        );
        const files = new Map();
        for (const { path } of project.files) {
          files.set(path, await readOpfsFile(projectDirectory, path));
        }
        const snapshot = await createProjectSnapshot(project, files);
        return { project: snapshot.project, files: snapshot.files };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("project.json")) {
          throw error;
        }
        throw new Error(`プロジェクトを読み込めません: ${name}`, { cause: error });
      }
    },

    async save(project, files) {
      const name = project?.name;
      const archive = await exportProjectZip(project, files, { compressionLevel: 0 });
      try {
        const projects = await getProjectsDirectory(storage, true);
        const projectDirectory = await projects.getDirectoryHandle(name, {
          create: true,
        });
        const handle = await projectDirectory.getFileHandle("workspace.zip", {
          create: true,
        });
        const writable = await handle.createWritable();
        try {
          await writable.write(archive);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
        for await (const [path, entry] of projectDirectory.entries()) {
          if (path !== "workspace.zip") {
            await projectDirectory.removeEntry(path, { recursive: entry.kind === "directory" });
          }
        }
      } catch (error) {
        throw new Error(`プロジェクトを保存できません: ${name}`, {
          cause: error,
        });
      }
    },

    async remove(name) {
      assertProjectName(name);
      try {
        const projects = await getProjectsDirectory(storage, false);
        await projects.removeEntry(name, { recursive: true });
        return true;
      } catch (error) {
        if (error?.name === "NotFoundError") return false;
        throw new Error(`プロジェクトを削除できません: ${name}`, {
          cause: error,
        });
      }
    },
  };
}
