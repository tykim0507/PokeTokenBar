import { _electron as electron, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const portable = resolve(
  `release/PokeTokenBar-Windows-${version}-x64-portable.exe`,
);
const launchEnv = { ...process.env, PORTABLE_EXECUTABLE_FILE: portable };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  env: launchEnv,
  executablePath: resolve("release/win-unpacked/PokeTokenBar Windows.exe"),
});
try {
  await expect
    .poll(() =>
      app.windows().some((page) => page.url().endsWith("/index.html")),
    )
    .toBe(true);
  const page = app.windows().find((page) => page.url().endsWith("/index.html"));
  await expect(
    page.getByRole("heading", { name: "Your coding companion." }),
  ).toBeVisible();
  await expect(page.locator("#today-tokens")).toHaveText("0");
  const privileges = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  expect(privileges).toEqual({ require: "undefined", process: "undefined" });
  // Exercise the production settings IPC without changing the runner's login registry.
  await app.evaluate(({ app: nativeApp }) => {
    nativeApp.setLoginItemSettings = (settings) => {
      globalThis.observedLoginSettings = settings;
    };
  });
  await page.evaluate(async () => {
    const view = await window.companion.view();
    await window.companion.settings({ ...view.settings, launchAtLogin: true });
  });
  expect(await app.evaluate(() => globalThis.observedLoginSettings)).toEqual({
    openAtLogin: true,
    path: portable,
    args: [],
  });
  await page.evaluate(async () => {
    const view = await window.companion.view();
    await window.companion.settings({ ...view.settings, launchAtLogin: false });
  });
  console.log(
    "Packaged Windows app launched; preload IPC, renderer sandbox, and initial scan passed.",
  );
} finally {
  await app.close();
}
