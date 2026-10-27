import type { AssetSource, MoodPack, PromptAssets, VoicePack } from "@herta/core";

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface Manifest {
  voice?: { veto?: string[]; easterEgg?: string[] };
  memory?: { path: string }[];
}

/**
 * 浏览器侧素材来源。打包后的 assets/ 由 vite 的 publicDir 摊在站点根下，
 * 所以路径是相对的——手机上装成 APK 后 origin 是 https://localhost，也一样。
 */
export class BrowserAssetSource implements AssetSource {
  readonly lang: "zh" | "en";
  readonly base: string;

  constructor(base = "", lang: "zh" | "en" = "zh") {
    this.base = base;
    this.lang = lang;
  }

  async promptAssets(): Promise<PromptAssets> {
    const a = await json<PromptAssets>(this.base + "prompt-assets." + this.lang + ".json");
    if (!a) throw new Error("素材没进包：prompt-assets." + this.lang + ".json 读不到");
    return a;
  }

  async mood(): Promise<MoodPack | null> {
    return json<MoodPack>(this.base + "mood-prompt." + this.lang + ".json");
  }

  async seedFiles(): Promise<string[]> {
    const m = await json<Manifest>(this.base + "manifest.json");
    return (m?.memory ?? []).map((x) => x.path.split("/").pop() ?? "").filter(Boolean);
  }

  async readSeed(file: string): Promise<string | null> {
    try {
      const res = await fetch(this.base + "memory/" + encodeURIComponent(file), { cache: "no-cache" });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  async voice(): Promise<VoicePack> {
    const m = await json<Manifest>(this.base + "manifest.json");
    return {
      veto: m?.voice?.veto ?? [],
      easterEgg: m?.voice?.easterEgg ?? [],
    };
  }
}
