import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop shell, real log growth, persistence, settings and renderer isolation", async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), "ptb-desktop-"));
  const sessions = join(profile, "home", ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(profile, "data"), { recursive: true });
  const event = (input: number, total: number) =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: input,
            output_tokens: 0,
            total_tokens: input,
          },
          total_token_usage: {
            input_tokens: total,
            output_tokens: 0,
            total_tokens: total,
          },
        },
      },
    }) + "\n";
  const file = join(sessions, "sample.jsonl");
  await writeFile(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "demo-session" } }) +
      "\n" +
      event(2_000_000, 2_000_000),
  );
  await writeFile(
    join(profile, "data", "companion.json"),
    JSON.stringify({
      version: 1,
      initialized: false,
      lifetime: 2_500_000,
      eggTokens: 2_500_000,
      claimed: {},
      active: null,
      dex: [],
      graduates: 0,
    }),
  );
  const launchEnv = { ...process.env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      args: [resolve("."), `--test-profile=${profile}`],
      env: launchEnv,
    });
  let application = await launch();
  try {
    await expect
      .poll(() =>
        application.windows().some((p) => p.url().endsWith("/index.html")),
      )
      .toBe(true);
    const window = application
      .windows()
      .find((p) => p.url().endsWith("/index.html"))!;
    await expect(
      window.getByRole("heading", { name: "Your coding companion." }),
    ).toBeVisible();
    await expect(window.locator("#today-tokens")).toHaveText("2M");
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.companion.view())).state
            .eggTokens,
      )
      .toBe(2_500_000);
    expect(
      await window.evaluate(() => ({
        require: typeof (window as any).require,
        process: typeof (window as any).process,
      })),
    ).toEqual({ require: "undefined", process: "undefined" });
    await appendFile(file, event(100_000, 2_100_000));
    await window.getByRole("button", { name: "Refresh", exact: false }).click();
    await expect(window.locator("#today-tokens")).toHaveText("2.1M");
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.companion.view())).state
            .eggTokens,
      )
      .toBe(2_600_000);
    await window.screenshot({
      path: testInfo.outputPath("companion.png"),
      fullPage: true,
    });
    await window.getByRole("button", { name: "Pokédex", exact: false }).click();
    await expect(
      window.getByRole("heading", { name: "Your story starts with an egg." }),
    ).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("pokedex.png") });
    await window
      .getByRole("button", { name: "Settings", exact: false })
      .click();
    await expect(
      window.getByRole("heading", { name: "Your rhythm. Your rules." }),
    ).toBeVisible();
    await window.screenshot({
      path: testInfo.outputPath("settings.png"),
      fullPage: true,
    });
    await window
      .getByLabel("Floating desktop companion", { exact: false })
      .uncheck();
    await expect.poll(async () => application.windows().length).toBe(1);
    await window.getByLabel("Growth pace").selectOption("2");
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.companion.view())).settings
            .difficulty,
      )
      .toBe(2);
    await application.close();
    expect(
      JSON.parse(
        await readFile(join(profile, "data", "companion.json"), "utf8"),
      ).eggTokens,
    ).toBe(2_600_000);
    application = await launch();
    const restored = await application.firstWindow();
    await expect(restored.locator("#today-tokens")).toHaveText("2.1M");
    expect(
      (await restored.evaluate(() => window.companion.view())).state.eggTokens,
    ).toBe(2_600_000);
    expect(
      (await restored.evaluate(() => window.companion.view())).settings
        .floatingPet,
    ).toBe(false);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.close();
    });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isVisible(),
      ),
    ).toBe(false);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
