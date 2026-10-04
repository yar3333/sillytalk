import fs from "fs";
import os from "os";
import path from "path";
import { CharactersService } from "../characters/CharactersService";
import { Chat } from "../chats/Chat";
import { ChatMessage } from "../chats/ChatMessage";
import { ChatsService } from "../chats/ChatsService";
import { Config } from "../configuration/Config";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Model } from "../configuration/Model";
import { ImageGenerationService, InventoryItem } from "../image_generation/ImageGenerationService";
import { ImageJob } from "../image_generation/ImageJob";
import { ImageJobResult } from "../image_generation/ImageJobResult";
import { PersonsService } from "../persons/PersonsService";
import { TextGenerationService } from "../text_generation/TextGenerationService";
import { ReplyService } from "./ReplyService";

function model(): Model {
  return {
    name: "m1",
    id: "m1-id",
    baseUrl: "http://provider.test/v1",
    contextSize: 8192,
    supportsImages: false,
    reasoning: false,
    reasoningLevels: [],
  };
}

// The config is stubbed: the reply flow never reads it (the model is resolved
// by the route layer and passed in).
class StubConfigurationService extends ConfigurationService {
  loadConfig(): Config {
    return { listen: "127.0.0.1:3210", llmModels: { m1: model() }, imageGenerators: [] };
  }
}

// The model client stubbed: answers with a canned text and records the
// history it was called with.
class StubTextGeneration extends TextGenerationService {
  replyText = "Hello from the stub.";
  lastHistory: ChatMessage[] = [];
  constructor() {
    super(new StubConfigurationService());
  }
  async chatCompletion(_model: Model, _system: string, history: ChatMessage[]): Promise<string> {
    this.lastHistory = history;
    return this.replyText;
  }
}

// A fake of the image generation service: no real generator is spawned — the
// jobs settle through the configured outcome (setImmediate later), the
// inventory and the refs are canned.
function makeFakeImageGeneration() {
  const started: Array<{ chatId: string; name: string; prompt: string; refFilenames: string[] }> = [];
  const cancelled: Array<{ chatId: string; name: string }> = [];
  let nameCounter = 0;
  let outcome: ImageJobResult = { status: "ok" };
  let inventory: InventoryItem[] = [];

  const fake = {
    hasAvailableGenerator: (): boolean => true,
    imageInventory: (): InventoryItem[] => inventory,
    resolveInventoryRefs: (_chatId: string, indices: number[]): string[] => indices.map((i) => `ref-${i}.png`),
    newGeneratedImageName: (): string => `gen-${++nameCounter}.png`,
    startImageJob: (opts: { chatId: string; name: string; prompt: string; refFilenames: string[] }): ImageJob => {
      started.push(opts);
      let cancelledFlag = false;
      const result = new Promise<ImageJobResult>((resolve) => {
        setImmediate(() => resolve(cancelledFlag ? { status: "cancelled", hadOld: false } : outcome));
      });
      const job: ImageJob = { result, cancel: () => (cancelledFlag = true) };
      return job;
    },
    getCurrentJob: (): ImageJob | undefined => undefined,
    cancelJob: (chatId: string, name: string): boolean => {
      cancelled.push({ chatId, name });
      return true;
    },
    ensureEnglishPrompt: async (_model: Model | null, prompt: string): Promise<string> => prompt,
  };

  return {
    imageGeneration: fake as unknown as ImageGenerationService,
    started,
    cancelled,
    setOutcome: (o: ImageJobResult) => {
      outcome = o;
    },
    setInventory: (items: InventoryItem[]) => {
      inventory = items;
    },
  };
}

let root: string;
let chats: ChatsService;
let characters: CharactersService;
let persons: PersonsService;
let textGeneration: StubTextGeneration;
let fake: ReturnType<typeof makeFakeImageGeneration>;
let imageGeneration: ImageGenerationService;
let reply: ReplyService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-reply-"));
  chats = new ChatsService(() => path.join(root, "chats"), new StubConfigurationService());
  characters = new CharactersService(() => path.join(root, "characters"));
  persons = new PersonsService(() => path.join(root, "users"));
  characters.save({ id: "alice", name: "Alice", description: "A test character." });
  persons.save({ id: "me", name: "Me", description: "" });
  textGeneration = new StubTextGeneration();
  fake = makeFakeImageGeneration();
  imageGeneration = fake.imageGeneration;
  reply = new ReplyService(characters, persons, chats, textGeneration, imageGeneration);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Lets the fire-and-forget job.result.then(...) callbacks of the just
// started jobs run (the fake jobs settle through setImmediate).
async function flushJobs(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// A fresh chat with one user message in it.
function newChat(): Chat {
  const chat = chats.create(["alice"], "m1", "me");
  chat.messages.push({ id: "u1", role: "user", userId: "me", text: "Hi", images: [], timestamp: 1 });
  chats.save(chat);
  return chats.get(chat.id)!;
}

// A chat with a message carrying one pending generated image.
function chatWithPendingImage(): { chat: Chat; message: ChatMessage } {
  const chat = newChat();
  chat.messages.push({
    id: "m1",
    role: "assistant",
    characterId: "alice",
    text: "🖼️ Generated: a red fox",
    images: ["gen-1.png"],
    imagePrompts: { "gen-1.png": "a red fox" },
    imageStatus: { "gen-1.png": "pending" },
    timestamp: 2,
  });
  chats.save(chat);
  const fresh = chats.get(chat.id)!;
  return { chat: fresh, message: fresh.messages[1] };
}

describe("appendAssistantReply", () => {
  it("appends the assistant reply under the character and saves the chat", async () => {
    const chat = newChat();
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    expect(msg?.role).toBe("assistant");
    expect(msg?.characterId).toBe("alice");
    expect(msg?.text).toBe("Hello from the stub.");
    const saved = chats.get(chat.id)!;
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1].text).toBe("Hello from the stub.");
  });

  it("returns null and saves nothing when the character stays silent", async () => {
    const chat = newChat();
    textGeneration.replyText = "[SILENT]";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    expect(msg).toBeNull();
    expect(chats.get(chat.id)!.messages).toHaveLength(1);
  });

  it("returns null for an unknown character", async () => {
    const chat = newChat();
    const msg = await reply.appendAssistantReply(chat, model(), "nobody");
    expect(msg).toBeNull();
    expect(chats.get(chat.id)!.messages).toHaveLength(1);
  });

  it("strips a copied author-name prefix from the reply", async () => {
    const chat = newChat();
    textGeneration.replyText = "Alice: hello there";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    expect(msg?.text).toBe("hello there");
  });

  it("reserves a pending image for an [IMG] tag and starts a background job", async () => {
    const chat = newChat();
    textGeneration.replyText = "Look [IMG:a red fox in the snow]";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    const name = msg!.images[0];
    expect(name).toBe("gen-1.png");
    expect(msg!.imageStatus).toEqual({ [name]: "pending" });
    expect(msg!.imagePrompts).toEqual({ [name]: "a red fox in the snow" });
    expect(fake.started).toEqual([{ chatId: chat.id, name, prompt: "a red fox in the snow", refFilenames: [] }]);
  });

  it("clears the pending status when the job finishes ok", async () => {
    const chat = newChat();
    textGeneration.replyText = "Look [IMG:a red fox]";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === msg!.id)!;
    expect(savedMsg.imageStatus).toBeUndefined();
  });

  it("marks the image failed with the error when the job fails", async () => {
    fake.setOutcome({ status: "failed", error: "GPU exploded", hadOld: false });
    const chat = newChat();
    textGeneration.replyText = "Look [IMG:a red fox]";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    await flushJobs();
    const name = msg!.images[0];
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === msg!.id)!;
    expect(savedMsg.imageStatus).toEqual({ [name]: "failed" });
    expect(savedMsg.imageErrors).toEqual({ [name]: "GPU exploded" });
  });

  it("keeps the message ready when a run is cancelled and an older image existed", async () => {
    fake.setOutcome({ status: "cancelled", hadOld: true });
    const chat = newChat();
    textGeneration.replyText = "Look [IMG:a red fox]";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === msg!.id)!;
    expect(savedMsg.imageStatus).toBeUndefined();
  });

  it("attaches [PHOTO] images from the inventory as-is, without generation jobs", async () => {
    fake.setInventory([
      { path: "/x/photo.png", label: "Alice's photo" },
      { path: "/x/other.png", label: "Other" },
    ]);
    const chat = newChat();
    textGeneration.replyText = "Here you go [PHOTO:1,2]";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    expect(msg?.text).toBe("Here you go");
    expect(msg?.images).toEqual(["ref-1.png", "ref-2.png"]);
    expect(fake.started).toHaveLength(0);
  });

  it("replaceLast excludes the replaced message from the history and removes it after saving", async () => {
    const chat = newChat();
    chat.messages.push({
      id: "old",
      role: "assistant",
      characterId: "alice",
      text: "the old line",
      images: [],
      timestamp: 2,
    });
    chats.save(chat);
    const msg = await reply.appendAssistantReply(chat, model(), "alice", undefined, true);
    expect(msg).not.toBeNull();
    expect(textGeneration.lastHistory.map((m) => m.id)).toEqual(["u1"]);
    const saved = chats.get(chat.id)!;
    expect(saved.messages.map((m) => m.id)).toEqual(["u1", msg!.id]);
  });

  it("without replaceLast the last assistant message stays in the history", async () => {
    const chat = newChat();
    chat.messages.push({
      id: "old",
      role: "assistant",
      characterId: "alice",
      text: "the old line",
      images: [],
      timestamp: 2,
    });
    chats.save(chat);
    await reply.appendAssistantReply(chat, model(), "alice");
    expect(textGeneration.lastHistory.map((m) => m.id)).toEqual(["u1", "old"]);
  });
});

describe("manualImage", () => {
  it("appends the generated-image message with a pending status and starts the job", () => {
    const chat = newChat();
    const { chat: saved, message } = reply.manualImage(chat, "a red fox in the snow", ["ref-1.png"]);
    expect(message.text).toBe("🖼️ Generated: a red fox in the snow");
    const name = message.images[0];
    expect(message.imageStatus).toEqual({ [name]: "pending" });
    expect(message.imagePrompts).toEqual({ [name]: "a red fox in the snow" });
    expect(fake.started).toEqual([
      { chatId: chat.id, name, prompt: "a red fox in the snow", refFilenames: ["ref-1.png"] },
    ]);
    expect(chats.get(chat.id)!.messages).toHaveLength(2);
    expect(saved.id).toBe(chat.id);
  });
});

describe("regenerateImage", () => {
  it("cancels the in-flight job, re-marks pending on the same name and starts a new job", async () => {
    const { chat, message } = chatWithPendingImage();
    const fresh = await reply.regenerateImage(chat, message, "gen-1.png", model());
    expect(fake.cancelled).toEqual([{ chatId: chat.id, name: "gen-1.png" }]);
    expect(fake.started).toEqual([{ chatId: chat.id, name: "gen-1.png", prompt: "a red fox", refFilenames: [] }]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageStatus).toEqual({ "gen-1.png": "pending" });
    expect(msg.imagePrompts).toEqual({ "gen-1.png": "a red fox" });
  });

  it("clears a stored error when the regeneration restarts", async () => {
    const { chat, message } = chatWithPendingImage();
    chats.setMessageImageStatus(chat.id, message.id, "gen-1.png", "failed", "GPU exploded");
    const fresh = await reply.regenerateImage(chat, message, "gen-1.png", model());
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageErrors).toBeUndefined();
    expect(msg.imageStatus).toEqual({ "gen-1.png": "pending" });
  });

  it("returns null when the chat is deleted in the meantime", async () => {
    const { chat, message } = chatWithPendingImage();
    chats.delete(chat.id);
    const fresh = await reply.regenerateImage(chat, message, "gen-1.png", model());
    expect(fresh).toBeNull();
  });
});

describe("cancelImage", () => {
  it("cancels the job and marks the image cancelled with the reason", () => {
    const { chat, message } = chatWithPendingImage();
    const fresh = reply.cancelImage(chat, message, "gen-1.png");
    expect(fake.cancelled).toEqual([{ chatId: chat.id, name: "gen-1.png" }]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageStatus).toEqual({ "gen-1.png": "cancelled" });
    expect(msg.imageErrors).toEqual({ "gen-1.png": "Generation cancelled" });
  });

  it("is a no-op when the image is not pending", () => {
    const { chat } = chatWithPendingImage();
    // The route always hands the service a freshly read chat — re-read after
    // the status is cleared (the in-memory copy would still say "pending").
    chats.setMessageImageStatus(chat.id, "m1", "gen-1.png", undefined);
    const freshChat = chats.get(chat.id)!;
    const message = freshChat.messages[1];
    const fresh = reply.cancelImage(freshChat, message, "gen-1.png");
    expect(fake.cancelled).toHaveLength(0);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageStatus).toBeUndefined();
  });
});

describe("the in-flight reply registry", () => {
  it("cancelReply aborts the in-flight reply of the chat", () => {
    const chat = newChat();
    const ctrl = reply.beginReply(chat.id);
    expect(ctrl.signal.aborted).toBe(false);
    reply.cancelReply(chat.id);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("endReply removes only its own controller", () => {
    const chat = newChat();
    const ctrl = reply.beginReply(chat.id);
    // A foreign controller does not evict the registered one.
    reply.endReply(chat.id, new AbortController());
    reply.cancelReply(chat.id);
    expect(ctrl.signal.aborted).toBe(true);
    reply.endReply(chat.id, ctrl);
    // Nothing is in flight anymore — the cancel is a no-op.
    expect(() => reply.cancelReply(chat.id)).not.toThrow();
  });

  it("cancelReply is a no-op when nothing is generating", () => {
    expect(() => reply.cancelReply("nope")).not.toThrow();
  });
});
