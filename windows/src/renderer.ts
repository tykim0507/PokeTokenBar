import type { View, Settings } from "./core/model";
import { localDay } from "./core/model";
import type {} from "./bridge";
const root = document.querySelector<HTMLDivElement>("#app")!;
const floating = new URLSearchParams(location.search).has("pet");
let current: View | null = null;
let page: "home" | "collection" | "settings" = "home";
let busy = false;
let collectionPage = 0;
const number = (n: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const name = (s: string) =>
  s
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
const egg =
  '<div class="egg" aria-label="An egg waiting to hatch"><i></i><b></b><span></span></div>';
function companionName(view: View): string {
  const a = view.state.active;
  return a ? name(a.line.forms[a.stage]!.name) : "A little possibility";
}
function sprite(view: View): string {
  return view.sprite
    ? `<img class="sprite" src="${view.sprite}" alt="${escape(companionName(view))}">`
    : view.state.active
      ? '<div class="unavailable-art" aria-label="Sprite is loading">✧</div>'
      : egg;
}
function progress(view: View): number {
  return Math.min(
    100,
    ((view.state.active?.xp ?? view.state.eggTokens) / view.threshold) * 100,
  );
}
function meter(value: number): string {
  return `<progress max="100" value="${value}" aria-label="Growth progress">${Math.round(value)}%</progress>`;
}
function header(): string {
  return `<aside class="sidebar"><div class="brand"><span class="brand-mark">p.</span><span>PokeTokenBar<small>WINDOWS EDITION</small></span></div><nav aria-label="Main navigation">${(["home", "collection", "settings"] as const).map((p, i) => `<button data-page="${p}" class="nav ${p === page ? "selected" : ""}" ${p === page ? 'aria-current="page"' : ""}><span>${["◉", "▦", "⚙"][i]}</span>${["Companion", "Pokédex", "Settings"][i]}</button>`).join("")}</nav><div class="sidebar-foot"><span class="live-dot"></span> Grown from your work<small>Local logs. A little company.</small></div></aside>`;
}
function home(view: View): string {
  const a = view.state.active;
  const today = view.usage.reduce(
    (sum, s) => sum + (s.daily[localDay()] ?? 0),
    0,
  );
  const left = Math.max(0, view.threshold - (a?.xp ?? view.state.eggTokens));
  const next = !a
    ? "hatching"
    : a.stage < a.line.forms.length - 1
      ? "evolution"
      : "graduation";
  return `<div class="page-heading"><div><p class="eyebrow">A SMALL REWARD FOR BIG IDEAS</p><h1>Your coding companion.</h1><p>Every session brings a little more life.</p></div><button class="button subtle" id="refresh" ${busy ? "disabled" : ""}>↻ ${busy ? "Refreshing…" : "Refresh"}</button></div>
 <section class="hero" aria-label="Current companion"><div class="habitat"><div class="sun"></div><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="ground"></div>${sprite(view)}<span class="habitat-label">${a ? (a.shiny ? "✦ SHINY COMPANION" : "YOUR LITTLE COMPANION") : "SOMETHING GOOD IS GROWING"}</span></div><div class="growth"><span class="pill">${a ? escape(a.line.rarity.toUpperCase()) : "THE BEGINNING"}</span><h2>${escape(companionName(view))}</h2><p>${a ? "Keep making things. Your companion is growing alongside you." : "An egg, a few ideas, and a whole adventure ahead. Keep coding to meet your companion."}</p><div class="progress-label"><strong>${Math.floor(progress(view))}% to ${next}</strong><span>${number(left)} to go</span></div>${meter(progress(view))}<div class="stages">${a ? a.line.forms.map((f, i) => `<span class="${i <= a.stage ? "reached" : ""}">${i <= a.stage ? "●" : "○"} ${escape(name(f.name))}</span>`).join("<b>›</b>") : '<span class="reached">● Egg</span><b>›</b><span>○ A new friend</span>'}</div></div></section>
 <section class="metrics" aria-label="Usage overview"><article><span>TOKENS TODAY</span><strong id="today-tokens">${number(today)}</strong><small>Across your coding tools</small></article><article><span>GROWTH EARNED</span><strong>${number(view.state.lifetime)}</strong><small>Since your first visit</small></article><article><span>POKÉDEX</span><strong>${new Set(view.state.dex.map((d) => d.id)).size}<em> / 649</em></strong><small>${view.state.graduates} companions graduated</small></article></section>
 <section class="sources"><div class="section-heading"><h3>A little work, a little growth.</h3><span>REFRESHES EVERY 30 SECONDS</span></div>${view.usage.length ? view.usage.map((s) => `<div class="source"><div class="provider-icon">${s.id === "codex" ? "C" : "✳"}</div><div><strong>${escape(s.name)}</strong><small>${s.errors.length ? "Needs attention — check scan folders" : s.files ? `${s.files} local session files` : "No logs yet — start a coding session"}</small></div><strong>${number(s.daily[localDay()] ?? 0)} <small>tokens today</small></strong><span class="status-dot ${s.errors.length ? "warning" : ""}"></span></div>`).join("") : '<p class="empty">Looking for local Codex and Claude Code sessions…</p>'}</section>`;
}
function collection(view: View): string {
  return `<div class="page-heading"><div><p class="eyebrow">YOUR JOURNEY, ONE FRIEND AT A TIME</p><h1>A growing collection.</h1><p>Every hatch and evolution has a place here.</p></div><span class="pill">${view.state.dex.length} ENTRIES</span></div>${
    view.state.dex.length
      ? `<div class="pagination"><button class="button subtle" id="dex-prev" ${collectionPage === 0 ? "disabled" : ""}>Previous</button><span>${collectionPage + 1} / ${Math.max(1, Math.ceil(view.state.dex.length / 24))}</span><button class="button subtle" id="dex-next" ${(collectionPage + 1) * 24 >= view.state.dex.length ? "disabled" : ""}>Next</button></div><div class="dex-grid">${[
          ...view.state.dex,
        ]
          .sort((a, b) => a.id - b.id)
          .slice(collectionPage * 24, (collectionPage + 1) * 24)
          .map(
            (d) =>
              `<article class="dex-card"><span class="dex-id">#${String(d.id).padStart(3, "0")}</span><div class="dex-symbol"><img class="dex-sprite" data-id="${d.id}" data-shiny="${d.shiny}" alt="${escape(name(d.name))}" hidden><span>${d.shiny ? "✦" : "✧"}</span></div><h3>${escape(name(d.name))}</h3><p>${d.shiny ? "Shiny · " : ""}Met ${d.count} ${d.count === 1 ? "time" : "times"}</p><small>First met ${escape(new Date(d.firstSeen).toLocaleDateString())}</small></article>`,
          )
          .join("")}</div>`
      : `<section class="empty-collection">${egg}<h2>Your story starts with an egg.</h2><p>Your first companion will appear here when it hatches.<br>Every evolution joins the collection, too.</p><button class="button" data-page="home">Back to your companion</button></section>`
  }`;
}
function settings(view: View): string {
  return `<div class="page-heading"><div><p class="eyebrow">MAKE YOURSELF AT HOME</p><h1>Your rhythm. Your rules.</h1><p>Small adjustments for the way you work.</p></div></div><section class="settings-card"><h3>Companion</h3><label class="setting"><span><strong>Floating desktop companion</strong><small>Drag your companion to a comfortable spot.</small></span><input id="floating" type="checkbox" ${view.settings.floatingPet ? "checked" : ""}></label><label class="setting"><span><strong>Start with Windows</strong><small>Keep a little company from the moment you sign in.</small></span><input id="startup" type="checkbox" ${view.settings.launchAtLogin ? "checked" : ""}></label><label class="setting"><span><strong>Growth pace</strong><small>Changes how many tokens each stage needs.</small></span><select id="difficulty" aria-label="Growth pace">${[
    [0.1, "Quick · 10×"],
    [0.5, "Relaxed · 2×"],
    [1, "Original"],
    [2, "Long journey · ½×"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${view.settings.difficulty === v ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select></label></section><section class="settings-card"><h3>Additional log folders</h3><p class="muted">Default Codex and Claude Code folders are included automatically. Add a local folder for WSL or synchronized logs. These folders are read only.</p>${(["codex", "claude"] as const).map((p) => `<div class="folder-heading"><strong>${p === "codex" ? "Codex" : "Claude Code"}</strong><button class="button subtle add-folder" data-provider="${p}">+ Add folder</button></div>${view.settings.extraRoots[p].map((path, i) => `<div class="folder"><code>${escape(path)}</code><button class="remove-folder" data-provider="${p}" data-index="${i}" aria-label="Remove folder ${escape(path)}">Remove</button></div>`).join("")}`).join("")}</section><section class="settings-card"><h3>Save & restore</h3><p class="muted">Back up your companion and Pokédex. Windows saves use their own format; macOS saves are not interchangeable.</p><div class="actions"><button class="button" id="export">Export save</button><button class="button subtle" id="import">Import save</button></div></section><p class="legal">Unofficial, non-commercial fan project. Not affiliated with Nintendo, Game Freak, Creatures Inc., or The Pokémon Company. Species and sprites are fetched from PokéAPI at runtime.</p>`;
}
function render(view: View): void {
  current = view;
  if (floating) {
    document.body.classList.add("floating");
    root.innerHTML = `<div class="pet-drag" title="Drag to move · right-click for options">${sprite(view)}</div><button id="show-main" class="pet-label">${view.state.active ? escape(companionName(view)) : "Your next adventure"}${meter(progress(view))}</button>`;
    document
      .querySelector("#show-main")
      ?.addEventListener(
        "click",
        () => void run(() => window.companion.show()),
      );
    return;
  }
  root.innerHTML = `${header()}<main><div class="topline"><span>YOUR DAILY COMPANION</span><span>${escape(new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" }))}</span></div>${page === "home" ? home(view) : page === "collection" ? collection(view) : settings(view)}${view.error ? `<div class="error" role="alert">${escape(view.error)}</div>` : ""}<footer><span class="live-dot"></span>${view.updatedAt ? `Updated ${escape(new Date(view.updatedAt).toLocaleTimeString())}` : "Reading your local usage…"}<span>Made for the things you make.</span></footer></main>`;
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((b) =>
    b.addEventListener("click", () => {
      page = b.dataset.page as typeof page;
      render(current!);
    }),
  );
  document.querySelector("#dex-prev")?.addEventListener("click", () => {
    collectionPage = Math.max(0, collectionPage - 1);
    render(current!);
  });
  document.querySelector("#dex-next")?.addEventListener("click", () => {
    collectionPage++;
    render(current!);
  });
  document.querySelectorAll<HTMLImageElement>(".dex-sprite").forEach((img) => {
    void window.companion
      .sprite(Number(img.dataset.id), img.dataset.shiny === "true")
      .then((url) => {
        if (!url || !img.isConnected) return;
        img.src = url;
        img.hidden = false;
        const placeholder = img.nextElementSibling;
        if (placeholder) placeholder.remove();
      })
      .catch(() => {});
  });
  document
    .querySelector("#refresh")
    ?.addEventListener(
      "click",
      () => void run(() => window.companion.refresh()),
    );
  document.querySelector("#floating")?.addEventListener(
    "change",
    (event) =>
      void update({
        floatingPet: (event.target as HTMLInputElement).checked,
      }),
  );
  document.querySelector("#startup")?.addEventListener(
    "change",
    (event) =>
      void update({
        launchAtLogin: (event.target as HTMLInputElement).checked,
      }),
  );
  document.querySelector("#difficulty")?.addEventListener(
    "change",
    (event) =>
      void update({
        difficulty: Number((event.target as HTMLSelectElement).value),
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>(".add-folder")
    .forEach((b) =>
      b.addEventListener(
        "click",
        () =>
          void run(() =>
            window.companion.addFolder(
              b.dataset.provider as "codex" | "claude",
            ),
          ),
      ),
    );
  document.querySelectorAll<HTMLButtonElement>(".remove-folder").forEach((b) =>
    b.addEventListener("click", () => {
      const provider = b.dataset.provider as "codex" | "claude";
      const extraRoots = structuredClone(current!.settings.extraRoots);
      extraRoots[provider].splice(Number(b.dataset.index), 1);
      void update({ extraRoots });
    }),
  );
  document
    .querySelector("#export")
    ?.addEventListener(
      "click",
      () => void run(() => window.companion.exportSave()),
    );
  document
    .querySelector("#import")
    ?.addEventListener(
      "click",
      () => void run(() => window.companion.importSave()),
    );
}
async function update(patch: Partial<Settings>): Promise<void> {
  await run(() =>
    window.companion.settings({ ...current!.settings, ...patch }),
  );
}
async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (error) {
    const toast = document.querySelector("#toast")!;
    toast.textContent =
      error instanceof Error ? error.message : "Something went wrong.";
    setTimeout(() => {
      toast.textContent = "";
    }, 7000);
  } finally {
    busy = false;
    if (current) render(current);
  }
}
window.companion.subscribe(render);
void window.companion
  .view()
  .then(render)
  .catch((error) => {
    root.textContent = String(error);
  });
