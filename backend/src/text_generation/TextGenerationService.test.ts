import fs from "fs";
import os from "os";
import path from "path";
import { TextGenerationService } from "./TextGenerationService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Chat } from "../chats/Chat";
import { ChatMessage } from "../chats/ChatMessage";
import { Config } from "../configuration/Config";
import { Model } from "../configuration/Model";
import { PathHelper } from "../shared/PathHelper";

// One service instance for the whole suite — the service is stateless, the
// tests only need its methods.
const textGenerationService = new TextGenerationService(new ConfigurationService());

function msg(text: string, role: "user" | "assistant" = "user"): ChatMessage {
  return { id: Math.random().toString(36), role, text, images: [], timestamp: Date.now() };
}

const model: Model = {
  name: "test", // llmModels key (internal ID) that the chat references
  id: "test-model", // id sent to the provider
  baseUrl: "http://provider.test/v1",
  contextSize: 8192,
  supportsImages: true,
};

function configOf(models: Model[]): Config {
  return {
    listen: "127.0.0.1:3210",
    llmModels: Object.fromEntries(models.map((m) => [m.name, m])),
    imageGenerators: [],
  };
}

function chatWithModel(modelId: string): Chat {
  return { id: "chat-1", createdAt: 0, characterIds: [], userId: "", modelId, messages: [] };
}

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("resolveModel", () => {
  const second: Model = { ...model, name: "second", id: "second-model" };

  it("returns the model the chat references by the llmModels key", () => {
    expect(textGenerationService.resolveModel(configOf([model, second]), chatWithModel("second"))).toEqual(second);
  });

  it("falls back to the first model when the referenced one is gone", () => {
    // the model was renamed or deleted from the config — the chat keeps working
    expect(textGenerationService.resolveModel(configOf([model, second]), chatWithModel("renamed-away"))).toEqual(model);
  });

  it("returns null when the config has no models at all", () => {
    expect(textGenerationService.resolveModel(configOf([]), chatWithModel(""))).toBeNull();
  });
});

describe("systemPromptFor", () => {
  it("includes the character name and description", () => {
    const out = textGenerationService.systemPromptFor({ name: "Alice", description: "A kind fairy" });
    expect(out).toContain("Alice");
    expect(out).toContain("A kind fairy");
    expect(out).toContain("2–5 sentences");
    expect(out).toContain("/* ... */");
  });

  it("adds the selected person description when present", () => {
    const out = textGenerationService.systemPromptFor(
      { name: "Alice", description: "A kind fairy" },
      { name: "Bob", description: "Engineer, likes brevity" },
    );
    expect(out).toContain("Bob");
    expect(out).toContain("Engineer, likes brevity");
  });

  it("does not add the interlocutor block without a description", () => {
    const out = textGenerationService.systemPromptFor(
      { name: "Alice", description: "A kind fairy" },
      { name: "You", description: "   " },
    );
    expect(out).not.toContain("talking to");
  });

  it("offers no image protocol: a character cannot attach or draw pictures", () => {
    const base = { name: "Alice", description: "" };
    const out = textGenerationService.systemPromptFor(base);
    expect(out).not.toContain("[IMG:");
    expect(out).not.toContain("[PHOTO:");
    expect(out).toContain("text only");
  });

  it("group chat: lists the other characters and allows [SILENT]", () => {
    const base = { name: "Alice", description: "a fairy" };
    const out = textGenerationService.systemPromptFor(base, null, [{ name: "Bob", description: "a knight" }]);
    expect(out).toContain("Bob");
    expect(out).toContain("[SILENT]");
    expect(out).toContain("Alice"); // replies only as itself
  });

  it("without other characters the [SILENT] tag is not mentioned", () => {
    expect(textGenerationService.systemPromptFor({ name: "Alice", description: "" })).not.toContain("[SILENT]");
  });
});

describe("parseSilence", () => {
  it("exactly [SILENT] is silence (case and whitespace do not matter)", () => {
    expect(textGenerationService.parseSilence("[SILENT]")).toBeNull();
    expect(textGenerationService.parseSilence("  [silent]\n")).toBeNull();
  });

  it("a tag inside text is not silence and is removed", () => {
    expect(textGenerationService.parseSilence("Let me think… [SILENT] Okay, I will reply.")).toBe(
      "Let me think… Okay, I will reply.",
    );
  });
});

describe("stripNamePrefixes", () => {
  const names = ["Bob", "Carol"];

  it("strips a single and a repeated prefix of its own name", () => {
    expect(textGenerationService.stripNamePrefixes("Carol: Hi!", names)).toBe("Hi!");
    expect(textGenerationService.stripNamePrefixes("Carol: Carol: Hi!", names)).toBe("Hi!");
  });

  it("strips a copy of another prefix from the history", () => {
    expect(textGenerationService.stripNamePrefixes("Bob: Bob: /*I noticed…*/", names)).toBe("/*I noticed…*/");
  });

  it("leaves text without a prefix and a name without a colon alone", () => {
    expect(textGenerationService.stripNamePrefixes("Hi!", names)).toBe("Hi!");
    expect(textGenerationService.stripNamePrefixes("Bob said: hi", names)).toBe("Bob said: hi");
    expect(textGenerationService.stripNamePrefixes("Carla: hi", names)).toBe("Carla: hi");
  });

  it("an empty name list leaves the text as-is", () => {
    expect(textGenerationService.stripNamePrefixes("Carol: hi", [])).toBe("Carol: hi");
  });
});

describe("labelHistory", () => {
  const characterNames = { c1: "Alice", c2: "Bob" };
  const userNames = { u1: "Carol", u2: "Dave" };

  it("labels the lines with authors in a group chat", () => {
    const history = [
      { ...msg("hi"), userId: "u2" },
      { ...msg("greetings", "assistant"), characterId: "c2" },
      msg("how are you?"),
    ];
    const out = textGenerationService.labelHistory(history, characterNames, userNames, true);
    expect(out[0].text).toBe("Dave: hi");
    expect(out[1].text).toBe("Bob: greetings");
    // Unknown author — the text is not changed
    expect(out[2].text).toBe("how are you?");
  });

  it("in a single-participant chat the history is not changed", () => {
    const history = [
      { ...msg("hi"), userId: "u1" },
      { ...msg("hello", "assistant"), characterId: "c1" },
    ];
    expect(textGenerationService.labelHistory(history, characterNames, userNames, false)).toEqual(history);
  });
});

describe("translatePrompt", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the request with the translation system instruction and returns the answer", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "a fluffy cat" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    // Russian input — the case the translation is for
    const out = await textGenerationService.translatePrompt(model, "пушистый кот");
    expect(out).toBe("a fluffy cat");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0].content).toContain("English");
    expect(body.messages[1].content).toBe("пушистый кот");
  });
});

describe("tunePrompt", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("asks for one English prompt shaped for a generator and returns the answer", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: "a cat on a windowsill, morning light" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await textGenerationService.tunePrompt(model, "кот на подоконнике", { temperature: 0.4 });
    expect(out).toBe("a cat on a windowsill, morning light");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
    };
    expect(body.messages[0].content).toContain("image generation prompt");
    expect(body.messages[0].content).toContain("English");
    expect(body.messages[1].content).toBe("кот на подоконнике");
    // the chat's sampling rides along like on every other call of the chat
    expect(body.temperature).toBe(0.4);
  });
});

describe("describePicture", () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.SILLYTALK_DATA_DIR;
  let dataDir: string;
  let picture: string;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-describe-"));
    process.env.SILLYTALK_DATA_DIR = dataDir;
    const file = path.join(dataDir, "chats", "c1", "files", "a-red-boat.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from("not really a png"));
    picture = PathHelper.imageIdOf(file);
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.SILLYTALK_DATA_DIR;
    else process.env.SILLYTALK_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends an existing picture of the data folder as an image_url part", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: "A red boat on a calm lake. " } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await textGenerationService.describePicture(model, { imageId: picture });
    expect(out).toBe("A red boat on a calm lake.");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toContain("ONE short sentence in English");
    const parts = body.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0].type).toBe("text");
    expect(parts[1].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("accepts a data URL of a file the user just picked", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "A cat." } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await textGenerationService.describePicture(model, { dataUrl: "data:image/jpeg;base64,aGVsbG8=" });
    expect(out).toBe("A cat.");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const parts = (JSON.parse(init.body) as { messages: Array<{ content: unknown }> }).messages[1].content as Array<{
      image_url?: { url: string };
    }>;
    expect(parts[1].image_url?.url).toBe("data:image/jpeg;base64,aGVsbG8=");
  });

  it("refuses a model without vision, a non-picture data URL and an unknown id — without calling the provider", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      textGenerationService.describePicture({ ...model, supportsImages: false }, { imageId: picture }),
    ).rejects.toThrow(/cannot see pictures/);
    await expect(textGenerationService.describePicture(model, { dataUrl: "data:text/plain;base64,aGk=" })).rejects.toThrow(
      /picture data URL/,
    );
    await expect(textGenerationService.describePicture(model, { imageId: "chats/c1/files/gone.png" })).rejects.toThrow(
      /Unknown picture/,
    );
    await expect(textGenerationService.describePicture(model, {})).rejects.toThrow(/No picture/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("trimHistory", () => {
  it("always keeps the first (system) message and the latest ones", () => {
    const system = msg("system", "assistant");
    const history = [system, ...Array.from({ length: 12 }, (_, i) => msg("x".repeat(4000) + i))];
    const trimmed = textGenerationService.trimHistory(history, 2000);
    expect(trimmed[0]).toBe(system);
    expect(trimmed[trimmed.length - 1]).toBe(history[history.length - 1]);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed.length).toBeGreaterThanOrEqual(2);
  });

  it("does not trim a short history", () => {
    const history = [msg("hi"), msg("hello", "assistant")];
    expect(textGenerationService.trimHistory(history, 8192)).toHaveLength(2);
  });

  it("accounts for images in the size estimate", () => {
    const withImage: ChatMessage = { ...msg(""), images: ["a.png", "b.png"] };
    const history = [msg("system", "assistant"), ...Array.from({ length: 8 }, () => ({ ...withImage }))];
    const trimmed = textGenerationService.trimHistory(history, 2000);
    expect(trimmed.length).toBeLessThan(history.length);
  });
});

describe("chatCompletion", () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.SILLYTALK_DATA_DIR;
  let dataDir: string;
  // An existing picture, addressed the way the messages address pictures: by an
  // id relative to the data folder.
  let picture: string;

  beforeAll(() => {
    // A picture is only sent to the provider when its file really exists, so
    // these tests point the data root at a temp folder and put a file in it.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-tg-data-"));
    process.env.SILLYTALK_DATA_DIR = dataDir;
    const file = path.join(PathHelper.chatFilesDir("chat-test"), "a-photo.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-a-real-png");
    picture = PathHelper.imageIdOf(file);
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.SILLYTALK_DATA_DIR;
    else process.env.SILLYTALK_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("retries the request with text when the provider rejected the image", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ error: { code: 500, message: "image input is not supported - hint: provide the mmproj" } }, 500),
      )
      .mockResolvedValueOnce(jsonRes({ choices: [{ message: { content: "a reply without a photo" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = [{ ...msg("what is on the photo?"), images: [picture] }];
    const reply = await textGenerationService.chatCompletion(model, "system", history);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reply).toContain("a reply without a photo");
    expect(reply).toContain("rejected the image");
    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    expect(retryInit.body).not.toContain("image_url");
  });

  it("appends the closing reminder to the end of the last user message", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.chatCompletion(model, "system", [msg("hi")], "The next reply is Carol's line.");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    // system first only: the reminder rides inside the last user message
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("hi\n[The next reply is Carol's line.]");
  });

  it("when the history ends with an assistant reply, the reminder is a separate user line", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.chatCompletion(model, "system", [msg("line", "assistant")], "reminder");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].content).toBe("[reminder]");
  });

  it("omits the model field when the model id is empty", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.chatCompletion({ ...model, id: "" }, "system", [msg("hi")]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("model");
  });

  it("sends the reasoning level in both provider formats when it is set", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.chatCompletion({ ...model, reasoning: "high" }, "system", [msg("hi")]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    // reasoning_effort — OpenAI/llama.cpp, reasoning.effort — OpenRouter.
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toEqual({ effort: "high" });
    // A level means thinking is on — no off-switch is sent alongside.
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  it("sends enable_thinking=false (not a level) when the level is off", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.chatCompletion({ ...model, reasoning: false }, "system", [msg("hi")]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
    // Off — the reliable cross-backend switch (Qwen/llama.cpp) is
    // chat_template_kwargs.enable_thinking=false, not reasoning_effort.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("does not retry the request on an ordinary provider error", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ error: { message: "boom" } }, 500));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(textGenerationService.chatCompletion(model, "system", [msg("hi")])).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the original error when the retry also failed", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ error: { message: "image input is not supported (mmproj missing)" } }, 500));
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = [{ ...msg("photo"), images: [picture] }];
    await expect(textGenerationService.chatCompletion(model, "system", history)).rejects.toThrow("mmproj");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes the abort signal to the provider and does not retry on cancel", async () => {
    // The provider accepts the request and never answers until it is
    // aborted — like a slow model during a user cancel.
    const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) return Promise.reject(new Error("the signal must be passed to the provider"));
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const ctrl = new AbortController();
    const pending = textGenerationService.chatCompletion(model, "system", [msg("hi")], undefined, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // the signal reached the provider, and a cancel is not retried
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toHaveProperty("signal", ctrl.signal);
  });

  it("an image card goes to a vision model as the caption plus the picture", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const card: ChatMessage = {
      ...msg("a red boat on a calm lake", "user"),
      kind: "image",
      images: [picture],
    };
    await textGenerationService.chatCompletion(model, "system", [card]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: unknown }> };
    const content = body.messages[1].content as Array<{ type: string; text?: string }>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("a red boat on a calm lake");
    expect(content[1].type).toBe("image_url");
  });

  it("an image card becomes its description for a model without vision", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const card: ChatMessage = { ...msg("a red boat on a calm lake", "user"), kind: "image", images: [picture] };
    const blank: ChatMessage = { ...msg("", "user"), kind: "image", images: [picture] };
    await textGenerationService.chatCompletion({ ...model, supportsImages: false }, "system", [card, blank]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    // The dialogue still knows what was shown — the caption stands in for the file.
    expect(body.messages[1].content).toBe("[A picture: a red boat on a calm lake]");
    expect(body.messages[2].content).toBe("[A picture without a description]");
    expect(init.body).not.toContain("image_url");
  });

  it("a picture whose file is gone is skipped, not sent as a broken link", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    // still addressed by a valid id, but the file was deleted (or never written:
    // a generation the user cancelled before it produced a file)
    const gone = PathHelper.imageIdOf(path.join(PathHelper.chatFilesDir("chat-test"), "missing.png"));
    await textGenerationService.chatCompletion(model, "system", [{ ...msg("look"), images: [gone] }]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    expect(init.body).not.toContain("image_url");
  });
});

describe("composeImagePrompt", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function asked(body: string) {
    return JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
  }

  it("sends the dialogue and the numbered picture catalogue", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: '{"prompt": "a boat", "refs": [1]}' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.composeImagePrompt(model, {
      scene: "Alice: the lake is calm tonight.\nCarol: [shares a picture: a red boat]",
      images: [
        {
          id: "chats/c/files/boat.png",
          description: "a red boat",
          owner: "Carol",
          age: "2 messages ago",
          origin: "uploaded",
        },
        { id: "chats/c/files/harbour.png", prompt: "a harbour at dusk", owner: "Alice", age: "the last message" },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = asked(init.body);
    expect(body.messages[0].content).toContain("JSON");
    expect(body.messages[1].content).toContain("Alice: the lake is calm tonight.");
    expect(body.messages[1].content).toContain("#1 — shows: a red boat; uploaded by the user; shared by Carol; 2 messages ago");
    expect(body.messages[1].content).toContain("#2 — no description; generated from prompt: a harbour at dusk");
  });

  it("tells the model whose face a look reference carries, and never a name to draw", async () => {
    // The generator has never heard these people, so the plan is asked to write
    // appearances instead of names — and a look reference is labelled with the
    // person it belongs to, which is what the app binds it back to later.
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: '{"prompt": "a boat", "refs": [2]}' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await textGenerationService.composeImagePrompt(model, {
      scene: "Alice: I row out alone.",
      images: [
        { id: "chats/c/files/lake.png", description: "the lake at dawn", age: "the last message" },
        { id: "characters/alice/photos/photo1.jpg", role: "look", ofWho: "char:alice", shows: "Alice" },
      ],
      cast: [{ ref: "char:alice", name: "Alice", look: "a tall woman with short red hair", anchors: [2] }],
      maxRefs: 2,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = asked(init.body);
    expect(body.messages[0].content).toMatch(/NEVER write a person's name in the prompt/i);
    expect(body.messages[0].content).toContain("at most 2 numbers");
    expect(body.messages[1].content).toContain("char:alice — Alice: a tall woman with short red hair (shown on picture 2)");
    expect(body.messages[1].content).toContain("#2 — a look reference of Alice");
  });

  it("says so when the conversation has no pictures to reference", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: '{"prompt": "a boat", "refs": []}' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const plan = await textGenerationService.composeImagePrompt(model, { scene: "Alice: hi", images: [] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    expect(asked(init.body).messages[1].content).toContain("no pictures to draw from");
    expect(plan?.refs).toEqual([]);
  });

  it("reads a plan wrapped in a code fence and prose, and keeps the name and description", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonRes({
          choices: [
            {
              message: {
                content:
                  'Here is my plan:\n```json\n{"name": "a red boat at dusk", "description": "a boat on a lake", "prompt": "a red boat on a calm lake at dusk", "refs": ["2"]}\n```\nHope it fits!',
              },
            },
          ],
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const plan = await textGenerationService.composeImagePrompt(model, {
      scene: "…",
      images: [{ id: "a.png" }, { id: "b.png" }],
    });
    expect(plan).toEqual({
      name: "a red boat at dusk",
      description: "a boat on a lake",
      prompt: "a red boat on a calm lake at dusk",
      refs: [2],
      cast: [],
      subjects: [],
    });
  });

  it("keeps only the people and the noun phrases of the cast it was given", async () => {
    // A model that invents a participant would otherwise bind a reference to
    // nothing, and a noun for a person nobody listed cannot be shown.
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonRes({
          choices: [
            {
              message: {
                content:
                  '{"prompt": "the red-haired woman rows", "refs": [1], "cast": ["char:alice", "char:nobody"], ' +
                  '"subjects": [{"id": "char:alice", "noun": "the red-haired woman"}, {"id": "char:nobody", "noun": "a stranger"}]}',
              },
            },
          ],
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const plan = await textGenerationService.composeImagePrompt(model, {
      scene: "…",
      images: [{ id: "a.png" }],
      cast: [{ ref: "char:alice", name: "Alice", anchors: [1] }],
    });
    expect(plan?.cast).toEqual(["char:alice"]);
    expect(plan?.subjects).toEqual([{ ref: "char:alice", noun: "the red-haired woman" }]);
  });

  it("drops reference numbers outside the catalogue and duplicates", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonRes({ choices: [{ message: { content: '{"prompt": "x", "refs": [1, 1, 7, 0, "two"]}' } }] }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const plan = await textGenerationService.composeImagePrompt(model, {
      scene: "…",
      images: [{ id: "a.png" }, { id: "b.png" }],
    });
    expect(plan?.refs).toEqual([1]);
  });

  it("falls back to the prompt text when the model sent no name", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: '{"prompt": "a snowy pine ridge", "refs": []}' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const plan = await textGenerationService.composeImagePrompt(model, { scene: "…", images: [] });
    expect(plan?.name).toBe("a snowy pine ridge");
  });

  it("answers null when the reply holds no readable plan", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: "I would draw a boat, I think." } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(textGenerationService.composeImagePrompt(model, { scene: "…", images: [] })).resolves.toBeNull();
  });

  it("answers null when the plan has no prompt to draw", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes({ choices: [{ message: { content: '{"refs": [1]}' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      textGenerationService.composeImagePrompt(model, { scene: "…", images: [{ id: "a.png" }] }),
    ).resolves.toBeNull();
  });
});
