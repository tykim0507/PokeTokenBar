import { _electron as electron, expect } from "@playwright/test";
import { resolve } from "node:path";
const app = await electron.launch({
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
  console.log(
    "Packaged Windows app launched; preload IPC, renderer sandbox, and initial scan passed.",
  );
} finally {
  await app.close();
}
