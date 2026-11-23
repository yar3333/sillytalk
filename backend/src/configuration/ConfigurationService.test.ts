import fs from "fs";
import os from "os";
import path from "path";
import { ConfigurationService } from "./ConfigurationService";
import { Config } from "./Config";
import { pictureLanguageName } from "./PictureLanguage";

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

describe("the global model picks", () => {
  // Two models, so the picks can name one and dangle on another.
  const twoModels = {
    listen: "127.0.0.1:3210",
    llmModels: {
      m: { id: "m", baseUrl: "http://x/v1", contextSize: 100, supportsImages: false },
      writer: { id: "w", baseUrl: "http://x/v1", contextSize: 100, supportsImages: false },
    },
  };

  it("keeps a pick that names a model of llmModels", () => {
    const cfg = loadConfigWith(
      JSON.stringify({ ...twoModels, chatModel: "m", visionModel: "m", imagePromptModel: "writer" }),
    );
    expect(cfg.chatModel).toBe("m");
    expect(cfg.visionModel).toBe("m");
    expect(cfg.imagePromptModel).toBe("writer");
  });

  it("drops a pick whose model is gone — the default rule applies instead", () => {
    const cfg = loadConfigWith(
      JSON.stringify({ ...twoModels, chatModel: "renamed-away", visionModel: "gone", imagePromptModel: "gone" }),
    );
    expect(cfg).not.toHaveProperty("chatModel");
    expect(cfg).not.toHaveProperty("visionModel");
    expect(cfg).not.toHaveProperty("imagePromptModel");
  });
});

describe("the language of the picture descriptions", () => {
  it("keeps a language the app knows, lower-cased", () => {
    const cfg = loadConfigWith(JSON.stringify({ ...JSON.parse(base()), pictureLanguage: " RU " }));
    expect(cfg.pictureLanguage).toBe("ru");
    // ...and the name the model is told comes from the same list
    expect(pictureLanguageName(cfg.pictureLanguage)).toBe("Russian");
  });

  it("drops a language it cannot name — the descriptions stay English", () => {
    const cfg = loadConfigWith(JSON.stringify({ ...JSON.parse(base()), pictureLanguage: "klingon" }));
    expect(cfg).not.toHaveProperty("pictureLanguage");
    expect(pictureLanguageName(cfg.pictureLanguage)).toBe("English");
    expect(pictureLanguageName(undefined)).toBe("English");
  });
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

describe("the sampling of a model", () => {
  it("keeps the five numbers the entry names", () => {
    const cfg = loadConfigWith(
      base({
        sampling: { temperature: 0.8, topP: 0.9, topK: 40, minP: 0.05, repetitionPenalty: 1.1 },
      }),
    );
    expect(cfg.llmModels["m"].sampling).toEqual({
      temperature: 0.8,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repetitionPenalty: 1.1,
    });
  });

  it("keeps a number as it was written, even one the providers read differently", () => {
    // top_k 0 means "no limit" on one backend and "take the top word" on
    // another; correcting it here would be a guess about somebody's server.
    const cfg = loadConfigWith(base({ sampling: { temperature: 3, topK: 0 } }));
    expect(cfg.llmModels["m"].sampling).toEqual({ temperature: 3, topK: 0 });
  });

  it("drops junk, and a block that ends up saying nothing is no block at all", () => {
    // An absent field is the thing that tells the provider to keep its own
    // default, so an empty sampling object must not be carried around.
    const cfg = loadConfigWith(
      base({ sampling: { temperature: "hot", minP: null, topP: {}, repetitionPenalty: true } }),
    );
    expect(cfg.llmModels["m"]).not.toHaveProperty("sampling");
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

// The imageGenerators entries: every generator names its own kind, and the
// defaults of each kind are filled in here.
describe("the image generators of the config", () => {
  const gens = (imageGenerators: unknown[]) =>
    loadConfigWith(JSON.stringify({ listen: "127.0.0.1:3210", llmModels: {}, imageGenerators })).imageGenerators;

  it("reads a ComfyUI generator and defaults its orientation", () => {
    expect(gens([{ kind: "comfyui", url: "http://127.0.0.1:4240", model: " qwen-image-2.1 " }])).toEqual([
      {
        kind: "comfyui",
        url: "http://127.0.0.1:4240",
        model: "qwen-image-2.1",
        orientation: "square",
        enabled: true,
      },
    ]);
  });

  it("keeps the orientation, the model file and the LoRAs a ComfyUI generator states", () => {
    const [g] = gens([
      {
        kind: "comfyui",
        url: "http://h:8188/",
        model: "qwen-image-2512",
        orientation: "landscape",
        modelFile: " my-qwen-derivative.safetensors ",
        loras: ["style-a.safetensors", { name: "style-b.safetensors", strength: 0.4 }],
        enabled: false,
      },
    ]);
    expect(g).toMatchObject({
      orientation: "landscape",
      modelFile: "my-qwen-derivative.safetensors",
      loras: [{ name: "style-a.safetensors" }, { name: "style-b.safetensors", strength: 0.4 }],
      enabled: false,
    });
  });

  it("drops the size and the device of a ComfyUI entry — the plugin on the server decides both", () => {
    // Both were fields of an older config; the server owns the pixels behind an
    // orientation and the cards behind a job, so neither is carried any more.
    const [g] = gens([
      { kind: "comfyui", url: "http://h:8188", model: "qwen-image-2.1", width: 1664, height: 928, device: "cuda:3" },
    ]);
    expect(g).not.toHaveProperty("width");
    expect(g).not.toHaveProperty("height");
    expect(g).not.toHaveProperty("device");
    expect(g).toMatchObject({ orientation: "square" });
  });

  it("keeps only the LoRAs of a ComfyUI entry that are really named", () => {
    const [g] = gens([
      {
        kind: "comfyui",
        url: "http://h:8188",
        model: "m",
        loras: ["", 7, { strength: 0.5 }, { name: "  ok.safetensors  ", strength: "x" }, { name: "two.safetensors" }],
      },
    ]);
    expect(g).toMatchObject({ loras: [{ name: "ok.safetensors" }, { name: "two.safetensors" }] });
  });

  it("reads an SD API generator with its defaults", () => {
    expect(gens([{ kind: "sdapi", url: "http://127.0.0.1:7860" }])).toEqual([
      {
        kind: "sdapi",
        url: "http://127.0.0.1:7860",
        steps: 30,
        width: 768,
        height: 768,
        denoisingStrength: 0.75,
        negativePrompt: "",
        enabled: true,
      },
    ]);
  });

  it("drops an entry that does not name a generator the app can run", () => {
    // a bare url is not a kind, and neither is a generator type the app no
    // longer has — nothing is guessed from the fields that happen to be set
    const kept = gens([
      { url: "http://127.0.0.1:7860" },
      { command: "gen.cmd", args: [] },
      { kind: "no-such-kind", url: "http://h:8188" },
      "not an object at all",
      { kind: "sdapi", url: "http://127.0.0.1:7860" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: "sdapi" });
  });
});
