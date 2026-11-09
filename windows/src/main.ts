import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
} from "electron";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Controller } from "./core/controller";
import { providers } from "./core/scanner";
import { settingsSchema, localDay } from "./core/model";
import { atomicWrite } from "./core/storage";

const testProfile = !app.isPackaged
  ? process.argv
      .find((a) => a.startsWith("--test-profile="))
      ?.slice("--test-profile=".length)
  : undefined;
if (testProfile) app.setPath("userData", resolve(testProfile, "data"));
let controller: Controller;
let main: BrowserWindow | null = null,
  pet: BrowserWindow | null = null,
  tray: Tray | null = null;
let quitting = false,
  drained = false,
  timer: NodeJS.Timeout | undefined;
let actionQueue: Promise<unknown> = Promise.resolve();
const html = join(__dirname, "index.html");
const compact = (n: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
function secure(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-attach-webview", (e) => e.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
}
function showMain(): void {
  if (main) {
    main.show();
    main.focus();
    return;
  }
  main = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 780,
    minHeight: 600,
    show: false,
    title: "PokeTokenBar Windows",
    backgroundColor: "#f5f4ee",
    autoHideMenuBar: true,
    icon: join(app.getAppPath(), "resources/icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  secure(main);
  main.once("ready-to-show", () => main?.show());
  main.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      main?.hide();
    }
  });
  main.on("closed", () => {
    main = null;
  });
  void main.loadFile(html);
}
function syncPet(): void {
  if (!controller.settings.floatingPet) {
    pet?.destroy();
    pet = null;
    return;
  }
  if (pet) return;
  const saved = controller.settings.petPosition;
  const area = screen.getPrimaryDisplay().workArea;
  const position =
    saved &&
    screen
      .getAllDisplays()
      .some(
        (d) =>
          saved.x >= d.workArea.x &&
          saved.x + 160 <= d.workArea.x + d.workArea.width &&
          saved.y >= d.workArea.y &&
          saved.y + 190 <= d.workArea.y + d.workArea.height,
      )
      ? saved
      : { x: area.x + area.width - 190, y: area.y + area.height - 230 };
  pet = new BrowserWindow({
    ...position,
    width: 160,
    height: 190,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  secure(pet);
  pet.once("ready-to-show", () => pet?.showInactive());
  pet.on("closed", () => {
    pet = null;
  });
  pet.webContents.on("context-menu", () =>
    Menu.buildFromTemplate([
      { label: "Open PokeTokenBar", click: showMain },
      {
        label: "Hide companion",
        click: () => {
          void enqueue(async () => {
            await controller.setSettings({
              ...controller.settings,
              floatingPet: false,
            });
            syncPet();
          });
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]).popup(),
  );
  let moveTimer: NodeJS.Timeout | undefined;
  pet.on("moved", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!pet || quitting) return;
      const [x, y] = pet.getPosition();
      void enqueue(() =>
        controller.setSettings({
          ...controller.settings,
          petPosition: { x, y },
        }),
      );
    }, 500);
  });
  void pet.loadFile(html, { query: { pet: "1" } });
}
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const task = actionQueue.catch(() => {}).then(work);
  actionQueue = task;
  return task;
}
function publish(): void {
  const view = controller.view();
  for (const window of [main, pet])
    if (window && !window.isDestroyed())
      window.webContents.send("companion:changed", view);
  const total = view.usage.reduce(
    (sum, s) => sum + (s.daily[localDay()] ?? 0),
    0,
  );
  tray?.setToolTip(`PokeTokenBar · ${compact(total)} tokens today`);
}
function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      ![main?.webContents, pet?.webContents].includes(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Untrusted window");
    try {
      if (fileURLToPath(event.senderFrame!.url) !== html) throw new Error();
    } catch {
      throw new Error("Untrusted page");
    }
    return fn(...args);
  });
}
async function start(): Promise<void> {
  app.setAppUserModelId("io.github.tykim0507.poketokenbar.windows");
  controller = new Controller(
    app.getPath("userData"),
    testProfile ? providers(join(testProfile, "home"), {}) : providers(),
  );
  await controller.load();
  controller.onChange = publish;
  controller.onEvents = (events) => {
    if (!testProfile && Notification.isSupported())
      new Notification({
        title: "Your companion grew!",
        body: events.join("\n"),
      }).show();
  };
  handle("companion:sprite", (id, shiny) =>
    controller.collectionSprite(id, shiny),
  );
  handle("companion:view", () => controller.view());
  handle("companion:refresh", () => enqueue(() => controller.refresh()));
  handle("companion:show", () => showMain());
  handle("companion:settings", (value) =>
    enqueue(async () => {
      const settings = settingsSchema.parse(value);
      if (process.platform === "win32" && !testProfile)
        app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
      await controller.setSettings(settings);
      syncPet();
      await controller.refresh();
    }),
  );
  handle("companion:add-folder", (provider) =>
    enqueue(async () => {
      if (provider !== "codex" && provider !== "claude")
        throw new Error("Unknown provider");
      const result = await dialog.showOpenDialog(main!, {
        title: `Add ${provider} log folder`,
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return;
      const settings = structuredClone(controller.settings);
      settings.extraRoots[provider] = [
        ...new Set([...settings.extraRoots[provider], result.filePaths[0]]),
      ];
      await controller.setSettings(settings);
      await controller.refresh();
    }),
  );
  handle("companion:export", () =>
    enqueue(async () => {
      const result = await dialog.showSaveDialog(main!, {
        defaultPath: `poketokenbar-save-${localDay()}.json`,
        filters: [{ name: "PokeTokenBar Windows save", extensions: ["json"] }],
      });
      if (result.filePath)
        await atomicWrite(
          result.filePath,
          JSON.stringify(await controller.exportState(), null, 2),
        );
    }),
  );
  handle("companion:import", () =>
    enqueue(async () => {
      const result = await dialog.showOpenDialog(main!, {
        properties: ["openFile"],
        filters: [{ name: "PokeTokenBar Windows save", extensions: ["json"] }],
      });
      const file = result.filePaths[0];
      if (result.canceled || !file) return;
      if ((await stat(file)).size > 2_000_000)
        throw new Error("Save file is too large");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      const answer = await dialog.showMessageBox(main!, {
        type: "question",
        message:
          "Replace your companion and collection with this Windows save?",
        detail:
          "Your previous valid save is kept as companion.json.bak. Usage is rebased on this computer.",
        buttons: ["Cancel", "Import"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 1) await controller.importState(value);
    }),
  );
  tray = new Tray(
    nativeImage.createFromPath(join(app.getAppPath(), "resources/icon.png")),
  );
  tray.setToolTip("PokeTokenBar");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open PokeTokenBar", click: showMain },
      {
        label: "Refresh usage",
        click: () => {
          void enqueue(() => controller.refresh());
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showMain);
  showMain();
  syncPet();
  void enqueue(() => controller.refresh());
  timer = setInterval(() => {
    void enqueue(() => controller.refresh());
  }, 30_000);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (controller) showMain();
  });
  app.on("activate", () => {
    if (controller) showMain();
  });
  app.on("window-all-closed", () => {
    /* Tray remains available. */
  });
  app.on("before-quit", (event) => {
    quitting = true;
    clearInterval(timer);
    if (!drained && controller) {
      event.preventDefault();
      void actionQueue
        .catch(() => {})
        .then(() => controller.close())
        .finally(() => {
          drained = true;
          tray?.destroy();
          app.quit();
        });
    }
  });
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("PokeTokenBar could not start", String(error));
      drained = true;
      app.quit();
    });
}
