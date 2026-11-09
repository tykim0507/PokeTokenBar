import type { View } from "./core/model";
export interface Bridge {
  view(): Promise<View>;
  refresh(): Promise<void>;
  settings(value: unknown): Promise<void>;
  addFolder(provider: "codex" | "claude"): Promise<void>;
  exportSave(): Promise<void>;
  importSave(): Promise<void>;
  show(): Promise<void>;
  sprite(id: number, shiny: boolean): Promise<string | null>;
  subscribe(callback: (view: View) => void): () => void;
}
declare global {
  interface Window {
    companion: Bridge;
  }
}
