const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
} = require("electron");
const { fork, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { sameOrigin, safeExternal, executablePath } = require("./policy.cjs");

app.setName("Ai-FormaDesk");
if (process.env.FORMA_DESKTOP_TEST_HOME)
  app.setPath("userData", path.resolve(process.env.FORMA_DESKTOP_TEST_HOME));
const single = app.requestSingleInstanceLock();
let win,
  child,
  origin,
  quitting = false,
  stopped = false,
  startError = "",
  log;
const token = randomBytes(32).toString("hex");
const configFile = () =>
  path.join(app.getPath("userData"), "desktop-settings.json");
function settings() {
  if (!fs.existsSync(configFile())) return {};
  const v = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  for (const key of ["dataDir", "blender", "codex", "mcpRuntime"]) {
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "string" || !path.isAbsolute(v[key]))
    )
      throw new Error(`桌面设置 ${key} 必须是绝对路径。`);
  }
  return v;
}
function saveSettings(v) {
  const target = configFile();
  fs.writeFileSync(target + ".tmp", JSON.stringify(v, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(target + ".tmp", target);
}
function dataDirectory() {
  return settings().dataDir || path.join(app.getPath("userData"), "data");
}
function loading() {
  const html =
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{margin:0;background:#f7f8f5;color:#213a31;font:16px -apple-system;display:grid;place-content:center;height:100vh;text-align:center}h1{font-size:32px;letter-spacing:-1px}p{color:#718079}</style><h1>FormaDesk</h1><p>正在打开你的造物工作台…</p>';
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    title: "Ai-FormaDesk",
    backgroundColor: "#f7f8f5",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "forma-desktop",
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = undefined;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (origin && sameOrigin(url, origin)) return;
    event.preventDefault();
    if (safeExternal(url)) void shell.openExternal(url);
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", () => {
    if (!quitting)
      dialog.showErrorBox(
        "界面进程已停止",
        "请使用“视图 → 重新载入”。已保存作品仍在本地数据目录中。",
      );
  });
  void win.loadURL(origin || loading());
}
function configureSession() {
  const s = session.fromPartition("forma-desktop");
  s.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  s.setPermissionCheckHandler(() => false);
  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (origin && sameOrigin(details.url, origin))
      headers["X-Forma-Desktop"] = token;
    callback({ requestHeaders: headers });
  });
  s.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      title: "保存导出文件",
      defaultPath: path.join(
        app.getPath("downloads"),
        path.basename(item.getFilename()),
      ),
    });
    item.once("done", (_e, state) => {
      if (state === "interrupted" && !quitting)
        dialog.showErrorBox(
          "下载未完成",
          "请检查保存位置和磁盘空间，再次导出。",
        );
    });
  });
}
async function pickSetting(key, title, directory) {
  if (!win) createWindow();
  const choice = await dialog.showOpenDialog(win, {
    title,
    properties: directory ? ["openDirectory"] : ["openFile"],
    ...(key === "blender"
      ? { filters: [{ name: "Blender 应用", extensions: ["app"] }] }
      : {}),
  });
  if (choice.canceled) return;
  let chosen = choice.filePaths[0];
  if (key === "blender" && chosen.endsWith(".app"))
    chosen = path.join(chosen, "Contents/MacOS/Blender");
  if (!directory) fs.accessSync(chosen, fs.constants.X_OK);
  if (key === "dataDir" && !fs.existsSync(path.join(chosen, "index.sqlite")))
    throw new Error(
      "所选目录没有 index.sqlite。请选择原工作台的 data 文件夹。",
    );
  if (key === "mcpRuntime" && !fs.existsSync(path.join(chosen, "runtime.json")))
    throw new Error(
      "所选目录没有 runtime.json。请选择已安装的 Blender MCP 运行时目录。",
    );
  const v = settings();
  v[key] = chosen;
  saveSettings(v);
  await dialog.showMessageBox(win, {
    message: "设置已保存",
    detail: "退出后重新打开应用生效。现有作品文件不会被移动或删除。",
    buttons: ["知道了"],
  });
}
function menu() {
  const pick = (...args) => {
    void pickSetting(...args).catch((e) =>
      dialog.showErrorBox("设置失败", e.message),
    );
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Ai-FormaDesk",
        submenu: [
          { role: "about", label: "关于 Ai-FormaDesk" },
          { type: "separator" },
          {
            label: "打开作品数据文件夹",
            click: () => void shell.openPath(dataDirectory()),
          },
          {
            label: "打开应用日志文件夹",
            click: () => void shell.openPath(app.getPath("logs")),
          },
          { type: "separator" },
          {
            label: "设置 Blender 应用…",
            click: () => pick("blender", "选择 Blender 4.5 LTS 应用", false),
          },
          {
            label: "设置 Codex 可执行文件…",
            click: () =>
              pick("codex", "选择已安装的 Codex CLI 可执行文件", false),
          },
          {
            label: "使用现有作品数据文件夹…",
            click: () =>
              pick(
                "dataDir",
                "选择包含 index.sqlite 的 data 文件夹（先退出旧工作台）",
                true,
              ),
          },
          {
            label: "设置 Blender MCP 运行时…",
            click: () =>
              pick(
                "mcpRuntime",
                "选择包含 runtime.json 的 Blender MCP 运行时文件夹",
                true,
              ),
          },
          { type: "separator" },
          { role: "hide", label: "隐藏 Ai-FormaDesk" },
          { role: "hideOthers", label: "隐藏其他应用" },
          { role: "unhide", label: "显示全部" },
          { type: "separator" },
          { role: "quit", label: "退出 Ai-FormaDesk" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新载入" },
          { role: "togglefullscreen", label: "进入 / 退出全屏" },
          ...(!app.isPackaged
            ? [{ role: "toggleDevTools", label: "开发者工具" }]
            : []),
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize", label: "最小化" },
          { role: "zoom", label: "缩放" },
          {
            label: "显示工作台",
            click: () => {
              if (!win) createWindow();
              win.show();
            },
          },
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "使用文档",
            click: () =>
              void shell.openExternal(
                "https://github.com/damingishere-coder/Ai-FormaDesk#readme",
              ),
          },
          {
            label: "反馈问题",
            click: () =>
              void shell.openExternal(
                "https://github.com/damingishere-coder/Ai-FormaDesk/issues",
              ),
          },
        ],
      },
    ]),
  );
}
function assertDataUnused(dir) {
  const db = path.join(dir, "index.sqlite");
  if (!fs.existsSync(db)) return;
  try {
    const pids = execFileSync("/usr/sbin/lsof", ["-t", db], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (pids)
      throw new Error(
        "这个数据目录正在被另一个工作台使用。请先退出旧工作台或在应用菜单选择另一数据目录，再重新启动。",
      );
  } catch (e) {
    if (e.status !== 1) throw e;
  }
}
async function startBackend() {
  const runtime = app.isPackaged
    ? path.join(process.resourcesPath, "runtime")
    : path.resolve(__dirname, "../build/desktop-runtime");
  const v = settings(),
    dataDir = dataDirectory();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  assertDataUnused(dataDir);
  log = fs.createWriteStream(path.join(app.getPath("logs"), "backend.log"), {
    flags: "w",
    mode: 0o600,
  });
  const env = {
    ...process.env,
    PATH: executablePath(),
    NODE_ENV: "production",
    ZAOWU_DATA_DIR: dataDir,
    ZAOWU_PORT: "0",
    ZAOWU_WEB_DIR: path.join(runtime, "dist"),
    ZAOWU_DESKTOP_TOKEN: token,
    ZAOWU_MCP_RUNTIME:
      v.mcpRuntime || path.join(dataDir, "blender-mcp-runtime"),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  if (v.blender) env.ZAOWU_BLENDER = v.blender;
  if (v.codex) env.ZAOWU_CODEX = v.codex;
  child = fork(path.join(runtime, "server/index.mjs"), [], {
    execPath: path.join(runtime, "bin/node"),
    execArgv: [],
    cwd: runtime,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.on("data", (b) => {
    startError = (startError + b.toString()).slice(-3000);
    log.write(b);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("本地后台启动超时。请从应用菜单打开日志查看详情。")),
      30000,
    );
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!origin)
        reject(new Error(startError || `本地后台已退出（${code}）。`));
      else if (!quitting) {
        dialog.showErrorBox(
          "本地后台已停止",
          "请退出并重新打开应用。已保存作品不会丢失。\n" + startError,
        );
        app.quit();
      }
    });
    child.on("message", (message) => {
      if (
        message?.type !== "forma-ready" ||
        !Number.isInteger(message.port) ||
        message.port < 1 ||
        message.port > 65535
      )
        return;
      clearTimeout(timer);
      origin = `http://127.0.0.1:${message.port}`;
      resolve();
    });
  });
  if (win) await win.loadURL(origin);
}
async function stopBackend() {
  const p = child;
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve();
    }, 10000);
    p.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (p.connected) p.send({ type: "forma-stop" });
    else p.kill("SIGTERM");
  });
}
if (!single) app.quit();
else {
  app.on("second-instance", () => {
    if (!win) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on("activate", () => {
    if (!win) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (win) win.destroy();
    void stopBackend().finally(() => {
      stopped = true;
      log?.end();
      app.quit();
    });
  });
  app
    .whenReady()
    .then(async () => {
      fs.mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
      app.setAppLogsPath();
      fs.mkdirSync(app.getPath("logs"), { recursive: true });
      app.setAboutPanelOptions({
        applicationName: "Ai-FormaDesk",
        applicationVersion: app.getVersion(),
        copyright: "A local workspace for shaping ideas.",
        iconPath: app.isPackaged
          ? path.join(process.resourcesPath, "icon.png")
          : path.join(__dirname, "assets/icon.png"),
      });
      configureSession();
      menu();
      createWindow();
      try {
        await startBackend();
      } catch (e) {
        await dialog.showMessageBox(win, {
          type: "error",
          message: "工作台暂时无法启动",
          detail: e.message + "\n可从应用菜单检查路径设置，修正后退出重开。",
          buttons: ["知道了"],
        });
      }
    })
    .catch((e) => {
      dialog.showErrorBox("启动失败", e.message);
      app.quit();
    });
}
