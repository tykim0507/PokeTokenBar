import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "./storage";
import { lineSchema, type Line } from "./model";

const reference = z.object({ name: z.string(), url: z.string().url() });
const speciesSchema = z.object({
  id: z.number().int().min(1).max(649),
  name: z.string().max(100),
  capture_rate: z.number().int().min(0).max(255),
  is_legendary: z.boolean(),
  is_mythical: z.boolean(),
  evolves_from_species: reference.nullable(),
  evolution_chain: z.object({ url: z.string().url() }),
});
interface Evolution {
  species: { name: string; url: string };
  evolves_to: Evolution[];
}
const evolutionSchema: z.ZodType<Evolution> = z.lazy(() =>
  z.object({
    species: reference,
    evolves_to: z.array(evolutionSchema).max(16),
  }),
);
function speciesID(url: string): number {
  const match =
    /^https:\/\/pokeapi\.co\/api\/v2\/pokemon-species\/(\d+)\/$/.exec(url);
  const id = Number(match?.[1]);
  if (!Number.isInteger(id) || id < 1 || id > 649)
    throw new Error("Unsupported evolution species");
  return id;
}
export class PokemonClient {
  private pendingSprites = new Map<string, Promise<string | null>>();
  constructor(
    private directory: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const file = join(this.directory, `${path.replaceAll("/", "-")}.json`);
    try {
      return schema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      /* fetch / repair only this cache */
    }
    const response = await this.fetcher(`https://pokeapi.co/api/v2/${path}`, {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        "PokéAPI is unavailable. Earned tokens are saved; hatching will retry.",
      );
    const data = schema.parse(await response.json());
    await atomicWrite(file, JSON.stringify(data));
    return data;
  }
  async chooseLine(random = Math.random): Promise<Line> {
    const start = Date.now();
    for (
      let attempt = 0;
      attempt < 32 && Date.now() - start < 45000;
      attempt++
    ) {
      const candidate = await this.json(
        `pokemon-species/${1 + Math.floor(random() * 649)}`,
        speciesSchema,
      );
      if (
        candidate.evolves_from_species ||
        random() * 255 >= Math.max(1, candidate.capture_rate)
      )
        continue;
      const chain =
        /^https:\/\/pokeapi\.co\/api\/v2\/evolution-chain\/(\d+)\/$/.exec(
          candidate.evolution_chain.url,
        );
      if (!chain) throw new Error("Unexpected evolution-chain address");
      const result = await this.json(
        `evolution-chain/${chain[1]}`,
        z.object({ chain: evolutionSchema }),
      );
      const forms: Line["forms"] = [];
      let node: Evolution | undefined = result.chain;
      while (node && forms.length < 4) {
        forms.push({
          id: speciesID(node.species.url),
          name: node.species.name,
        });
        const supported: Evolution[] = node.evolves_to.filter((n) => {
          try {
            speciesID(n.species.url);
            return true;
          } catch {
            return false;
          }
        });
        node = supported[Math.floor(random() * supported.length)];
      }
      return lineSchema.parse({
        forms,
        rarity:
          candidate.is_legendary || candidate.is_mythical
            ? "legendary"
            : candidate.capture_rate <= 45
              ? "rare"
              : candidate.capture_rate <= 120
                ? "uncommon"
                : "common",
      });
    }
    throw new Error(
      "Still finding your next companion. Your tokens are safe; retrying on the next refresh.",
    );
  }
  sprite(id: number, shiny: boolean): Promise<string | null> {
    const key = `${id}:${shiny}`;
    const pending = this.pendingSprites.get(key);
    if (pending) return pending;
    const task = this.loadSprite(id, shiny).finally(() =>
      this.pendingSprites.delete(key),
    );
    this.pendingSprites.set(key, task);
    return task;
  }
  private async loadSprite(id: number, shiny: boolean): Promise<string | null> {
    if (!Number.isInteger(id) || id < 1 || id > 649) return null;
    const key = `${id}${shiny ? "-shiny" : ""}`;
    const file = join(this.directory, `sprite-${key}.gif`);
    try {
      return `data:image/gif;base64,${(await readFile(file)).toString("base64")}`;
    } catch {
      /* cold cache */
    }
    try {
      const response = await this.fetcher(
        `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shiny ? "shiny/" : ""}${id}.gif`,
        { signal: AbortSignal.timeout(6000), redirect: "error" },
      );
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 2_000_000 || bytes.subarray(0, 3).toString() !== "GIF")
        return null;
      await atomicWrite(file, bytes);
      return `data:image/gif;base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }
}
