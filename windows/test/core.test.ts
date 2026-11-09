import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CodexParser,
  claudeEvent,
  deduplicate,
  resolveCodex,
} from "../src/core/usage";
import { jsonLines, LogProvider, providers } from "../src/core/scanner";
import { creditUsage, advance, threshold } from "../src/core/growth";
import {
  defaultSettings,
  freshState,
  localDay,
  stateSchema,
  settingsSchema,
  type UsageSnapshot,
  type Line,
} from "../src/core/model";
import { JsonStore } from "../src/core/storage";
import { Controller } from "../src/core/controller";
import { PokemonClient } from "../src/core/pokemon";

const now = new Date("2026-09-14T12:00:00");
const meta = (id: string, parent?: string, subagent = false) => ({
  type: "session_meta",
  timestamp: now.toISOString(),
  payload: {
    id,
    forked_from_id: parent,
    ...(subagent ? { source: { subagent: {} } } : {}),
  },
});
const tokens = (
  input: number,
  output: number,
  total: number,
  timestamp = now.toISOString(),
) => ({
  type: "event_msg",
  timestamp,
  payload: {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: Math.floor(input / 2),
        output_tokens: output,
        reasoning_output_tokens: output,
        total_tokens: input + output,
      },
      total_token_usage: {
        input_tokens: total - output,
        output_tokens: output,
        total_tokens: total,
      },
    },
  },
});
const snapshot = (
  amount: number,
  date = now,
  errors: string[] = [],
): UsageSnapshot => ({
  id: "codex",
  name: "Codex",
  files: 1,
  errors,
  daily: { [localDay(date)]: amount },
});
const line: Line = {
  forms: [
    { id: 1, name: "test-first" },
    { id: 2, name: "test-second" },
    { id: 3, name: "test-third" },
  ],
  rarity: "common",
};
async function temporary() {
  return mkdtemp(join(tmpdir(), "ptb-test-"));
}

test("Codex counts cached input and reasoning exactly once; repeated snapshots and archives deduplicate", () => {
  const parser = new CodexParser("one");
  parser.accept(meta("session"));
  parser.accept(tokens(100, 20, 120));
  parser.accept(tokens(100, 20, 120));
  parser.accept(tokens(40, 10, 170));
  assert.equal(
    resolveCodex([parser.result, structuredClone(parser.result)]).reduce(
      (n, e) => n + e.tokens,
      0,
    ),
    170,
  );
});
test("fork replay is excluded but child and subagent work count independently", () => {
  const parent = new CodexParser("parent");
  parent.accept(meta("parent"));
  parent.accept(tokens(100, 20, 120));
  const child = new CodexParser("child");
  child.accept(meta("child", "parent"));
  child.accept(tokens(100, 20, 120));
  child.accept(tokens(50, 10, 180));
  const sub = new CodexParser("sub");
  sub.accept(meta("sub", "missing", true));
  sub.accept(tokens(70, 10, 80));
  assert.equal(
    resolveCodex([parent.result, child.result, sub.result]).reduce(
      (n, e) => n + e.tokens,
      0,
    ),
    260,
  );
});
test("cumulative resets preserve two identical usage vectors in distinct epochs", () => {
  const p = new CodexParser("p");
  p.accept(meta("s"));
  p.accept(tokens(100, 10, 110));
  p.accept(tokens(200, 20, 330));
  p.accept(tokens(100, 10, 110));
  assert.equal(
    resolveCodex([p.result]).reduce((n, e) => n + e.tokens, 0),
    440,
  );
});
test("Claude streaming updates keep maximum total per message across duplicate files", () => {
  const event = (output: number) =>
    claudeEvent({
      type: "assistant",
      timestamp: now.toISOString(),
      requestId: "r",
      message: {
        id: "m",
        usage: {
          input_tokens: 10,
          output_tokens: output,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    })!;
  assert.equal(
    deduplicate([event(5), event(10), event(5)], "maximum")[0]!.tokens,
    140,
  );
  assert.equal(claudeEvent({ type: "user", message: { id: "m" } }), null);
});
test("existing upstream fork fixtures credit only the child suffix, not embedded parent history", async () => {
  const root = resolve(
    "..",
    "Tests",
    "PokeTokenBarTests",
    "Fixtures",
    "CodexFork",
  );
  const logs = [];
  for (const f of ["parent", "child", "sibling"]) {
    const parser = new CodexParser(f);
    for await (const l of jsonLines(join(root, `${f}.jsonl`))) parser.accept(l);
    logs.push(parser.result);
  }
  const combined = resolveCodex(logs);
  assert(combined.length > 0);
  const raw = logs.flatMap((l) => l.events).reduce((n, e) => n + e.tokens, 0);
  assert(combined.reduce((n, e) => n + e.tokens, 0) < raw);
  assert.equal(
    resolveCodex([...logs, ...structuredClone(logs)]).reduce(
      (n, e) => n + e.tokens,
      0,
    ),
    combined.reduce((n, e) => n + e.tokens, 0),
  );
});
test("bounded JSONL reader skips oversized/malformed lines and retries partial writes", async () => {
  const dir = await temporary();
  const file = join(dir, "events.jsonl");
  const valid = JSON.stringify(tokens(12, 3, 15));
  await writeFile(
    file,
    `${"x".repeat(3 * 1024 * 1024)}\n{broken}\n${JSON.stringify(meta("id"))}\n${valid.slice(0, 25)}`,
  );
  const before = [];
  for await (const o of jsonLines(file)) before.push(o);
  assert.equal(before.length, 1);
  await appendFile(file, valid.slice(25) + "\n");
  const after = [];
  for await (const o of jsonLines(file)) after.push(o);
  assert.equal(after.length, 2);
});
test("scanner supports overlapping roots, archival copies, incremental growth and missing explicit roots", async () => {
  const dir = await temporary();
  const sessions = join(dir, "sessions"),
    archive = join(dir, "archive");
  await mkdir(sessions);
  await mkdir(archive);
  const file = join(sessions, "a.jsonl");
  await writeFile(
    file,
    [meta("session"), tokens(10, 2, 12)]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  await copyFile(file, join(archive, "a.jsonl"));
  const settings = defaultSettings();
  settings.extraRoots.codex = [dir, sessions];
  const provider = new LogProvider("codex", "Codex", [sessions, archive]);
  assert.equal((await provider.scan(settings)).daily[localDay(now)], 12);
  await appendFile(file, JSON.stringify(tokens(20, 3, 35)) + "\n");
  assert.equal((await provider.scan(settings)).daily[localDay(now)], 35);
  settings.extraRoots.codex.push(join(dir, "not-present"));
  assert.equal((await provider.scan(settings)).errors.length, 1);
});
test("provider roots honor native Windows home and environment configuration without private paths", () => {
  const settings = defaultSettings();
  const p = providers("/example-home", {
    CODEX_HOME: "/custom-codex",
    CLAUDE_CONFIG_DIR: "/custom-claude",
  });
  assert.deepEqual(p[0]!.roots(settings), [
    resolve("/custom-codex/sessions"),
    resolve("/custom-codex/archived_sessions"),
  ]);
  assert.deepEqual(p[1]!.roots(settings), [resolve("/custom-claude/projects")]);
});
test("growth seeds old usage, credits new usage, survives log disappearance and date rollover", () => {
  const state = freshState();
  assert.equal(creditUsage(state, [snapshot(100)], now), 0);
  assert.equal(creditUsage(state, [snapshot(150)], now), 50);
  assert.equal(creditUsage(state, [snapshot(0)], now), 0);
  assert.equal(creditUsage(state, [snapshot(150)], now), 0);
  assert.equal(
    creditUsage(state, [snapshot(200, now, ["unreadable"])], now),
    0,
  );
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(creditUsage(state, [snapshot(60, tomorrow)], tomorrow), 60);
  assert.equal(creditUsage(state, [snapshot(150)], now), 0);
  assert.equal(state.lifetime, 110);
});
test("growth remains provider agnostic", () => {
  const state = freshState();
  const claude = { ...snapshot(50), id: "claude" as const };
  creditUsage(state, [snapshot(100), claude], now);
  assert.equal(
    creditUsage(
      state,
      [snapshot(200), { ...claude, daily: { [localDay(now)]: 80 } }],
      now,
    ),
    130,
  );
});
test("hatch, evolve and graduate preserve overflow; offline hatching preserves all tokens", () => {
  const state = freshState();
  state.eggTokens = 5_000_000 + 750_000_000 + 25;
  assert.deepEqual(advance(state, 1, null), []);
  assert.equal(state.eggTokens, 755_000_025);
  const events = advance(state, 1, line, () => 0.5, now);
  assert.equal(events.length, 4);
  assert.equal(state.active, null);
  assert.equal(state.graduates, 1);
  assert.equal(state.eggTokens, 25);
  assert.deepEqual(
    state.dex.map((d) => d.id),
    [1, 2, 3],
  );
});
test("growth pace and shiny state persist at the hatch boundary", () => {
  const state = freshState();
  state.eggTokens = 500_000;
  advance(state, 0.1, line, () => 0, now);
  assert.equal(state.active!.shiny, true);
  assert.equal(threshold(state, 0.1), 12_500_000);
  assert.equal(
    stateSchema.parse(JSON.parse(JSON.stringify(state))).active!.shiny,
    true,
  );
});
test("state validation rejects impossible stages, huge counts and malformed imports", () => {
  assert.throws(() => stateSchema.parse({ ...freshState(), lifetime: -1 }));
  assert.throws(() => stateSchema.parse({ ...freshState(), version: 2 }));
  assert.throws(() =>
    settingsSchema.parse({ ...defaultSettings(), difficulty: 0 }),
  );
  const state = freshState();
  state.eggTokens = 5_000_000;
  advance(state, 1, line, () => 0.5, now);
  state.active!.stage = 3;
  assert.throws(() => stateSchema.parse(state));
});
test("atomic store restores a validated backup and does not replace it with corrupt data", async () => {
  const dir = await temporary(),
    file = join(dir, "save.json");
  const store = new JsonStore(file, stateSchema, freshState);
  const state = await store.load();
  await store.save(state);
  state.lifetime = 42;
  await store.save(state);
  await writeFile(file, "not-json");
  assert.equal((await store.load()).lifetime, 0);
  await store.save(state);
  assert.equal(JSON.parse(await readFile(file + ".bak", "utf8")).lifetime, 0);
  await writeFile(file, "bad");
  await writeFile(file + ".bak", "bad");
  await assert.rejects(() => store.load(), /Cannot read saved data/);
});
test("controller persists usage before a failed hatch and rebases imported progress", async () => {
  const dir = await temporary();
  let amount = 0;
  const source = {
    id: "codex" as const,
    name: "Codex",
    roots: () => [],
    scan: async () => snapshot(amount, new Date()),
  };
  class Offline extends PokemonClient {
    override async chooseLine(): Promise<Line> {
      throw new Error("offline");
    }
  }
  const controller = new Controller(
    dir,
    [source],
    new Offline(join(dir, "cache")),
  );
  await controller.load();
  await controller.refresh();
  amount = 5_000_001;
  await controller.refresh();
  assert.equal(controller.view().state.eggTokens, 5_000_001);
  assert.equal(controller.view().error, "offline");
  assert.equal(
    JSON.parse(await readFile(join(dir, "companion.json"), "utf8")).eggTokens,
    5_000_001,
  );
  const imported = freshState();
  imported.lifetime = 100;
  await controller.importState(imported);
  assert.equal(controller.view().state.lifetime, 100);
  amount += 25;
  await controller.refresh();
  assert.equal(controller.view().state.lifetime, 125);
});
test("PokéAPI data is fetched at runtime and cached, and external chain URLs are rejected", async () => {
  const dir = await temporary();
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    return new Response(
      JSON.stringify(
        url.includes("pokemon-species")
          ? {
              id: 1,
              name: "test-first",
              capture_rate: 255,
              is_legendary: false,
              is_mythical: false,
              evolves_from_species: null,
              evolution_chain: {
                url: "https://pokeapi.co/api/v2/evolution-chain/1/",
              },
            }
          : {
              chain: {
                species: {
                  name: "test-first",
                  url: "https://pokeapi.co/api/v2/pokemon-species/1/",
                },
                evolves_to: [],
              },
            },
      ),
      { status: 200 },
    );
  };
  const client = new PokemonClient(dir, fetcher);
  assert.equal((await client.chooseLine(() => 0)).forms[0]!.id, 1);
  assert.equal(calls, 2);
  await client.chooseLine(() => 0);
  assert.equal(calls, 2);
  const malicious = new PokemonClient(
    await temporary(),
    async () =>
      new Response(
        JSON.stringify({
          id: 1,
          name: "test",
          capture_rate: 255,
          is_legendary: false,
          is_mythical: false,
          evolves_from_species: null,
          evolution_chain: { url: "https://example.com/private" },
        }),
      ),
  );
  await assert.rejects(
    () => malicious.chooseLine(() => 0),
    /Unexpected evolution/,
  );
});

test("total-only Codex records keep real deltas but ignore post-replay zero-context totals", () => {
  const parser = new CodexParser("total-only");
  parser.accept(meta("total-only"));
  for (const [last, cumulative] of [
    [40, 40],
    [60, 100],
  ])
    parser.accept({
      type: "event_msg",
      timestamp: now.toISOString(),
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: last },
          total_token_usage: { total_tokens: cumulative },
        },
      },
    });
  assert.equal(
    resolveCodex([parser.result]).reduce((n, e) => n + e.tokens, 0),
    100,
  );
  const reset = new CodexParser("zero-context");
  reset.accept(meta("zero-context"));
  reset.accept({
    type: "event_msg",
    timestamp: now.toISOString(),
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 80 },
        total_token_usage: { input_tokens: 100, total_tokens: 100 },
      },
    },
  });
  assert.equal(resolveCodex([reset.result])[0]!.tokens, 0);
});

test("sprite failures retry and simultaneous requests share a single download", async () => {
  let calls = 0;
  const client = new PokemonClient(await temporary(), async () => {
    calls++;
    if (calls === 1) return new Response("", { status: 503 });
    return new Response("GIF89a-test-image");
  });
  assert.equal(await client.sprite(1, false), null);
  const results = await Promise.all([
    client.sprite(1, false),
    client.sprite(1, false),
  ]);
  assert.equal(calls, 2);
  assert.equal(results[0], results[1]);
  assert.match(results[0]!, /^data:image\/gif;base64,/);
  await client.sprite(1, false);
  assert.equal(calls, 2);
});

test("installer and portable output patterns expand with the actual packager macros", async () => {
  const { expandMacro } = require("app-builder-lib/out/util/macroExpander");
  const config = JSON.parse(await readFile("package.json", "utf8"));
  const names = ["nsis", "portable"].map((target) =>
    expandMacro(
      config.build[target].artifactName,
      "x64",
      { version: config.version },
      { ext: "exe" },
    ),
  );
  assert.deepEqual(names, [
    "PokeTokenBar-Windows-0.1.0-x64-nsis.exe",
    "PokeTokenBar-Windows-0.1.0-x64-portable.exe",
  ]);
});

test("generated installer icon includes small tray sizes and the required 256px image", async () => {
  const ico = await readFile("resources/icon.ico");
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => ico[6 + i * 16] || 256),
    [16, 32, 48, 256],
  );
  for (let i = 0; i < 4; i++) {
    const offset = ico.readUInt32LE(6 + i * 16 + 12);
    assert.equal(ico.subarray(offset + 1, offset + 4).toString(), "PNG");
  }
});
