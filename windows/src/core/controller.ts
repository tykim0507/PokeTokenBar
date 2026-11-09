import { join } from "node:path";
import { creditUsage, advance, threshold } from "./growth";
import {
  freshState,
  defaultSettings,
  stateSchema,
  settingsSchema,
  type State,
  type Settings,
  type View,
  type Line,
  type UsageSnapshot,
} from "./model";
import { JsonStore } from "./storage";
import { PokemonClient } from "./pokemon";
import { type UsageProvider } from "./scanner";

export class Controller {
  private state = freshState();
  settings = defaultSettings();
  private usage: UsageSnapshot[] = [];
  private updatedAt: string | null = null;
  private error: string | null = null;
  private sprite: string | null = null;
  private refreshTask: Promise<void> | null = null;
  private saveTask: Promise<void> = Promise.resolve();
  private stateStore: JsonStore<State>;
  private settingsStore: JsonStore<Settings>;
  readonly pokemon: PokemonClient;
  onChange: () => void = () => {};
  onEvents: (events: string[]) => void = () => {};
  constructor(
    directory: string,
    private sources: UsageProvider[],
    pokemon?: PokemonClient,
  ) {
    this.stateStore = new JsonStore(
      join(directory, "companion.json"),
      stateSchema,
      freshState,
    );
    this.settingsStore = new JsonStore(
      join(directory, "settings.json"),
      settingsSchema,
      defaultSettings,
    );
    this.pokemon = pokemon ?? new PokemonClient(join(directory, "cache"));
  }
  async load(): Promise<void> {
    this.state = await this.stateStore.load();
    this.settings = await this.settingsStore.load();
  }
  view(): View {
    return structuredClone({
      state: this.state,
      settings: this.settings,
      usage: this.usage,
      updatedAt: this.updatedAt,
      error: this.error,
      sprite: this.sprite,
      threshold: threshold(this.state, this.settings.difficulty),
    });
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.saveTask = this.saveTask
      .catch(() => {})
      .then(() => this.stateStore.save(snapshot));
    return this.saveTask;
  }
  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.scan().finally(() => {
      this.refreshTask = null;
    });
    return this.refreshTask;
  }
  private async scan(): Promise<void> {
    try {
      this.usage = await Promise.all(
        this.sources.map((s) => s.scan(this.settings)),
      );
      creditUsage(this.state, this.usage);
      await this.persist(); // Save earned tokens before any network request.
      this.updatedAt = new Date().toISOString();
      this.error = this.usage.flatMap((s) => s.errors).join("\n") || null;
      this.onChange();
      let line: Line | null = null;
      if (
        !this.state.active &&
        this.state.eggTokens >= threshold(this.state, this.settings.difficulty)
      )
        line = await this.pokemon.chooseLine();
      const events = advance(this.state, this.settings.difficulty, line);
      await this.persist();
      const active = this.state.active;
      this.sprite = active
        ? await this.pokemon.sprite(
            active.line.forms[active.stage]!.id,
            active.shiny,
          )
        : null;
      if (events.length) this.onEvents(events);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Refresh failed";
    }
    this.onChange();
  }
  async setSettings(value: unknown): Promise<void> {
    if (this.refreshTask) await this.refreshTask;
    const parsed = settingsSchema.parse(value);
    await this.settingsStore.save(parsed);
    this.settings = parsed;
    this.onChange();
  }
  async exportState(): Promise<State> {
    if (this.refreshTask) await this.refreshTask;
    await this.saveTask;
    return structuredClone(this.state);
  }
  async importState(value: unknown): Promise<void> {
    const imported = stateSchema.parse(value);
    if (this.refreshTask) await this.refreshTask;
    // Rebase on this machine before accepting new usage; an imported save isn't an XP replay.
    imported.initialized = false;
    imported.claimed = {};
    const snapshots = await Promise.all(
      this.sources.map((s) => s.scan(this.settings)),
    );
    if (snapshots.some((s) => s.errors.length))
      throw new Error("Fix scan folder errors before importing a save.");
    creditUsage(imported, snapshots);
    await this.stateStore.save(imported);
    this.state = imported;
    await this.refresh();
  }
  async collectionSprite(id: unknown, shiny: unknown): Promise<string | null> {
    if (
      typeof id !== "number" ||
      typeof shiny !== "boolean" ||
      !this.state.dex.some((d) => d.id === id && d.shiny === shiny)
    )
      return null;
    return this.pokemon.sprite(id, shiny);
  }
  async close(): Promise<void> {
    if (this.refreshTask) await this.refreshTask;
    await this.saveTask;
  }
}
