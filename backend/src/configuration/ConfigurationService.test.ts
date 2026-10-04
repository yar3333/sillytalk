import fs from "fs";
import os from "os";
import path from "path";
import { ConfigurationService } from "./ConfigurationService";
import { Config } from "./Config";

// One service instance for the whole suite — the service is stateless, the
// data root is read from the env on every load.
const configuration = new ConfigurationService();

// Each scenario gets a fresh temp data dir with its own config.json: the
// data root is read from SILLYTALK_DATA_DIR on every load, so no module
// reloading is needed.
function loadConfigWith(raw: string): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-config-"));
  fs.writeFileSync(path.join(dir, "config.json"), raw, "utf-8");
  const prev = process.env.SILLYTALK_DATA_DIR;
  process.env.SILLYTALK_DATA_DIR = dir;
  try {
    return configuration.loadConfig();
  } finally {
    if (prev === undefined) delete process.env.SILLYTALK_DATA_DIR;
    else process.env.SILLYTALK_DATA_DIR = prev;
  }
}

// A minimal valid config with one model; extra fields go into the entry.
const base = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    listen: "127.0.0.1:3210",
    llmModels: {
      m: { id: "m", baseUrl: "http://x/v1", contextSize: 100, supportsImages: false, ...extra },
    },
  });

describe("the reasoning config fields", () => {
  it("default: reasoning off, the standard level set", () => {
    const cfg = loadConfigWith(base());
    expect(cfg.llmModels.m.reasoning).toBe(false);
    expect(cfg.llmModels.m.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps a level that is in the model list", () => {
    const cfg = loadConfigWith(base({ reasoning: "high", reasoningLevels: ["low", "high"] }));
    expect(cfg.llmModels.m.reasoning).toBe("high");
    expect(cfg.llmModels.m.reasoningLevels).toEqual(["low", "high"]);
  });

  it("a level outside the model list becomes off", () => {
    const cfg = loadConfigWith(base({ reasoning: "max", reasoningLevels: ["low"] }));
    expect(cfg.llmModels.m.reasoning).toBe(false);
  });

  it("false, empty and non-string levels become off", () => {
    expect(loadConfigWith(base({ reasoning: false })).llmModels.m.reasoning).toBe(false);
    expect(loadConfigWith(base({ reasoning: "" })).llmModels.m.reasoning).toBe(false);
    expect(loadConfigWith(base({ reasoning: 7 })).llmModels.m.reasoning).toBe(false);
  });

  it("an empty or junk level list falls back to the default set", () => {
    expect(loadConfigWith(base({ reasoningLevels: [] })).llmModels.m.reasoningLevels).toEqual(
      ConfigurationService.DEFAULT_REASONING_LEVELS,
    );
    expect(
      loadConfigWith(base({ reasoningLevels: [1, "  ", "low"] })).llmModels.m.reasoningLevels,
    ).toEqual(["low"]);
  });
});

describe("prepareLegacyConfig", () => {
  it("extracts the legacy characters and strips the dead fields", () => {
    const raw: Record<string, unknown> = {
      listen: "0.0.0.0:3210",
      characters: [{ id: "a", name: "A", description: "" }],
      port: 3210,
      models: [],
      userId: "me",
      imageGeneration: { auto: true },
    };
    const legacy = configuration.prepareLegacyConfig(raw);
    expect(legacy).toEqual([{ id: "a", name: "A", description: "" }]);
    expect(raw.characters).toBeUndefined();
    expect(raw.port).toBeUndefined();
    expect(raw.models).toBeUndefined();
    expect(raw.userId).toBeUndefined();
    expect(raw.imageGeneration).toBeUndefined();
    expect(raw.listen).toBe("0.0.0.0:3210");
  });

  it("returns null when the config is already clean", () => {
    const raw: Record<string, unknown> = { listen: "0.0.0.0:3210" };
    expect(configuration.prepareLegacyConfig(raw)).toBeNull();
  });
});

describe("reasoningLevelsOf", () => {
  it("uses the model list when it is non-empty", () => {
    expect(configuration.reasoningLevelsOf({ reasoningLevels: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("falls back to the default set", () => {
    expect(configuration.reasoningLevelsOf({})).toEqual(ConfigurationService.DEFAULT_REASONING_LEVELS);
    expect(configuration.reasoningLevelsOf({ reasoningLevels: [] })).toEqual(
      ConfigurationService.DEFAULT_REASONING_LEVELS,
    );
  });
});
