/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { createReadStream, createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const APP_NAME = "rim-inm-drive";
const SYNC_INTERVAL_MS = 30_000;
const INVALID_WINDOWS_NAME = /[<>:"|?*\u0000-\u001f]/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

let mainWindow;
let syncTimer;
let syncRunning = false;

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function statePath() {
  return path.join(app.getPath("userData"), "sync-state.json");
}

function defaultConfig() {
  return {
    serverUrl: "http://localhost:3000",
    localPath: path.join(app.getPath("documents"), "rim-inm-drive"),
    accountName: "",
    encryptedToken: "",
  };
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadConfig() {
  return { ...defaultConfig(), ...(await loadJson(configPath(), {})) };
}

async function saveConfig(config) {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function encryptToken(token) {
  if (!token) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windowsの資格情報暗号化を利用できません。");
  }
  return safeStorage.encryptString(token).toString("base64");
}

function decryptToken(encryptedToken) {
  if (!encryptedToken || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
  } catch {
    return "";
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function normalizeServerUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("サーバーURLはhttpまたはhttpsを指定してください。");
  return url.toString().replace(/\/$/, "");
}

function endpoint(config, action, remotePath) {
  const url = new URL("/api/share-cloud-drive/sync", config.serverUrl);
  url.searchParams.set("action", action);
  if (remotePath) url.searchParams.set("path", remotePath);
  return url;
}

async function apiRequest(config, action, options = {}) {
  const token = decryptToken(config.encryptedToken);
  if (!token) throw new Error("同期クライアントにログインしてください。");
  const response = await fetch(endpoint(config, action, options.remotePath), {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    body: options.body,
    duplex: options.body ? "half" : undefined,
  });
  if (!response.ok) {
    let message = `サーバーエラー (${response.status})`;
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return response;
}

function validateRemotePath(remotePath) {
  const pieces = remotePath.split("/").filter(Boolean);
  for (const piece of pieces) {
    if (
      INVALID_WINDOWS_NAME.test(piece)
      || RESERVED_WINDOWS_NAME.test(piece)
      || piece.endsWith(".")
      || piece.endsWith(" ")
    ) {
      throw new Error(`Windowsで使用できない名前です: ${remotePath}`);
    }
  }
  return pieces;
}

function localPathFor(root, remotePath) {
  return path.join(root, ...validateRemotePath(remotePath));
}

function remotePathFor(relativePath) {
  return `/${relativePath.split(path.sep).filter(Boolean).join("/")}`;
}

async function scanLocal(root) {
  const entries = new Map();
  await fs.mkdir(root, { recursive: true });

  async function walk(directory, relative = "") {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (child.name.startsWith(".rimworld-sync-")) continue;
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const remotePath = remotePathFor(childRelative);
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.set(remotePath, { isFolder: true, signature: "dir" });
        await walk(fullPath, childRelative);
      } else if (child.isFile()) {
        const info = await fs.stat(fullPath);
        entries.set(remotePath, {
          isFolder: false,
          signature: `${info.size}:${Math.trunc(info.mtimeMs)}`,
          size: info.size,
        });
      }
    }
  }

  await walk(root);
  return entries;
}

function remoteVersion(entry) {
  return entry ? `${entry.id}:${entry.updatedAt}:${entry.size}:${entry.isFolder}` : null;
}

async function fetchManifest(config) {
  const response = await apiRequest(config, "manifest");
  const body = await response.json();
  return new Map(body.entries.map((entry) => [entry.path, entry]));
}

async function deleteRemote(config, remotePath) {
  await apiRequest(config, "entry", { method: "DELETE", remotePath });
  log(`サーバーから削除: ${remotePath}`);
}

async function putFolder(config, remotePath) {
  await apiRequest(config, "folder", { method: "PUT", remotePath });
  log(`サーバーにフォルダ作成: ${remotePath}`);
}

async function uploadFile(config, root, remotePath) {
  const filePath = localPathFor(root, remotePath);
  const info = await fs.stat(filePath);
  await apiRequest(config, "file", {
    method: "PUT",
    remotePath,
    headers: { "content-length": String(info.size) },
    body: Readable.toWeb(createReadStream(filePath)),
  });
  log(`アップロード: ${remotePath}`);
}

async function deleteLocal(root, remotePath) {
  await fs.rm(localPathFor(root, remotePath), { recursive: true, force: true });
  log(`ローカルから削除: ${remotePath}`);
}

async function pullRemote(config, root, remotePath, remote) {
  const target = localPathFor(root, remotePath);
  if (remote.isFolder) {
    try {
      const info = await fs.stat(target);
      if (!info.isDirectory()) await fs.rm(target, { force: true });
    } catch {}
    await fs.mkdir(target, { recursive: true });
    log(`ローカルにフォルダ作成: ${remotePath}`);
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    const info = await fs.stat(target);
    if (info.isDirectory()) await fs.rm(target, { recursive: true, force: true });
  } catch {}
  const response = await apiRequest(config, "file", { remotePath });
  if (!response.body) throw new Error(`ダウンロードデータがありません: ${remotePath}`);
  const temporary = `${target}.rimworld-sync-downloading`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await fs.rename(temporary, target);
  log(`ダウンロード: ${remotePath}`);
}

async function pushLocal(config, root, remotePath, local, remote) {
  if (remote && remote.isFolder !== local.isFolder) await deleteRemote(config, remotePath);
  if (local.isFolder) await putFolder(config, remotePath);
  else await uploadFile(config, root, remotePath);
}

async function preserveConflict(root, remotePath) {
  const source = localPathFor(root, remotePath);
  const parsed = path.parse(source);
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "");
  const target = path.join(parsed.dir, `${parsed.name} (conflict ${os.hostname()} ${stamp})${parsed.ext}`);
  await fs.rename(source, target);
  log(`競合コピーを保存: ${path.basename(target)}`);
}

function isUnderHandledPrefix(remotePath, prefixes) {
  return prefixes.some((prefix) => remotePath.startsWith(`${prefix}/`));
}

async function syncNow() {
  if (syncRunning) return { ok: false, message: "同期は既に実行中です。" };
  syncRunning = true;
  try {
    const config = await loadConfig();
    config.serverUrl = normalizeServerUrl(config.serverUrl);
    if (!decryptToken(config.encryptedToken)) throw new Error("先にログインしてください。");
    await fs.mkdir(config.localPath, { recursive: true });
    log("同期を開始します。");

    const [remoteEntries, localEntries, previous] = await Promise.all([
      fetchManifest(config),
      scanLocal(config.localPath),
      loadJson(statePath(), { entries: {} }),
    ]);
    const previousEntries = previous.entries || {};
    const allPaths = [...new Set([
      ...remoteEntries.keys(),
      ...localEntries.keys(),
      ...Object.keys(previousEntries),
    ])].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    const handledPrefixes = [];

    for (const remotePath of allPaths) {
      if (isUnderHandledPrefix(remotePath, handledPrefixes)) continue;
      const local = localEntries.get(remotePath);
      const remote = remoteEntries.get(remotePath);
      const prior = previousEntries[remotePath];
      const localChanged = prior
        ? !local || local.signature !== prior.localSignature || local.isFolder !== prior.isFolder
        : Boolean(local);
      const remoteChanged = prior
        ? !remote || remoteVersion(remote) !== prior.remoteVersion || remote.isFolder !== prior.isFolder
        : Boolean(remote);

      if (!prior) {
        if (local && remote) {
          if (local.isFolder && remote.isFolder) continue;
          await preserveConflict(config.localPath, remotePath);
          await pullRemote(config, config.localPath, remotePath, remote);
          if (local.isFolder || remote.isFolder) handledPrefixes.push(remotePath);
        } else if (local) {
          await pushLocal(config, config.localPath, remotePath, local, remote);
        } else if (remote) {
          await pullRemote(config, config.localPath, remotePath, remote);
        }
        continue;
      }

      if (localChanged && remoteChanged) {
        if (!local && remote) {
          await pullRemote(config, config.localPath, remotePath, remote);
        } else if (local && !remote) {
          await pushLocal(config, config.localPath, remotePath, local, remote);
        } else if (local && remote) {
          if (local.isFolder && remote.isFolder) continue;
          await preserveConflict(config.localPath, remotePath);
          await pullRemote(config, config.localPath, remotePath, remote);
          if (local.isFolder || remote.isFolder) handledPrefixes.push(remotePath);
        }
      } else if (localChanged) {
        if (local) {
          await pushLocal(config, config.localPath, remotePath, local, remote);
        } else if (remote) {
          await deleteRemote(config, remotePath);
          if (remote.isFolder) handledPrefixes.push(remotePath);
        }
      } else if (remoteChanged) {
        if (remote) {
          await pullRemote(config, config.localPath, remotePath, remote);
        } else if (local) {
          await deleteLocal(config.localPath, remotePath);
          if (local.isFolder) handledPrefixes.push(remotePath);
        }
      }
    }

    const [finalRemote, finalLocal] = await Promise.all([fetchManifest(config), scanLocal(config.localPath)]);
    const finalEntries = {};
    for (const remotePath of new Set([...finalRemote.keys(), ...finalLocal.keys()])) {
      const local = finalLocal.get(remotePath);
      const remote = finalRemote.get(remotePath);
      if (local && remote) {
        finalEntries[remotePath] = {
          localSignature: local.signature,
          remoteVersion: remoteVersion(remote),
          isFolder: local.isFolder,
        };
      }
    }
    await fs.writeFile(statePath(), JSON.stringify({ entries: finalEntries }, null, 2), "utf8");
    log("同期が完了しました。");
    return { ok: true, message: "同期が完了しました。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "同期に失敗しました。";
    log(message, "error");
    return { ok: false, message };
  } finally {
    syncRunning = false;
  }
}

async function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(async () => {
    const current = await loadConfig();
    if (decryptToken(current.encryptedToken)) void syncNow();
  }, SYNC_INTERVAL_MS);
}

function createSetupWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 510,
    resizable: false,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", async () => {
    mainWindow = null;
    const config = await loadConfig();
    if (!decryptToken(config.encryptedToken)) app.quit();
  });
}

ipcMain.handle("get-config", async () => {
  const config = await loadConfig();
  return { ...config, encryptedToken: undefined, loggedIn: Boolean(decryptToken(config.encryptedToken)) };
});

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("setup", async (_event, values) => {
  const config = await loadConfig();
  const serverUrl = normalizeServerUrl(values.serverUrl);
  const localPath = path.resolve(values.localPath);
  const response = await fetch(endpoint({ serverUrl }, "login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountName: values.accountName,
      password: values.password,
      clientName: `${APP_NAME} (${os.hostname()})`,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "ログインに失敗しました。");
  if (config.serverUrl !== serverUrl || config.accountName !== body.accountName || config.localPath !== localPath) {
    await fs.rm(statePath(), { force: true });
  }
  await fs.mkdir(localPath, { recursive: true });
  await saveConfig({
    ...config,
    serverUrl,
    localPath,
    accountName: body.accountName,
    encryptedToken: encryptToken(body.token),
  });
  await scheduleSync();
  void syncNow();
  await shell.openPath(localPath);
  mainWindow.close();
  return { ok: true };
});

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  const config = await loadConfig();
  if (process.argv.includes("--setup") || !decryptToken(config.encryptedToken)) {
    createSetupWindow();
  } else {
    await fs.mkdir(config.localPath, { recursive: true });
    await shell.openPath(config.localPath);
    void syncNow();
  }
  await scheduleSync();
});

app.on("second-instance", async (_event, commandLine) => {
  const config = await loadConfig();
  if (commandLine.includes("--setup")) {
    if (!mainWindow || mainWindow.isDestroyed()) createSetupWindow();
    mainWindow.show();
    mainWindow.focus();
  } else {
    await shell.openPath(config.localPath);
  }
});

app.on("window-all-closed", () => {});
