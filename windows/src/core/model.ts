import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const species = z.object({
  id: z.number().int().min(1).max(649),
  name: z.string().min(1).max(100),
});
export const lineSchema = z.object({
  forms: z.array(species).min(1).max(4),
  rarity: z.enum(["common", "uncommon", "rare", "legendary"]),
});
const activeSchema = z
  .object({
    line: lineSchema,
    stage: z.number().int().min(0).max(3),
    xp: count,
    shiny: z.boolean(),
    hatchedAt: z.string().datetime(),
  })
  .refine((a) => a.stage < a.line.forms.length, "Invalid evolution stage");
export const stateSchema = z.object({
  version: z.literal(1),
  initialized: z.boolean(),
  lifetime: count,
  eggTokens: count,
  claimed: z.record(
    z.string().max(100),
    z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count),
  ),
  active: activeSchema.nullable(),
  dex: z
    .array(
      z.object({
        ...species.shape,
        shiny: z.boolean(),
        count: count,
        firstSeen: z.string().datetime(),
      }),
    )
    .max(1298),
  graduates: count,
});
export const settingsSchema = z.object({
  floatingPet: z.boolean().default(true),
  launchAtLogin: z.boolean().default(false),
  difficulty: z.number().min(0.1).max(2).default(1),
  extraRoots: z
    .object({
      codex: z.array(z.string().min(1).max(4096)).max(32),
      claude: z.array(z.string().min(1).max(4096)).max(32),
    })
    .default({ codex: [], claude: [] }),
  petPosition: z
    .object({ x: z.number().int(), y: z.number().int() })
    .optional(),
});
export type State = z.infer<typeof stateSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Line = z.infer<typeof lineSchema>;
export type ProviderID = "codex" | "claude";
export interface UsageEvent {
  id: string;
  timestamp: string;
  tokens: number;
}
export interface UsageSnapshot {
  id: ProviderID;
  name: string;
  daily: Record<string, number>;
  files: number;
  errors: string[];
}
export interface View {
  state: State;
  settings: Settings;
  usage: UsageSnapshot[];
  updatedAt: string | null;
  error: string | null;
  sprite: string | null;
  threshold: number;
}
export const freshState = (): State => ({
  version: 1,
  initialized: false,
  lifetime: 0,
  eggTokens: 0,
  claimed: {},
  active: null,
  dex: [],
  graduates: 0,
});
export const defaultSettings = (): Settings => settingsSchema.parse({});
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
