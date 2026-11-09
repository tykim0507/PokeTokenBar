import { type State, type Line, type UsageSnapshot, localDay } from "./model";

const totals = {
  common: 750_000_000,
  uncommon: 1_875_000_000,
  rare: 3_000_000_000,
  legendary: 6_000_000_000,
};
export function threshold(state: State, difficulty: number): number {
  const a = state.active;
  return Math.max(
    1,
    Math.round(
      (a
        ? (totals[a.line.rarity] * (a.stage + 1)) /
          ((a.line.forms.length * (a.line.forms.length + 1)) / 2)
        : 5_000_000) * difficulty,
    ),
  );
}
/** First launch seeds today's usage. Subsequent observations only credit new tokens.
 * Keep high-water marks when logs vanish; restoring the same logs cannot award twice. */
export function creditUsage(
  state: State,
  snapshots: UsageSnapshot[],
  now = new Date(),
): number {
  const day = localDay(now);
  let delta = 0;
  for (const snapshot of snapshots) {
    if (snapshot.errors.length) continue; // incomplete scans must not advance a baseline
    const amount = snapshot.daily[day] ?? 0;
    const ledger = state.claimed[snapshot.id];
    if (!state.initialized || !ledger) {
      state.claimed[snapshot.id] = { [day]: amount };
      continue;
    }
    const previous = ledger[day] ?? 0;
    delta += Math.max(0, amount - previous);
    ledger[day] = Math.max(previous, amount);
    const days = Object.keys(ledger).sort();
    for (const old of days.slice(0, -35)) delete ledger[old];
  }
  if (snapshots.some((s) => s.errors.length === 0)) state.initialized = true;
  state.lifetime += delta;
  if (state.active) state.active.xp += delta;
  else state.eggTokens += delta;
  return delta;
}
function register(state: State, now: Date): void {
  const a = state.active!;
  const form = a.line.forms[a.stage]!;
  const entry = state.dex.find((d) => d.id === form.id && d.shiny === a.shiny);
  if (entry) entry.count += 1;
  else
    state.dex.push({
      ...form,
      shiny: a.shiny,
      count: 1,
      firstSeen: now.toISOString(),
    });
}
/** Async species loading is outside this reducer. If offline, tokens remain in the egg. */
export function advance(
  state: State,
  difficulty: number,
  nextLine: Line | null,
  random = Math.random,
  now = new Date(),
): string[] {
  const events: string[] = [];
  if (
    !state.active &&
    state.eggTokens >= threshold(state, difficulty) &&
    nextLine
  ) {
    const remainder = state.eggTokens - threshold(state, difficulty);
    state.eggTokens = 0;
    state.active = {
      line: nextLine,
      stage: 0,
      xp: remainder,
      shiny: random() < 1 / 4096,
      hatchedAt: now.toISOString(),
    };
    register(state, now);
    events.push(`${state.active.line.forms[0]!.name} hatched!`);
  }
  while (state.active && state.active.xp >= threshold(state, difficulty)) {
    const a = state.active;
    a.xp -= threshold(state, difficulty);
    if (a.stage + 1 < a.line.forms.length) {
      a.stage++;
      register(state, now);
      events.push(`Evolved into ${a.line.forms[a.stage]!.name}!`);
    } else {
      events.push(`${a.line.forms[a.stage]!.name} graduated!`);
      state.eggTokens += a.xp;
      state.active = null;
      state.graduates++;
    }
  }
  return events;
}
