import fs from "fs";
import path from "path";
import { createToken } from "../di";
import { Config } from "./Config";
import { ImageGenerator } from "./ImageGenerator";
import { LlmModel } from "./LlmModel";
import { Model } from "./Model";
import { PathHelper } from "../shared/PathHelper";

// The DI token of the configuration service (registered in index.ts).
export const DI_CONFIGURATION_SERVICE = createToken<ConfigurationService>("ConfigurationService");

// The top-level configuration service: the config.json load/save (with the
// normalization and the JSONC comment stripping), the defaults, the listen
// address parsing and the flat-model helpers. The data root is read from the
// env on every call (through the paths accessors), so the service is
// stateless and tests point it at a temp dir with SILLYTALK_DATA_DIR.
export class ConfigurationService {
  // The default reasoning levels for a model without a reasoningLevels list.
  static readonly DEFAULT_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

  // The listen address "host:port" -> { host, port } (port defaults to 3210).
  // Supports IPv6 in brackets ([::1]:3210) as well as plain ":3210" / "3210".
  parseListen(listen: string): { host: string; port: number } {
    const value = (listen ?? "").trim();
    if (!value) return { host: "0.0.0.0", port: 3210 };
    if (value.startsWith("[")) {
      const close = value.indexOf("]");
      if (close !== -1) {
        const host = value.slice(1, close);
        const port = parseInt(value.slice(close + 1).replace(/^:/, ""), 10);
        return { host, port: Number.isFinite(port) && port > 0 ? port : 3210 };
      }
    }
    const idx = value.lastIndexOf(":");
    if (idx === -1) return { host: value, port: 3210 };
    const host = value.slice(0, idx) || "0.0.0.0";
    const port = parseInt(value.slice(idx + 1), 10);
    return { host, port: Number.isFinite(port) && port > 0 ? port : 3210 };
  }

  defaultConfig(): Config {
    return {
      listen: "0.0.0.0:3210",
      llmModels: {
        default: {
          id: "default",
          baseUrl: "http://127.0.0.1:8000/v1",
          apiKey: "",
          contextSize: 8192,
          supportsImages: false,
          reasoning: false,
        },
      },
      imageGenerators: [],
    };
  }

  // The model's reasoning levels: a non-empty list from the config, the
  // default set otherwise (non-string/empty entries are dropped).
  reasoningLevelsOf(model: Pick<LlmModel, "reasoningLevels">): string[] {
    const levels = (model.reasoningLevels ?? [])
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return levels.length > 0 ? levels : [...ConfigurationService.DEFAULT_REASONING_LEVELS];
  }

  // The provider key: envKey (environment variable) takes priority over apiKey.
  resolveApiKey(model: Pick<LlmModel, "apiKey" | "envKey">): string {
    if (model.envKey) {
      const v = process.env[model.envKey];
      if (v) return v;
    }
    return model.apiKey ?? "";
  }

  // The model list as a flat array: llmModels key -> Model.name.
  listModels(config: Config): Model[] {
    return Object.entries(config.llmModels).map(([name, m]) => ({ name, ...m }));
  }

  loadConfig(): Config {
    const config = this.loadConfigFromFile();
    // The listen address from the environment wins over config.json (e2e
    // starts an isolated server on its own port).
    if (process.env.SILLYTALK_LISTEN) config.listen = process.env.SILLYTALK_LISTEN;
    return config;
  }

  saveConfig(config: Config): void {
    fs.mkdirSync(PathHelper.configDir(), { recursive: true });
    fs.writeFileSync(PathHelper.configFile(), JSON.stringify(config, null, 2), "utf-8");
  }

  // The legacy config.json fields, in one place: the characters array (the
  // caller moves it into folders through CharactersService.migrate) and the
  // dead top-level fields (port, models, userId, imageGeneration). Returns
  // the legacy characters entries, or null when the config is already clean;
  // the fields are stripped from the object, so a following save does not
  // carry them on disk.
  prepareLegacyConfig(raw: Record<string, unknown>): unknown[] | null {
    const legacy = Array.isArray(raw.characters) ? raw.characters : null;
    delete raw.characters;
    delete raw.port;
    delete raw.models;
    delete raw.userId;
    delete raw.imageGeneration;
    return legacy;
  }

  private loadConfigFromFile(): Config {
    const file = PathHelper.configFile();
    if (!fs.existsSync(file)) {
      const cfg = this.defaultConfig();
      this.saveConfig(cfg);
      return cfg;
    }
    try {
      const raw = fs.readFileSync(file, "utf-8");
      // The config may be written as JSONC (with comments) — they are stripped
      // before parsing. Legacy fields (port, models, userId, imageGeneration,
      // characters) are simply ignored.
      const parsed = JSON.parse(ConfigurationService.stripJsoncComments(raw)) as Record<string, unknown>;
      const def = this.defaultConfig();
      return {
        listen: typeof parsed.listen === "string" && parsed.listen ? parsed.listen : def.listen,
        llmModels: this.normalizeLlmModels(parsed.llmModels, def),
        imageGenerators: this.normalizeGenerators(parsed.imageGenerators),
      };
    } catch (err) {
      throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
    }
  }

  // Strips // and /* */ comments from JSONC, leaving the ones inside strings
  // untouched (otherwise values like https://... URLs would break).
  private static stripJsoncComments(raw: string): string {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < raw.length) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (inString) {
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i += 2;
          continue;
        }
        if (ch === '"') inString = false;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") {
        while (i < raw.length && raw[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  private normalizeLlmModels(raw: unknown, def: Config): Record<string, LlmModel> {
    const result: Record<string, LlmModel> = {};
    if (!raw || typeof raw !== "object") return result;
    for (const [name, val] of Object.entries(raw)) {
      if (!val || typeof val !== "object") continue;
      const v = val as Partial<LlmModel>;
      const levels = this.reasoningLevelsOf({ reasoningLevels: v.reasoningLevels });
      // A level outside the model's list (or not a string) is treated as off.
      const reasoning =
        typeof v.reasoning === "string" && levels.includes(v.reasoning) ? v.reasoning : false;
      result[name] = {
        id: typeof v.id === "string" ? v.id : "",
        baseUrl: typeof v.baseUrl === "string" ? v.baseUrl : "",
        apiKey: typeof v.apiKey === "string" ? v.apiKey : undefined,
        envKey: typeof v.envKey === "string" ? v.envKey : undefined,
        contextSize: typeof v.contextSize === "number" ? v.contextSize : 8192,
        supportsImages: typeof v.supportsImages === "boolean" ? v.supportsImages : false,
        reasoning,
        reasoningLevels: levels,
      };
    }
    return Object.keys(result).length > 0 ? result : def.llmModels;
  }

  private normalizeGenerators(raw: unknown): ImageGenerator[] {
    if (!Array.isArray(raw)) return [];
    const result: ImageGenerator[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const g = entry as Record<string, unknown>;
      // enabled defaults to true — a generator without the field is on.
      const enabled = typeof g.enabled === "boolean" ? g.enabled : true;
      if (typeof g.command === "string") {
        result.push({
          command: g.command,
          args: Array.isArray(g.args) ? g.args.map((a) => String(a)) : [],
          maxInputImages: typeof g.maxInputImages === "number" ? g.maxInputImages : 0,
          enabled,
        });
      } else if (typeof g.url === "string") {
        result.push({
          url: g.url,
          steps: typeof g.steps === "number" ? g.steps : 30,
          width: typeof g.width === "number" ? g.width : 768,
          height: typeof g.height === "number" ? g.height : 768,
          denoisingStrength: typeof g.denoisingStrength === "number" ? g.denoisingStrength : 0.75,
          negativePrompt: typeof g.negativePrompt === "string" ? g.negativePrompt : "",
          enabled,
        });
      }
    }
    return result;
  }
}
