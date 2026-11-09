import { mkdir, readFile, rename, writeFile, copyFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export async function atomicWrite(
  file: string,
  data: string | Buffer,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
}
export class JsonStore<T> {
  constructor(
    readonly file: string,
    private schema: z.ZodType<T>,
    private initial: () => T,
  ) {}
  async load(): Promise<T> {
    try {
      return this.schema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.initial();
      try {
        return this.schema.parse(
          JSON.parse(await readFile(`${this.file}.bak`, "utf8")),
        );
      } catch {
        throw new Error(
          `Cannot read saved data: ${this.file}. Keep the file and restore a valid backup.`,
        );
      }
    }
  }
  async save(value: T): Promise<void> {
    this.schema.parse(value);
    // Only rotate a validated save into the backup; a damaged file must not replace it.
    try {
      this.schema.parse(JSON.parse(await readFile(this.file, "utf8")));
      await copyFile(this.file, `${this.file}.bak`);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && error.name === "ZodError")
      )
        throw error;
    }
    await atomicWrite(this.file, JSON.stringify(value, null, 2));
  }
}
