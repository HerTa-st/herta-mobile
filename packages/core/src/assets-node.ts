/**
 * Node 侧素材来源：跑测试、跑构建脚本时用。
 *
 * 浏览器侧（apps/phone）另有一份 fetch 实现——两边都只满足 `AssetSource`，
 * 所以 core 的算法一行都不用改。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssetSource, MoodPack, PromptAssets, VoicePack } from "./assets.ts";
import type { Lang } from "../../protocol/src/index.ts";

interface Manifest {
  voice?: { openings?: Record<string, string>; veto?: string[]; easterEgg?: string[] };
  memory?: { path: string }[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readJsonWithFallback<T>(dir: string, base: string, lang: Lang): Promise<T | null> {
  return (await readJson<T>(join(dir, base + "." + lang + ".json"))) ?? (await readJson<T>(join(dir, base + ".zh.json")));
}

export class NodeAssetSource implements AssetSource {
  readonly root: string;
  readonly lang: Lang;

  constructor(root: string, lang: Lang = "zh") {
    this.root = root;
    this.lang = lang;
  }

  async promptAssets(): Promise<PromptAssets> {
    const a = await readJsonWithFallback<PromptAssets>(this.root, "prompt-assets", this.lang);
    if (!a) throw new Error("读不到素材：prompt-assets." + this.lang + ".json 缺失（目录：" + this.root + "）");
    return a;
  }

  async mood(): Promise<MoodPack | null> {
    return readJsonWithFallback<MoodPack>(this.root, "mood-prompt", this.lang);
  }

  async seedFiles(): Promise<string[]> {
    try {
      const files = await readdir(join(this.root, "memory"));
      return files.filter((f) => f.endsWith(".txt")).sort();
    } catch {
      return [];
    }
  }

  async readSeed(file: string): Promise<string | null> {
    try {
      return await readFile(join(this.root, "memory", file), "utf8");
    } catch {
      return null;
    }
  }

  async voice(): Promise<VoicePack> {
    const m = (await readJson<Manifest>(join(this.root, "manifest.json"))) ?? {};
    return {
      openings: m.voice?.openings ?? {},
      veto: m.voice?.veto ?? [],
      easterEgg: m.voice?.easterEgg ?? [],
    };
  }
}
