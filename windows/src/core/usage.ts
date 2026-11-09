import { type UsageEvent, tokenCount } from "./model";

type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined;
const vector = (value: unknown) => {
  const v = object(value);
  return [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ].map((k) => tokenCount(v[k]));
};
export interface CodexEvent extends UsageEvent {
  signature: string | null;
  cumulative: number[] | null;
  owner: string;
}
export interface ParsedLog {
  session: string;
  parent?: string;
  subagent: boolean;
  events: CodexEvent[];
}
export class CodexParser {
  readonly result: ParsedLog;
  private current = "";
  private previous = "";
  constructor(file: string) {
    this.result = { session: file, subagent: false, events: [] };
  }
  accept(value: unknown): void {
    const o = object(value),
      p = object(o.payload);
    if (o.type === "session_meta") {
      const id = string(p.id) ?? string(p.session_id);
      if (!this.current) {
        this.result.session = id ?? this.result.session;
        this.result.parent =
          string(p.forked_from_id) ?? string(p.parent_thread_id);
        this.result.subagent =
          p.thread_source === "subagent" ||
          object(p.source).subagent !== undefined;
      }
      if (id !== this.current) {
        this.previous = "";
        this.current = id ?? "";
      }
      return;
    }
    if (p.type !== "token_count") return;
    const info = object(p.info),
      last = object(info.last_token_usage);
    if (
      !info.last_token_usage ||
      typeof o.timestamp !== "string" ||
      !Number.isFinite(Date.parse(o.timestamp))
    )
      return;
    // Cached input is already included in Codex input_tokens. Reasoning is included in output.
    let tokens = tokenCount(last.input_tokens) + tokenCount(last.output_tokens);
    const cumulative = info.total_token_usage
      ? vector(info.total_token_usage)
      : null;
    if (
      tokens === 0 &&
      (!cumulative ||
        cumulative.slice(0, 4).every((n) => n === 0) ||
        cumulative[4] === tokenCount(last.total_tokens))
    )
      tokens = tokenCount(last.total_tokens);
    const signature = cumulative
      ? JSON.stringify([cumulative, vector(last)])
      : null;
    if (signature && signature === this.previous) return;
    this.previous = signature ?? "";
    this.result.events.push({
      id: "",
      timestamp: o.timestamp,
      tokens,
      signature,
      cumulative,
      owner: this.current || this.result.session,
    });
  }
}
export function claudeEvent(value: unknown): UsageEvent | null {
  const o = object(value),
    m = object(o.message),
    u = object(m.usage);
  if (
    o.type !== "assistant" ||
    !string(m.id) ||
    typeof o.timestamp !== "string" ||
    !Number.isFinite(Date.parse(o.timestamp)) ||
    !m.usage
  )
    return null;
  return {
    id: `${m.id}|${string(o.requestId) ?? ""}`,
    timestamp: o.timestamp,
    tokens: [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ].reduce((sum, k) => sum + tokenCount(u[k]), 0),
  };
}
/** Mirrors the native reader's parent-prefix comparison and missing-parent fallback.
 * Canonical IDs deduplicate archived, synchronized and overlapping log copies. */
export function resolveCodex(logs: ParsedLog[]): UsageEvent[] {
  const sessions = new Map<string, ParsedLog[]>();
  for (const log of logs)
    sessions.set(log.session, [...(sessions.get(log.session) ?? []), log]);
  const memo = new Map<ParsedLog, CodexEvent[]>();
  const owned: UsageEvent[] = [];
  function resolve(
    log: ParsedLog,
    visiting = new Set<ParsedLog>(),
  ): CodexEvent[] {
    const cached = memo.get(log);
    if (cached) return cached;
    if (visiting.has(log)) return [];
    visiting.add(log);
    let prefix: CodexEvent[] = [];
    if (log.parent) {
      for (const parent of sessions.get(log.parent) ?? []) {
        if (parent === log) continue;
        const history = resolve(parent, visiting);
        let n = 0;
        while (
          n < log.events.length &&
          n < history.length &&
          log.events[n]!.signature &&
          log.events[n]!.signature === history[n]!.signature
        )
          n++;
        if (n > prefix.length) prefix = history.slice(0, n);
      }
    }
    let skip = prefix.length;
    if (log.parent && skip === 0 && !log.subagent && log.events.length) {
      skip = 1;
      while (
        skip < log.events.length &&
        Date.parse(log.events[skip]!.timestamp) -
          Date.parse(log.events[skip - 1]!.timestamp) <
          1000
      )
        skip++;
    }
    const history = [...prefix];
    let epoch = 0;
    let previous: number[] | null = null;
    let previousOwner = "";
    for (const [index, event] of log.events.slice(skip).entries()) {
      const owner = log.parent ? log.session : event.owner;
      if (owner !== previousOwner) {
        epoch = 0;
        previous = null;
        previousOwner = owner;
      }
      if (
        event.cumulative &&
        previous &&
        event.cumulative.some((v, i) => v < previous![i]!)
      )
        epoch++;
      previous = event.cumulative;
      const id = `${owner}|${epoch}|${event.signature ?? `${event.timestamp}|${index}`}`;
      const resolved = { ...event, id };
      owned.push(resolved);
      history.push(resolved);
    }
    visiting.delete(log);
    memo.set(log, history);
    return history;
  }
  for (const log of logs) resolve(log);
  return deduplicate(owned, "earliest");
}
export function deduplicate(
  events: UsageEvent[],
  policy: "maximum" | "earliest",
): UsageEvent[] {
  const unique = new Map<string, UsageEvent>();
  for (const event of events) {
    const previous = unique.get(event.id);
    if (
      !previous ||
      (policy === "maximum"
        ? event.tokens > previous.tokens
        : event.timestamp < previous.timestamp)
    )
      unique.set(event.id, event);
  }
  return [...unique.values()];
}
