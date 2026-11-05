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
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ImageJob } from "../image_generation/ImageJob";
import { ImageJobResult } from "../image_generation/ImageJobResult";
import { PersonsService } from "../persons/PersonsService";
import { PathHelper } from "../shared/PathHelper";
import { ImageMetaFile } from "../shared/ImageMetaFile";
import { ImageBrief, ImagePromptPlan, TextGenerationService } from "../text_generation/TextGenerationService";
import { ReplyService } from "./ReplyService";

// The image ids are paths relative to the data folder and only the ids inside
// it are accepted, so the whole suite runs against a temp data root (the
// helpers read the env on every call — see beforeEach below).

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

// The config is stubbed: the reply flow reads it only for the model
// resolution (resolveChatModel) — no real config.json is involved.
class StubConfigurationService extends ConfigurationService {
  loadConfig(): Config {
    return { listen: "127.0.0.1:3210", llmModels: { m1: model() }, imageGenerators: [] };
  }
}

// The model client stubbed: answers with a canned text and records the history
// it was called with. `modelGate` lets a test park the "model call" (the gate
// promise) and apply a concurrent change in the meantime. The picture-planning
// call is stubbed the same way (plan / planGate) and records what the model was
// told about the conversation.
class StubTextGeneration extends TextGenerationService {
  replyText = "Hello from the stub.";
  lastHistory: ChatMessage[] = [];
  modelGate: Promise<void> = Promise.resolve();

  plan: ImagePromptPlan | null = {
    name: "a red boat at dusk",
    description: "a red boat on a calm lake at dusk",
    prompt: "a red boat on a calm lake, the sky orange, low evening light",
    refs: [],
  };
  planInput: { scene: string; images: ImageBrief[] } | null = null;
  planCalls = 0;
  planGate: Promise<void> = Promise.resolve();

  constructor() {
    super(new StubConfigurationService());
  }

  async chatCompletion(_model: Model, _system: string, history: ChatMessage[]): Promise<string> {
    this.lastHistory = history;
    await this.modelGate;
    return this.replyText;
  }

  async composeImagePrompt(
    _model: Model,
    input: { scene: string; images: ImageBrief[] },
  ): Promise<ImagePromptPlan | null> {
    this.planCalls++;
    this.planInput = { scene: input.scene, images: input.images };
    await this.planGate;
    return this.plan;
  }
}

// A parkable gate: the promise the stub awaits and the release to let it run.
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

// Yields to the event loop so the parked call is surely on the gate.
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// What a job was started with (the ids the service handed down).
type StartedJob = { id: string; prompt: string; refs: string[]; chatId?: string };

// A fake of the image generation service: no real generator is spawned — the
// jobs settle through the configured outcome (setImmediate later) and the test
// reads back the ids and prompts the job was given.
function makeFakeImageGeneration() {
  const started: StartedJob[] = [];
  const cancelled: string[] = [];
  // The job registered for an image id, as the real registry keeps it: the
  // card is updated only by the job that is still current.
  const current = new Map<string, ImageJob>();
  let outcome: ImageJobResult = { status: "ok" };
  let available = true;
  let promptGate: Promise<void> = Promise.resolve();

  const fake = {
    hasAvailableGenerator: (): boolean => available,
    startImageJob: (opts: { id: string; prompt: string; refs: string[]; chatId?: string }): ImageJob => {
      started.push({ id: opts.id, prompt: opts.prompt, refs: opts.refs, chatId: opts.chatId });
      let cancelledFlag = false;
      const result = new Promise<ImageJobResult>((resolve) => {
        setImmediate(() => {
          if (current.get(opts.id) === job) current.delete(opts.id);
          resolve(cancelledFlag ? { status: "cancelled", hadOld: false } : outcome);
        });
      });
      const job: ImageJob = { result, cancel: () => (cancelledFlag = true) };
      current.set(opts.id, job);
      return job;
    },
    getCurrentJob: (id: string): ImageJob | undefined => current.get(id),
    cancelJob: (id: string): boolean => {
      cancelled.push(id);
      current.delete(id);
      return true;
    },
    ensureEnglishPrompt: async (_model: Model | null, prompt: string): Promise<string> => {
      await promptGate;
      return prompt;
    },
  };

  return {
    imageGeneration: fake as unknown as ImageGenerationService,
    started,
    cancelled,
    setOutcome: (o: ImageJobResult) => {
      outcome = o;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    setPromptGate: (g: Promise<void>) => {
      promptGate = g;
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
  process.env.SILLYTALK_DATA_DIR = root;
  chats = new ChatsService(() => path.join(root, "chats"), new StubConfigurationService());
  characters = new CharactersService(() => path.join(root, "characters"));
  persons = new PersonsService(() => path.join(root, "users"));
  characters.save({ id: "alice", name: "Alice", description: "A test character." });
  persons.save({ id: "me", name: "Me", description: "" });
  textGeneration = new StubTextGeneration();
  fake = makeFakeImageGeneration();
  imageGeneration = fake.imageGeneration;
  reply = new ReplyService(characters, persons, chats, textGeneration, imageGeneration, new StubConfigurationService());
});

afterEach(async () => {
  // Let the fire-and-forget job.result.then(...) callbacks of the tests that
  // did not flush settle while the database is still open (close() is final:
  // a callback landing after it would hit the closed database).
  await new Promise((resolve) => setImmediate(resolve));
  chats.close();
  delete process.env.SILLYTALK_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

// Lets the fire-and-forget background work settle: the planning call, the
// placeholder rename and the job's result callback (the fake jobs settle
// through setImmediate). `turns` is how many times around the loop to make —
// one less is a look at the state while a job is still in flight.
async function flushJobs(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A fresh chat with one user message in it.
function newChat(): Chat {
  const chat = chats.create(["alice"], "m1", "me");
  chat.messages.push({ id: "u1", role: "user", userId: "me", kind: "text", text: "Hi", images: [], timestamp: 1 });
  chats.save(chat);
  return chats.get(chat.id)!;
}

// A chat with one pending image card (the picture is already drawn or about to
// be, the card is what the picture actions work on).
function chatWithCard(opts: { prompt?: string; refs?: string[]; status?: "pending" | "failed" } = {}): {
  chat: Chat;
  message: ChatMessage;
  image: string;
} {
  const chat = newChat();
  const image = chats.reservedImageId(chat.id, opts.prompt ?? "a red fox");
  chats.addImageMessage(chat, image, {
    description: "a red fox in the snow",
    generation: { prompt: opts.prompt ?? "a red fox", refs: opts.refs, source: "manual" },
    status: opts.status ?? "pending",
  });
  const fresh = chats.get(chat.id)!;
  return { chat: fresh, message: fresh.messages[1], image };
}

describe("appendAssistantReply", () => {
  it("appends the assistant reply under the character and saves the chat", async () => {
    const chat = newChat();
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    expect(msg?.role).toBe("assistant");
    expect(msg?.kind).toBe("text");
    expect(msg?.characterId).toBe("alice");
    expect(msg?.text).toBe("Hello from the stub.");
    const saved = chats.get(chat.id)!;
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1].text).toBe("Hello from the stub.");
  });

  it("a character reply carries no picture: only the user shares images", async () => {
    const chat = newChat();
    // the user shared a picture right before the reply — the character still
    // answers with words, it has nothing to attach or draw
    chats.addImageMessage(chats.get(chat.id)!, chats.reservedImageId(chat.id, "a red boat"), {
      description: "a red boat",
    });
    const msg = await reply.appendAssistantReply(chats.get(chat.id)!, model(), "alice");
    expect(msg?.images).toEqual([]);
    expect(msg?.imageStatus).toBeUndefined();
    expect(msg?.generation).toBeUndefined();
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

  it("a character switched out of the chat keeps its name on the lines it already said", async () => {
    characters.save({ id: "bob", name: "Bob", description: "Another test character." });
    const chat = chats.create(["bob"], "m1", "me");
    chat.messages.push(
      { id: "u1", role: "user", userId: "me", kind: "text", text: "Hi", images: [], timestamp: 1 },
      { id: "b1", role: "assistant", characterId: "bob", kind: "text", text: "Hey.", images: [], timestamp: 2 },
    );
    chats.save(chat);
    // Bob is out of the chat: the history he wrote stays, only the new replies
    // stop coming from him.
    const switched = chats.get(chat.id)!;
    switched.characterIds = ["alice"];
    chats.save(switched);

    const msg = await reply.appendAssistantReply(chats.get(chat.id)!, model(), "alice");
    expect(msg?.characterId).toBe("alice");
    // the model still reads whose line it is — the author is resolved through
    // the catalog, not the current participant list
    const bobsLine = textGeneration.lastHistory.find((m) => m.id === "b1");
    expect(bobsLine?.text).toBe("Bob: Hey.");
    expect(bobsLine?.characterId).toBe("bob");
  });

  it("strips a copied author-name prefix from the reply", async () => {
    const chat = newChat();
    textGeneration.replyText = "Alice: hello there";
    const msg = await reply.appendAssistantReply(chat, model(), "alice");
    expect(msg?.text).toBe("hello there");
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

  it("does not clobber a message deleted while the model call ran", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.modelGate = g.promise;
    const p = reply.appendAssistantReply(chat, model(), "alice");
    await tick(); // the model call is parked on the gate
    // The user deletes the message while the model is "running".
    chats.deleteMessage(chats.get(chat.id)!, "u1", true);
    g.release();
    const msg = await p;
    expect(msg).not.toBeNull();
    // The deletion survives: the reply is saved into the re-read chat, not
    // the request-time snapshot (which still carried u1).
    expect(chats.get(chat.id)!.messages.map((m) => m.id)).toEqual([msg!.id]);
  });

  it("returns null when the chat is deleted while the model call ran", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.modelGate = g.promise;
    const p = reply.appendAssistantReply(chat, model(), "alice");
    await tick();
    chats.delete(chat.id);
    g.release();
    await expect(p).resolves.toBeNull();
  });

  it("replaceLast keeps the replaced message deleted when it was deleted in the meantime", async () => {
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
    const g = gate();
    textGeneration.modelGate = g.promise;
    const p = reply.appendAssistantReply(chats.get(chat.id)!, model(), "alice", undefined, true);
    await tick();
    chats.deleteMessage(chats.get(chat.id)!, "old", true);
    g.release();
    const msg = await p;
    expect(msg).not.toBeNull();
    expect(chats.get(chat.id)!.messages.map((m) => m.id)).toEqual(["u1", msg!.id]);
  });
});

describe("attachUserImages", () => {
  it("stores the typed caption first, then one card per picture", () => {
    const chat = newChat();
    const first = "data:image/png;base64,aGVsbG8=";
    const second = "data:image/jpeg;base64,aGVsbG8=";
    const result = reply.attachUserImages(chat.id, "look at these", [first, second]);
    expect(result).not.toBeNull();
    const stored = chats.get(chat.id)!.messages;
    expect(stored.map((m) => m.kind)).toEqual(["text", "text", "image", "image"]);
    expect(stored[1].text).toBe("look at these");
    expect(stored[1].images).toEqual([]);
    // every picture is a card of its own, under the active persona, with a
    // file inside the chat folder addressed by its id
    const [cardA, cardB] = stored.slice(2);
    expect(cardA.userId).toBe("me");
    expect(cardA.images).toHaveLength(1);
    expect(cardB.images[0]).not.toBe(cardA.images[0]);
    for (const card of [cardA, cardB]) {
      expect(card.generation?.source).toBe("upload");
      expect(fs.existsSync(PathHelper.resolveImageId(card.images[0])!)).toBe(true);
    }
  });

  it("a bare attachment makes a card and no empty caption message", () => {
    const chat = newChat();
    reply.attachUserImages(chat.id, "   ", ["data:image/png;base64,aGVsbG8="]);
    const stored = chats.get(chat.id)!.messages;
    expect(stored.map((m) => m.kind)).toEqual(["text", "image"]);
  });

  it("a caption with no pictures is an ordinary text message", () => {
    const chat = newChat();
    const result = reply.attachUserImages(chat.id, "just words", []);
    expect(result!.messages.map((m) => m.kind)).toEqual(["text"]);
  });

  it("garbage in the image list is dropped, not stored as a broken card", () => {
    const chat = newChat();
    const result = reply.attachUserImages(chat.id, "mixed", ["data:image/png;base64,aGVsbG8=", 42, null, "no-such.png"]);
    expect(result!.messages).toHaveLength(2); // the caption + one card
  });

  it("returns null when the chat is gone", () => {
    const chat = newChat();
    chats.delete(chat.id);
    expect(reply.attachUserImages(chat.id, "hi", [])).toBeNull();
  });
});

describe("manualImage", () => {
  it("appends a pending card whose file name comes from the prompt and starts the job", async () => {
    const chat = newChat();
    const result = await reply.manualImage(chat, "a red fox in the snow", []);
    expect(result).not.toBeNull();
    const { chat: saved, message } = result!;
    expect(message.kind).toBe("image");
    expect(message.images).toHaveLength(1);
    const id = message.images[0];
    // a readable, english, 2–5 word name — not a random id
    expect(id).toMatch(/\/a-red-fox-in-the-[0-9a-f]{6}\.png$/);
    expect(message.imageStatus).toEqual({ [id]: "pending" });
    expect(message.generation).toMatchObject({ prompt: "a red fox in the snow", source: "manual", model: "m1" });
    expect(fake.started).toEqual([{ id, prompt: "a red fox in the snow", refs: [], chatId: chat.id }]);
    expect(chats.get(chat.id)!.messages).toHaveLength(2);
    expect(saved.id).toBe(chat.id);
    // nothing was written to the reserved name yet — the card is the placeholder
    expect(fs.existsSync(PathHelper.resolveImageId(id)!)).toBe(false);
  });

  it("carries the reference ids into the job and into the sidecar", async () => {
    const chat = newChat();
    const ref = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a harbour" });
    await reply.manualImage(chat, "the same harbour at night", [ref]);
    const job = fake.started[0];
    expect(job.refs).toEqual([ref]);
    // the picture itself is still ahead (the job writes it), but its story is
    // already next to the name it will appear under
    expect(ImageMetaFile.read(PathHelper.resolveImageId(job.id)!)).toMatchObject({
      prompt: "the same harbour at night",
      refs: [ref],
      source: "manual",
    });
    expect(fs.existsSync(PathHelper.resolveImageId(job.id)!)).toBe(false);
  });

  it("clears the pending status when the job finishes ok", async () => {
    const chat = newChat();
    const { message } = (await reply.manualImage(chat, "a red fox", []))!;
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    expect(savedMsg.imageStatus).toBeUndefined();
  });

  it("marks the card failed with the error when the job fails", async () => {
    fake.setOutcome({ status: "failed", error: "GPU exploded", hadOld: false });
    const chat = newChat();
    const { message } = (await reply.manualImage(chat, "a red fox", []))!;
    const id = message.images[0];
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    expect(savedMsg.imageStatus).toEqual({ [id]: "failed" });
    expect(savedMsg.imageErrors).toEqual({ [id]: "GPU exploded" });
  });

  it("keeps the card ready when a run is cancelled and an older image existed", async () => {
    fake.setOutcome({ status: "cancelled", hadOld: true });
    const chat = newChat();
    const { message } = (await reply.manualImage(chat, "a red fox", []))!;
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    expect(savedMsg.imageStatus).toBeUndefined();
  });

  it("does not clobber a message deleted while the translation ran", async () => {
    const chat = newChat();
    const g = gate();
    fake.setPromptGate(g.promise);
    const p = reply.manualImage(chat, "a red fox", []);
    await tick(); // the translation is parked on the gate
    chats.deleteMessage(chats.get(chat.id)!, "u1", true);
    g.release();
    const result = await p;
    expect(result).not.toBeNull();
    expect(chats.get(chat.id)!.messages.map((m) => m.id)).toEqual([result!.message.id]);
  });

  it("returns null when the chat is deleted while the translation ran", async () => {
    const chat = newChat();
    const g = gate();
    fake.setPromptGate(g.promise);
    const p = reply.manualImage(chat, "a red fox", []);
    await tick();
    chats.delete(chat.id);
    g.release();
    await expect(p).resolves.toBeNull();
  });
});

describe("requestUserTurnImage (the picture of the user's turn)", () => {
  it("puts a pending placeholder card in the chat and returns at once", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.planGate = g.promise; // the planning call "thinks"
    const saved = reply.requestUserTurnImage(chat.id)!;
    const card = saved.messages[saved.messages.length - 1];
    expect(card.kind).toBe("image");
    expect(card.imageStatus?.[card.images[0]]).toBe("pending");
    expect(card.generation).toMatchObject({ source: "auto", model: "m1" });
    expect(card.images[0]).toMatch(/\/a-picture-for-the-conversation-[0-9a-f]{6}\.png$/);
    // the planning runs in the background: nothing has been generated yet
    expect(fake.started).toHaveLength(0);
    g.release();
    await flushJobs();
  });

  it("does not block the user: a message sent meanwhile survives the background run", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.planGate = g.promise;
    reply.requestUserTurnImage(chat.id);
    await tick();
    // the user keeps typing and sends their own line while the picture is planned
    chats.addUserMessage(chats.get(chat.id)!, "my own message");
    g.release();
    await flushJobs();
    const stored = chats.get(chat.id)!.messages;
    expect(stored.map((m) => m.text)).toContain("my own message");
    expect(fake.started).toHaveLength(1);
  });

  it("renames the placeholder to the plan's name, fills the card and starts the job", async () => {
    const chat = newChat();
    const saved = reply.requestUserTurnImage(chat.id)!;
    const placeholder = saved.messages[saved.messages.length - 1].images[0];
    await flushJobs(1); // the plan is in and the job is on its way, its answer is not
    const started = chats.get(chat.id)!.messages[1];
    expect(started.images).toEqual([expect.stringMatching(/\/a-red-boat-at-dusk-[0-9a-f]{6}\.png$/)]);
    expect(started.images[0]).not.toBe(placeholder);
    expect(started.id).toBe(saved.messages[1].id); // the same card, not a new message
    expect(started.text).toBe("a red boat on a calm lake at dusk");
    expect(started.generation).toMatchObject({
      prompt: "a red boat on a calm lake, the sky orange, low evening light",
      source: "auto",
    });
    expect(started.imageStatus).toEqual({ [started.images[0]]: "pending" });
    expect(fake.started).toEqual([
      {
        id: started.images[0],
        prompt: "a red boat on a calm lake, the sky orange, low evening light",
        refs: [],
        chatId: chat.id,
      },
    ]);

    await flushJobs();
    const done = chats.get(chat.id)!.messages[1];
    expect(done.imageStatus).toBeUndefined(); // the job settled ok — the card is ready
    // nothing is left behind under the placeholder name
    expect(fs.existsSync(`${PathHelper.resolveImageId(placeholder) as string}.json`)).toBe(false);
  });

  it("asks the model with the dialogue and the numbered catalogue of existing pictures", async () => {
    const chat = newChat();
    const photo = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a harbour" });
    chats.addImageMessage(chats.get(chat.id)!, photo, { description: "a harbour at dusk" });
    textGeneration.plan = {
      name: "the same harbour by moonlight",
      description: "the harbour under the moon",
      prompt: "the same harbour at night, moonlight",
      refs: [1],
    };
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    expect(textGeneration.planInput?.scene).toContain("Characters: Alice");
    expect(textGeneration.planInput?.scene).toContain("Me: Hi");
    expect(textGeneration.planInput?.scene).toContain("[shares a picture: a harbour at dusk]");
    // the only card in the text is the one that exists — the empty placeholder
    // the app just made is not part of the dialogue
    expect(textGeneration.planInput?.scene.match(/\[shares a picture/g)).toHaveLength(1);
    expect(textGeneration.planInput?.images).toHaveLength(1);
    expect(textGeneration.planInput?.images[0]).toMatchObject({
      id: photo,
      description: "a harbour at dusk",
      owner: "Me",
      origin: "uploaded",
    });
    // the reference number became the picture's id
    expect(fake.started[0].refs).toEqual([photo]);
    // and the card knows what it was drawn from, with its reference
    const card = chats.get(chat.id)!.messages[2];
    expect(card.generation?.refs).toEqual([photo]);
    expect(ImageMetaFile.read(PathHelper.resolveImageId(card.images[0]) as string)).toMatchObject({
      description: "the harbour under the moon",
      prompt: "the same harbour at night, moonlight",
      refs: [photo],
      source: "auto",
    });
  });

  it("the card being filled is not offered to the model as its own reference", async () => {
    const chat = newChat();
    reply.requestUserTurnImage(chat.id);
    await flushJobs();
    expect(textGeneration.planInput?.images).toEqual([]);
  });

  it("a picture whose file is gone is left out of the catalogue", async () => {
    const chat = newChat();
    const missing = chats.reservedImageId(chat.id, "a vanished picture");
    chats.addImageMessage(chats.get(chat.id)!, missing, { description: "what it showed" });
    reply.requestUserTurnImage(chat.id);
    await flushJobs();
    expect(textGeneration.planInput?.images).toEqual([]);
  });

  it("marks the card failed when the model gives no readable plan", async () => {
    const chat = newChat();
    textGeneration.plan = null;
    const saved = reply.requestUserTurnImage(chat.id)!;
    const card = saved.messages[1];
    await flushJobs();
    const stored = chats.get(chat.id)!.messages[1];
    expect(stored.id).toBe(card.id);
    expect(stored.imageStatus).toEqual({ [card.images[0]]: "failed" });
    expect(stored.imageErrors?.[card.images[0]]).toMatch(/did not describe a picture/);
    expect(fake.started).toHaveLength(0);
  });

  it("a card the user cancelled while the model thought stays cancelled and is never drawn", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.planGate = g.promise;
    const saved = reply.requestUserTurnImage(chat.id)!;
    const card = saved.messages[1];
    await tick();
    reply.cancelImage(chats.get(chat.id)!, card, card.images[0]);
    g.release();
    await flushJobs();
    const stored = chats.get(chat.id)!.messages[1];
    expect(stored.imageStatus).toEqual({ [card.images[0]]: "cancelled" });
    expect(stored.images).toEqual([card.images[0]]); // it kept its placeholder name
    expect(fake.started).toHaveLength(0);
  });

  it("a deleted card is not resurrected by the background run", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.planGate = g.promise;
    const saved = reply.requestUserTurnImage(chat.id)!;
    const card = saved.messages[1];
    await tick();
    chats.deleteMessage(chats.get(chat.id)!, card.id, true);
    g.release();
    await flushJobs();
    expect(chats.get(chat.id)!.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(fake.started).toHaveLength(0);
  });

  it("returns null for a chat that is not there", () => {
    expect(reply.requestUserTurnImage("nope")).toBeNull();
  });
});

describe("regenerateImage", () => {
  it("cancels the in-flight job, re-marks pending on the same id and starts a new job", async () => {
    const { chat, message, image } = chatWithCard();
    const fresh = await reply.regenerateImage(chat, message, image);
    expect(fake.cancelled).toEqual([image]);
    expect(fake.started).toEqual([{ id: image, prompt: "a red fox", refs: [], chatId: chat.id }]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageStatus).toEqual({ [image]: "pending" });
    expect(msg.generation).toMatchObject({ prompt: "a red fox", source: "manual" });
  });

  it("clears a stored error when the regeneration restarts", async () => {
    const { chat, message, image } = chatWithCard();
    chats.setMessageImageStatus(chat.id, message.id, image, "failed", "GPU exploded");
    const fresh = await reply.regenerateImage(chats.get(chat.id)!, message, image);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageErrors).toBeUndefined();
    expect(msg.imageStatus).toEqual({ [image]: "pending" });
  });

  it("keeps the references of the original draw", async () => {
    const ref = chats.saveImage(newChat().id, "data:image/png;base64,aGVsbG8=", { nameHint: "a harbour" });
    const { chat, message, image } = chatWithCard({ refs: [ref] });
    await reply.regenerateImage(chat, message, image);
    expect(fake.started[0].refs).toEqual([ref]);
  });

  it("returns null when the chat is deleted in the meantime", async () => {
    const { chat, message, image } = chatWithCard();
    chats.delete(chat.id);
    const fresh = await reply.regenerateImage(chat, message, image);
    expect(fresh).toBeNull();
  });

  it("regenerates with a user-typed prompt override and stores it everywhere", async () => {
    const { chat, message, image } = chatWithCard();
    const fresh = await reply.regenerateImage(chat, message, image, "a blue fox");
    expect(fake.started).toEqual([{ id: image, prompt: "a blue fox", refs: [], chatId: chat.id }]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.generation).toMatchObject({ prompt: "a blue fox" });
    expect(msg.imageStatus).toEqual({ [image]: "pending" });
    // the sidecar next to the picture keeps pace with the card
    expect(ImageMetaFile.read(PathHelper.resolveImageId(image) as string)).toMatchObject({
      description: "a red fox in the snow",
      prompt: "a blue fox",
    });
  });

  it("falls back to the card's description when it has no prompt (an uploaded photo)", async () => {
    const chat = newChat();
    const photo = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a photo" });
    chats.addImageMessage(chats.get(chat.id)!, photo, { description: "a red boat" });
    const fresh = chats.get(chat.id)!;
    const card = fresh.messages[1];
    await reply.regenerateImage(fresh, card, photo);
    expect(fake.started).toEqual([{ id: photo, prompt: "a red boat", refs: [], chatId: chat.id }]);
  });
});

describe("editPicture", () => {
  it("edits the description and the prompt of a card, in the row and in the sidecar", async () => {
    const { chat, message, image } = chatWithCard();
    const fresh = reply.editPicture(chat, message, { description: "a fox at dawn", prompt: "a red fox at dawn" });
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.text).toBe("a fox at dawn");
    expect(msg.generation).toMatchObject({ prompt: "a red fox at dawn" });
    expect(ImageMetaFile.read(PathHelper.resolveImageId(image) as string)).toMatchObject({
      description: "a fox at dawn",
      prompt: "a red fox at dawn",
    });
  });

  it("edits the description alone, leaving the prompt as it was", () => {
    const { chat, message } = chatWithCard({ prompt: "a red fox" });
    const fresh = reply.editPicture(chat, message, { description: "what it shows" });
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.text).toBe("what it shows");
    expect(msg.generation?.prompt).toBe("a red fox");
  });

  it("returns null when the card is gone", () => {
    const { chat, message } = chatWithCard();
    chats.deleteMessage(chat, message.id, true);
    expect(reply.editPicture(chat, message, { description: "x" })).toBeNull();
  });
});

describe("replaceImage", () => {
  it("saves the data URL as a new file, swaps it in and drops the generation data", () => {
    const { chat, message, image } = chatWithCard();
    const result = reply.replaceImage(chat, message, image, "data:image/png;base64,aGVsbG8=");
    expect(result).not.toBeNull();
    const saved = result!.messages.find((m) => m.id === message.id)!;
    expect(saved.images).toHaveLength(1);
    const id = saved.images[0];
    expect(id).toMatch(/\/img-[0-9a-f]{6}\.png$/);
    expect(id).not.toBe(image);
    // the picture is the user's own now — no prompt, no generation state
    expect(saved.generation).toBeUndefined();
    expect(saved.imageStatus).toBeUndefined();
    expect(fs.existsSync(PathHelper.resolveImageId(id)!)).toBe(true);
  });

  it("keeps the old file on disk (it may be referenced elsewhere)", () => {
    const { chat, message, image } = chatWithCard();
    const oldPath = PathHelper.resolveImageId(image)!;
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "old");
    reply.replaceImage(chat, message, image, "data:image/png;base64,aGVsbG8=");
    expect(fs.existsSync(oldPath)).toBe(true);
  });

  it("returns null when the chat or the message disappeared in the meantime", () => {
    const { chat, message, image } = chatWithCard();
    chats.deleteMessage(chat, message.id, true);
    expect(reply.replaceImage(chat, message, image, "data:image/png;base64,aGVsbG8=")).toBeNull();
  });
});

describe("resolveChatModel", () => {
  it("returns the model the chat references", () => {
    const chat = newChat();
    expect(reply.resolveChatModel(chat)?.name).toBe("m1");
  });

  it("falls back to the first model when the chat model is gone", () => {
    const chat = newChat();
    chat.modelId = "renamed-away";
    expect(reply.resolveChatModel(chat)?.name).toBe("m1");
  });
});

describe("saveErrorMessage", () => {
  it("appends the visible error line under the character and saves the chat", () => {
    const chat = newChat();
    const fresh = reply.saveErrorMessage(chat.id, "alice", "GPU exploded");
    expect(fresh).not.toBeNull();
    const msg = fresh!.messages[fresh!.messages.length - 1];
    expect(msg.error).toBe(true);
    expect(msg.kind).toBe("text");
    expect(msg.characterId).toBe("alice");
    expect(msg.text).toBe("⚠️ Error: GPU exploded");
    expect(chats.get(chat.id)!.messages).toHaveLength(2);
  });

  it("returns null when the chat was deleted in the meantime", () => {
    const chat = newChat();
    chats.delete(chat.id);
    expect(reply.saveErrorMessage(chat.id, "alice", "boom")).toBeNull();
  });
});

describe("cancelImage", () => {
  it("cancels the job and marks the image cancelled with the reason", () => {
    const { chat, message, image } = chatWithCard();
    const fresh = reply.cancelImage(chat, message, image);
    expect(fake.cancelled).toEqual([image]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageStatus).toEqual({ [image]: "cancelled" });
    expect(msg.imageErrors).toEqual({ [image]: "Generation cancelled" });
  });

  it("is a no-op when the image is not pending", () => {
    const { chat, message, image } = chatWithCard();
    // The route always hands the service a freshly read chat — re-read after
    // the status is cleared (the in-memory copy would still say "pending").
    chats.setMessageImageStatus(chat.id, message.id, image, undefined);
    const freshChat = chats.get(chat.id)!;
    const card = freshChat.messages.find((m) => m.id === message.id)!;
    const fresh = reply.cancelImage(freshChat, card, image);
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
