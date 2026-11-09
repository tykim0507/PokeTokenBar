import { createReadStream } from "node:fs";
import { readdir, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  type ProviderID,
  type Settings,
  type UsageEvent,
  type UsageSnapshot,
  localDay,
} from "./model";
import {
  CodexParser,
  claudeEvent,
  deduplicate,
  resolveCodex,
  type ParsedLog,
} from "./usage";

export interface UsageProvider {
  id: ProviderID;
  name: string;
  roots(settings: Settings): string[];
  scan(settings: Settings): Promise<UsageSnapshot>;
}
/** Bound memory even for tool output encoded as a multi-megabyte JSONL line.
 * Do not accept an unterminated final line while the CLI is still writing it. */
export async function* jsonLines(file: string): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0),
    oversized = false;
  const limit = 2 * 1024 * 1024;
  for await (const chunk of createReadStream(file, {
    highWaterMark: 64 * 1024,
  })) {
    const buffer = chunk as Buffer;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 10) continue;
      if (!oversized && pending.length + i - start <= limit) {
        const line = Buffer.concat([
          pending,
          buffer.subarray(start, i),
        ]).toString("utf8");
        if (
          line.includes("token_count") ||
          line.includes("session_meta") ||
          line.includes('"usage"')
        ) {
          try {
            yield JSON.parse(line);
          } catch {
            /* malformed records do not poison a whole session */
          }
        }
      }
      pending = Buffer.alloc(0);
      oversized = false;
      start = i + 1;
    }
    if (!oversized) {
      if (pending.length + buffer.length - start > limit) {
        oversized = true;
        pending = Buffer.alloc(0);
      } else pending = Buffer.concat([pending, buffer.subarray(start)]);
    }
  }
}
export class LogProvider implements UsageProvider {
  // Cache only token metadata, never prompt bodies. Unchanged files aren't read again.
  private cache = new Map<
    string,
    { stamp: string; log: ParsedLog; events: UsageEvent[] }
  >();
  constructor(
    readonly id: ProviderID,
    readonly name: string,
    private defaults: string[],
  ) {}
  roots(settings: Settings): string[] {
    return [...this.defaults, ...settings.extraRoots[this.id]].map((p) =>
      resolve(p),
    );
  }
  async scan(settings: Settings): Promise<UsageSnapshot> {
    const files = new Set<string>(),
      visited = new Set<string>(),
      errors: string[] = [];
    const walk = async (root: string, optional: boolean): Promise<void> => {
      try {
        const canonical = await realpath(root);
        if (visited.has(canonical)) return;
        visited.add(canonical);
        const entries = await readdir(canonical, { withFileTypes: true });
        for (const entry of entries) {
          const file = join(canonical, entry.name);
          if (entry.isDirectory()) await walk(file, false);
          else if (entry.isFile() && entry.name.endsWith(".jsonl"))
            files.add(file);
          // Never recurse through directory symlinks / junctions (loops and unrelated folders).
        }
      } catch (error) {
        if (!(optional && (error as NodeJS.ErrnoException).code === "ENOENT"))
          errors.push(`Cannot scan ${root}`);
      }
    };
    for (const [index, root] of this.roots(settings).entries())
      await walk(root, index < this.defaults.length);
    const logs: ParsedLog[] = [],
      events: UsageEvent[] = [];
    for (const file of files) {
      try {
        const info = await stat(file);
        const stamp = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
        let cached = this.cache.get(file);
        if (!cached || cached.stamp !== stamp) {
          const parser = new CodexParser(file);
          const parsed: UsageEvent[] = [];
          for await (const line of jsonLines(file)) {
            if (this.id === "codex") parser.accept(line);
            else {
              const event = claudeEvent(line);
              if (event) parsed.push(event);
            }
          }
          cached = { stamp, log: parser.result, events: parsed };
          this.cache.set(file, cached);
        }
        logs.push(cached.log);
        events.push(...cached.events);
      } catch {
        errors.push(`Cannot read ${file}`);
      }
    }
    for (const file of this.cache.keys())
      if (!files.has(file)) this.cache.delete(file);
    const daily: Record<string, number> = {};
    const resolved =
      this.id === "codex" ? resolveCodex(logs) : deduplicate(events, "maximum");
    for (const event of resolved) {
      const day = localDay(new Date(event.timestamp));
      daily[day] = (daily[day] ?? 0) + event.tokens;
    }
    return { id: this.id, name: this.name, daily, files: files.size, errors };
  }
}
export function providers(
  home = homedir(),
  env = process.env,
): UsageProvider[] {
  const codex = env.CODEX_HOME || join(home, ".codex");
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [
    new LogProvider("codex", "Codex", [
      join(codex, "sessions"),
      join(codex, "archived_sessions"),
    ]),
    new LogProvider("claude", "Claude Code", [join(claude, "projects")]),
  ];
}
