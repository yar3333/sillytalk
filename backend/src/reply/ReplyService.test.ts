import fs from "fs";
import os from "os";
import path from "path";
import { CharactersService } from "../characters/CharactersService";
import { Chat } from "../chats/Chat";
import { ChatMessage } from "../chats/ChatMessage";
import { ChatsService } from "../chats/ChatsService";
import { Config } from "../configuration/Config";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { LlmModel } from "../configuration/LlmModel";
import { Model } from "../configuration/Model";
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ImageJob } from "../image_generation/ImageJob";
import { ImageJobResult } from "../image_generation/ImageJobResult";
import { PersonsService } from "../persons/PersonsService";
import { PathHelper } from "../shared/PathHelper";
import { ImageMeta, ImageGenerationRecord } from "../shared/ImageMeta";
import { ImageMetaService } from "../images/ImageMetaService";
import { ImageBrief, ImageCastMember, ImagePromptPlan, TextGenerationService } from "../text_generation/TextGenerationService";
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

// An llmModels entry beside m1, for the tests that need a second model — a
// vision model next to the blind chat model of the vision tests.
function llmModel(name: string, supportsImages: boolean): LlmModel {
  const base = model();
  return {
    id: name,
    baseUrl: base.baseUrl,
    contextSize: base.contextSize,
    supportsImages,
    reasoning: base.reasoning,
    reasoningLevels: base.reasoningLevels,
  };
}

// The models are global settings now: the config names the chat model and the
// vision model, and a chat carries neither. `vision` turns m1 into a model that
// can see pictures (the describe tests); `extra` adds entries next to m1 (a
// blind chat model plus a model that can see, which is what the vision pick is
// for); `chatModel`/`visionModel` are the global picks.
class StubConfigurationService extends ConfigurationService {
  vision = false;
  extra: Record<string, LlmModel> = {};
  chatModel?: string;
  visionModel?: string;
  // The language of the picture descriptions (a code of PICTURE_LANGUAGES).
  pictureLanguage?: string;
  loadConfig(): Config {
    return {
      listen: "127.0.0.1:3210",
      llmModels: { m1: { ...model(), supportsImages: this.vision }, ...this.extra },
      ...(this.chatModel ? { chatModel: this.chatModel } : {}),
      ...(this.visionModel ? { visionModel: this.visionModel } : {}),
      ...(this.pictureLanguage ? { pictureLanguage: this.pictureLanguage } : {}),
      imageGenerators: [],
    };
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
  // The system prompt of the last call: what the model was TOLD (the picture
  // markers and the numbered list of the character's own pictures live there),
  // which the assertions about the picture protocol read.
  lastSystem = "";
  modelGate: Promise<void> = Promise.resolve();

  plan: ImagePromptPlan | null = {
    name: "a red boat at dusk",
    description: "a red boat on a calm lake at dusk",
    prompt: "a red boat on a calm lake, the sky orange, low evening light",
    refs: [],
    cast: [],
    subjects: [],
  };
  planInput: {
    scene: string;
    images: ImageBrief[];
    cast: ImageCastMember[];
    maxRefs: number;
    style?: string;
    language?: string;
  } | null = null;
  planCalls = 0;
  planGate: Promise<void> = Promise.resolve();

  // The planner of a picture somebody asked for in their own words (the 🎨
  // dialog, a character's [IMAGE_BY_PROMPT]). It answers with the same plan
  // ON PURPOSE, description included: the app must ignore that description and
  // keep the requester's own words as the card's caption, and a stub that
  // answered with an empty one could not prove it.
  requestPlanCalls = 0;
  requestPlanInput: {
    request: string;
    context?: string;
    images: ImageBrief[];
    cast: ImageCastMember[];
    maxRefs: number;
    style?: string;
  } | null = null;
  requestPlanGate: Promise<void> = Promise.resolve();

  constructor() {
    super(new StubConfigurationService());
  }

  async chatCompletion(_model: Model, system: string, history: ChatMessage[]): Promise<string> {
    this.lastSystem = system;
    this.lastHistory = history;
    await this.modelGate;
    return this.replyText;
  }

  async composeImagePrompt(
    _model: Model,
    input: {
      scene: string;
      images: ImageBrief[];
      cast?: ImageCastMember[];
      maxRefs?: number;
      style?: string;
      language?: string;
    },
  ): Promise<ImagePromptPlan | null> {
    this.planCalls++;
    this.planInput = {
      scene: input.scene,
      images: input.images,
      cast: input.cast ?? [],
      maxRefs: input.maxRefs ?? 0,
      ...(input.style !== undefined ? { style: input.style } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
    };
    await this.planGate;
    return this.plan;
  }

  async composeImagePromptFromRequest(
    _model: Model,
    input: {
      request: string;
      context?: string;
      images: ImageBrief[];
      cast?: ImageCastMember[];
      maxRefs?: number;
      style?: string;
    },
  ): Promise<ImagePromptPlan | null> {
    this.requestPlanCalls++;
    this.requestPlanInput = {
      request: input.request,
      ...(input.context !== undefined ? { context: input.context } : {}),
      images: input.images,
      cast: input.cast ?? [],
      maxRefs: input.maxRefs ?? 0,
      ...(input.style !== undefined ? { style: input.style } : {}),
    };
    await this.requestPlanGate;
    return this.plan;
  }

  // The picture-editor helpers: canned answers that record what they were given.
  tunedPrompt = "a tuned english prompt";
  tuneInput: string | null = null;
  description = "a small red boat on a calm lake";
  describeInput: { imageId?: string; dataUrl?: string; language?: string } | null = null;
  // The model that was handed to the last describe call: the vision tests check
  // that the chat's pick, not its chat model, is what looked at the picture.
  describeModel: string | null = null;
  describeFails = false;
  describeGate: Promise<void> = Promise.resolve();

  async tunePrompt(_model: Model, text: string): Promise<string> {
    this.tuneInput = text;
    return this.tunedPrompt;
  }

  async describePicture(
    model: Model,
    input: { imageId?: string; dataUrl?: string; language?: string },
  ): Promise<string> {
    this.describeInput = input;
    this.describeModel = model.name;
    await this.describeGate;
    if (this.describeFails) throw new Error("the vision model did not answer");
    return this.description;
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

// The started jobs as plain data for a deep compare: `gone` is a function and
// its BEHAVIOUR is what deserves its own assertion (see the "notices a deleted
// chat" test), not a structural one.
const jobShapes = (jobs: StartedJob[]): Array<{ id: string; prompt: string; refs: string[] }> =>
  jobs.map(({ gone: _gone, ...rest }) => rest);

// What a job was started with (the ids the service handed down). `gone` is the
// liveness guard the job was given: a test can ask it directly whether the
// chat that owns the job still exists.
type StartedJob = { id: string; prompt: string; refs: string[]; gone: () => boolean };

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
  // What the "generator" takes as references — the reply flow sizes its plan to
  // it, so a test can ask what happens to a scene with three people on a
  // one-reference generator.
  let maxRefs = 2;
  let promptGate: Promise<void> = Promise.resolve();
  // The English pass of a planned prompt: what the service asked to translate
  // and, when a test says so, what came back instead.
  const englishPrompts: string[] = [];
  let englishAnswer: ((prompt: string) => string) | null = null;

  const fake = {
    hasAvailableGenerator: (): boolean => available,
    maxReferenceCount: (): number => maxRefs,
    startImageJob: (opts: {
      id: string;
      prompt: string;
      refs: string[];
      gone?: () => boolean;
      meta?: ImageGenerationRecord;
    }): ImageJob => {
      started.push({ id: opts.id, prompt: opts.prompt, refs: opts.refs, gone: opts.gone ?? (() => false) });
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
      englishPrompts.push(prompt);
      return englishAnswer ? englishAnswer(prompt) : prompt;
    },
  };

  return {
    imageGeneration: fake as unknown as ImageGenerationService,
    started,
    cancelled,
    englishPrompts,
    setEnglish: (answer: ((prompt: string) => string) | null) => {
      englishAnswer = answer;
    },
    setOutcome: (o: ImageJobResult) => {
      outcome = o;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    setMaxRefs: (value: number) => {
      maxRefs = value;
    },
    setPromptGate: (g: Promise<void>) => {
      promptGate = g;
    },
  };
}

let root: string;
let imageMeta: ImageMetaService;
let chats: ChatsService;
let characters: CharactersService;
let persons: PersonsService;
let textGeneration: StubTextGeneration;
let configuration: StubConfigurationService;
let fake: ReturnType<typeof makeFakeImageGeneration>;
let imageGeneration: ImageGenerationService;
let reply: ReplyService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-reply-"));
  process.env.SILLYTALK_DATA_DIR = root;
  configuration = new StubConfigurationService();
  imageMeta = new ImageMetaService(() => root);
  chats = new ChatsService(() => path.join(root, "chats"), imageMeta);
  characters = new CharactersService(
    () => path.join(root, "characters"),
    () => path.join(root, "catalogs.db"),
    imageMeta,
  );
  persons = new PersonsService(
    () => path.join(root, "users"),
    () => path.join(root, "catalogs.db"),
    imageMeta,
  );
  characters.save({ id: "alice", name: "Alice", description: "A test character." });
  persons.save({ id: "me", name: "Me", description: "" });
  textGeneration = new StubTextGeneration();
  fake = makeFakeImageGeneration();
  imageGeneration = fake.imageGeneration;
  reply = new ReplyService(
    characters,
    persons,
    chats,
    textGeneration,
    imageGeneration,
    configuration,
    imageMeta,
  );
});

// The images-table row of a picture, for the assertions about what the picture
// itself says: the card a chat shows and this row are the same data, so a test
// that wants to prove the write reached the store reads it here rather than
// through a card.
function rowOf(imageId: string): ImageMeta {
  const row = imageMeta.get(imageId);
  expect(row).not.toBeNull();
  return row as ImageMeta;
}

afterEach(async () => {
  // Let the fire-and-forget job.result.then(...) callbacks of the tests that
  // did not flush settle while the database is still open (close() is final:
  // a callback landing after it would hit the closed database).
  await new Promise((resolve) => setImmediate(resolve));
  chats.close();
  imageMeta.close();
  characters.close();
  persons.close();
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
  const chat = chats.create(["alice"], "me");
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

// A line where the user shared a picture they gave no words to (the 📎 flow):
// the line has no text of its own and its picture has no caption and no prompt —
// nothing to redraw from and nothing for a blind model to read.
function chatWithUpload(): { chat: Chat; message: ChatMessage; image: string } {
  const chat = newChat();
  reply.attachUserImages(chat.id, "", ["data:image/png;base64,aGVsbG8="]);
  const fresh = chats.get(chat.id)!;
  const message = fresh.messages[1];
  return { chat: fresh, message, image: message.images[0] };
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

  it("a line without markers is words only — no card is invented for it", async () => {
    const chat = newChat();
    // the user shared a picture right before the reply; the character answers
    // with words and asks for nothing, so the reply carries no picture of its own
    chats.addImageMessage(chats.get(chat.id)!, chats.reservedImageId(chat.id, "a red boat"), {
      description: "a red boat",
    });
    const msg = await reply.appendAssistantReply(chats.get(chat.id)!, model(), "alice");
    expect(msg?.images).toEqual([]);
    expect(msg?.imageStatus).toBeUndefined();
    expect(msg?.pictures).toBeUndefined();
    expect(fake.started).toHaveLength(0);
  });

  describe("the picture markers of a character's line", () => {
    // The character owns one picture — a file in its folder, which is what the
    // prompt lists and what [IMAGE_BY_ID] counts.
    function ownPicture(): string {
      const file = path.join(root, "characters", "alice", "photo1.jpg");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "img");
      return "characters/alice/photo1.jpg";
    }

    it("shows one of its own pictures inside its line and keeps the marker out of the words", async () => {
      const chat = newChat();
      const own = ownPicture();
      imageMeta.set(own, { description: "alice at the door" });
      textGeneration.replyText = "Look — that is me at the door.\n[IMAGE_BY_ID 1]";
      const msg = await reply.appendAssistantReply(chat, model(), "alice");
      expect(msg?.text).toBe("Look — that is me at the door.");

      const saved = chats.get(chat.id)!;
      // The picture is not a card of nobody beside the line: she shows it the way
      // she says anything else, so it rides inside her line — her name and avatar
      // over it, her words above it.
      expect(saved.messages).toHaveLength(2);
      const line = saved.messages[1];
      expect(line.role).toBe("assistant");
      expect(line.characterId).toBe("alice");
      expect(line.kind).toBe("text");
      expect(line.images).toEqual([own]);
      // what the picture says about itself is its own, not the line's words
      expect(line.pictures?.[own]?.description).toBe("alice at the door");
      // the marker left the line before it was saved, so neither the reader nor
      // the next model call ever sees a file name
      expect(saved.messages.every((m) => !m.text.includes("IMAGE_BY"))).toBe(true);
      // nothing was drawn, so no job and no status
      expect(fake.started).toHaveLength(0);
      expect(line.imageStatus).toBeUndefined();
    });

    it("puts the character's own pictures in front of the model, numbered", async () => {
      ownPicture();
      imageMeta.set("characters/alice/photo1.jpg", { description: "alice at the door" });
      const chat = newChat();
      await reply.appendAssistantReply(chat, model(), "alice");
      // The model is shown the list [IMAGE_BY_ID] counts, with what each picture
      // says it shows — that is what lets it choose between two of its own faces
      // instead of guessing, and what makes the number the marker writes mean
      // the picture the character actually has.
      expect(textGeneration.lastSystem).toContain("1. characters/alice/photo1.jpg — alice at the door");
      expect(textGeneration.lastSystem).toContain("[IMAGE_BY_ID");
    });

    it("draws a new picture into the character's own folder", async () => {
      const chat = newChat();
      textGeneration.replyText = "I painted it this morning.\n[IMAGE_BY_PROMPT рыжая лиса в снегу]";
      const msg = await reply.appendAssistantReply(chat, model(), "alice");
      expect(msg?.text).toBe("I painted it this morning.");

      const saved = chats.get(chat.id)!;
      const line = saved.messages[1];
      // The picture rides inside the line that asked for it, so the reader sees
      // the placeholder under her words the moment the reply is saved.
      expect(line.role).toBe("assistant");
      expect(line.text).toBe("I painted it this morning.");
      const id = line.images[0];
      // The picture OF the character belongs to the character: it joins the
      // starter set, so the next scene is drawn from this face.
      expect(id).toMatch(/^characters\/alice\//);
      expect(line.imageStatus).toEqual({ [id]: "pending" });
      // her words stay the line's; the request she wrote is the picture's caption
      expect(line.pictures?.[id]?.description).toBe("рыжая лиса в снегу");
      // A model wrote this request, not the user, which is what the picture
      // browser reads when it decides whether to show the prompt for editing.
      expect(line.pictures?.[id]?.generation).toMatchObject({ source: "auto" });
      // the words were handed to the planner as they were written
      expect(textGeneration.requestPlanInput?.request).toBe("рыжая лиса в снегу");

      await flushJobs();
      const after = chats.get(chat.id)!.messages[1];
      expect(after.images[0]).toMatch(/^characters\/alice\/a-red-boat-at-dusk-[0-9a-f]{6}\.png$/);
      expect(after.imageStatus).toBeUndefined();
      expect(fake.started).toHaveLength(1);
      expect(fake.started[0].id).toBe(after.images[0]);
    });

    it("a line that is only a marker says it with the picture alone", async () => {
      const chat = newChat();
      textGeneration.replyText = "[IMAGE_BY_PROMPT a cat on the windowsill]";
      const msg = await reply.appendAssistantReply(chat, model(), "alice");
      const saved = chats.get(chat.id)!;
      // The picture IS the line now — a line with a picture and no words of its
      // own, which is what the row renders — so there is something on screen and
      // no empty bubble in front of a separate card.
      expect(msg).not.toBeNull();
      expect(saved.messages).toHaveLength(2);
      expect(saved.messages[0].text).toBe("Hi");
      const line = saved.messages[1];
      expect(line.role).toBe("assistant");
      expect(line.text).toBe("");
      expect(line.images).toHaveLength(1);
      await flushJobs();
    });

    it("drops a marker that names a picture the character does not own", async () => {
      const chat = newChat();
      const theirs = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "the-user-photo" });
      textGeneration.replyText = `Yours is nicer.\n[IMAGE_BY_ID ${theirs}]`;
      const msg = await reply.appendAssistantReply(chat, model(), "alice");
      expect(msg?.text).toBe("Yours is nicer.");
      const saved = chats.get(chat.id)!;
      // The user's picture is not the character's to share, so no card appeared;
      // an invented id never becomes a card that cannot load either. And the
      // half-executed instruction is not shown to the reader or repeated back to
      // the model on the next turn.
      expect(saved.messages).toHaveLength(2);
      expect(saved.messages[1].images).toEqual([]);
      expect(saved.messages.every((m) => !m.text.includes("IMAGE_BY_ID"))).toBe(true);
    });

    it("carries at most two pictures out of one line", async () => {
      const chat = newChat();
      ownPicture();
      textGeneration.replyText =
        "One, two.\n[IMAGE_BY_ID 1]\n[IMAGE_BY_PROMPT a fox]\n[IMAGE_BY_PROMPT another fox]";
      await reply.appendAssistantReply(chat, model(), "alice");
      const saved = chats.get(chat.id)!;
      // The cap is a cap on the pictures of HER LINE, not a number of extra
      // messages: one line, two pictures, the third request dropped.
      expect(saved.messages).toHaveLength(2);
      expect(saved.messages[1].images).toHaveLength(2);
      await flushJobs();
    });
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
    const chat = chats.create(["bob"], "me");
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
  it("saves the user's words and their pictures as ONE line of theirs", () => {
    const chat = newChat();
    const first = "data:image/png;base64,aGVsbG8=";
    const second = "data:image/png;base64,d29ybGQ=";
    const result = reply.attachUserImages(chat.id, "look at these", [first, second]);
    expect(result).not.toBeNull();
    const stored = chats.get(chat.id)!.messages;
    // One message, not a caption plus orphan cards: the photos belong to the
    // words that were written about them.
    expect(stored).toHaveLength(2);
    const line = stored[1];
    expect(line.kind).toBe("text");
    expect(line.userId).toBe("me");
    expect(line.text).toBe("look at these");
    expect(line.images).toHaveLength(2);
    // Each file belongs to the PERSON who shares it: the same photo shown in
    // another chat is the same picture with the same description, and the user
    // finds it again in their own folder rather than in one conversation's. The
    // id is what says so — the line carries no ownership field.
    for (const id of line.images) {
      expect(id).toMatch(/^users\/me\/photo-[0-9a-f]{6}\.png$/);
      expect(fs.existsSync(PathHelper.resolveImageId(id)!)).toBe(true);
    }
    expect(line.images[0]).not.toBe(line.images[1]);
  });

  it("a chat with no persona has nobody's folder to write into, so the chat's own takes the file", () => {
    const chat = chats.create(["alice"], "");
    chat.messages.push({ id: "u1", role: "user", kind: "text", text: "Hi", images: [], timestamp: 1 });
    chats.save(chat);
    const result = reply.attachUserImages(chat.id, "", ["data:image/png;base64,aGVsbG8="]);
    const line = result!.message;
    expect(line.images[0]).toMatch(new RegExp(`^chats/${chat.id}/img-[0-9a-f]{6}\\.png$`));
  });

  it("a picture the user already owns is used by its existing id, not uploaded again", () => {
    const chat = newChat();
    const mine = persons.storePicture("me", "data:image/png;base64,aGVsbG8=", "my portrait");
    const result = reply.attachUserImages(chat.id, "again", ["data:image/png;base64,aGVsbG8="]);
    // The bytes are the picture, so one photo does not become a second file and
    // a second row: the line names the picture the persona already owns.
    expect(result!.message.images).toEqual([mine]);
    expect(fs.readdirSync(path.join(root, "users", "me"))).toHaveLength(1);
  });

  it("an id instead of a file is kept as it stands: a picture the app already has", () => {
    const chat = newChat();
    const photo = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a harbour" });
    const result = reply.attachUserImages(chat.id, "this one", [photo]);
    expect(result!.message.images).toEqual([photo]);
  });

  it("a bare attachment is a line with a picture and no words of its own", () => {
    const chat = newChat();
    reply.attachUserImages(chat.id, "   ", ["data:image/png;base64,aGVsbG8="]);
    const stored = chats.get(chat.id)!.messages;
    expect(stored).toHaveLength(2);
    expect(stored[1].text).toBe("");
    expect(stored[1].images).toHaveLength(1);
  });

  it("words with no pictures is an ordinary line", () => {
    const chat = newChat();
    const result = reply.attachUserImages(chat.id, "just words", []);
    expect(result!.message.kind).toBe("text");
    expect(result!.message.images).toEqual([]);
    expect(chats.get(chat.id)!.messages).toHaveLength(2);
  });

  it("garbage in the image list is dropped, not stored as a broken picture", () => {
    const chat = newChat();
    const result = reply.attachUserImages(chat.id, "mixed", ["data:image/png;base64,aGVsbG8=", 42, null, "no-such.png"]);
    expect(chats.get(chat.id)!.messages).toHaveLength(2);
    expect(result!.message.images).toHaveLength(1);
  });

  it("returns null when the chat is gone", () => {
    const chat = newChat();
    chats.delete(chat.id);
    expect(reply.attachUserImages(chat.id, "hi", [])).toBeNull();
  });
});

describe("requestPicture (a picture the user asked for in their own words)", () => {
  it("saves the pending card at once, with the request as its caption", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.requestPlanGate = g.promise; // the planning call "thinks"
    const result = reply.requestPicture(chat.id, "рыжая лиса в снегу у калитки")!;
    g.release();
    expect(result).not.toBeNull();
    const { chat: saved, message } = result;
    // A picture the user asked for is THEIR line with a pending picture in it,
    // not a card of nobody beside the conversation.
    expect(message.kind).toBe("text");
    expect(message.userId).toBe("me");
    expect(message.text).toBe("");
    const id = message.images[0];
    const line = chats.get(chat.id)!.messages[1];
    // The line says what the person asked for through its picture, in their own
    // language: the request IS the picture's description, and the English drawing
    // prompt is a separate field the plan has not even written yet.
    expect(line.pictures?.[id]?.description).toBe("рыжая лиса в снегу у калитки");
    expect(line.imageStatus).toEqual({ [id]: "pending" });
    expect(line.pictures?.[id]?.generation).toMatchObject({ source: "manual", model: "m1" });
    // The bytes of a picture the user asked for belong to the PERSON who asked,
    // exactly like a 📎 attachment — the folder in the id is what says whose it is.
    expect(id).toMatch(/^users\/me\/a-picture-[0-9a-f]{6}\.png$/);
    expect(chats.get(chat.id)!.messages).toHaveLength(2);
    expect(saved.id).toBe(chat.id);
    // nothing was written to the reserved name yet — the line is the placeholder
    expect(fs.existsSync(PathHelper.resolveImageId(id)!)).toBe(false);
    await flushJobs();
  });

  it("turns the request into a prompt and a reference set, and keeps the request as the caption", async () => {
    const chat = newChat();
    const { message } = reply.requestPicture(chat.id, "Алиса у калитки в снегу")!;
    await flushJobs();
    // What the planner was asked with: the request as it was written, the
    // dialogue around it, and the cast — so "Алиса" can be matched to the
    // picture of her face instead of a name the generator has never heard.
    expect(textGeneration.requestPlanCalls).toBe(1);
    expect(textGeneration.requestPlanInput?.request).toBe("Алиса у калитки в снегу");
    expect(textGeneration.requestPlanInput?.context).toContain("Hi");
    expect(textGeneration.requestPlanInput?.cast.map((c) => c.ref)).toEqual(["char:alice", "user:me"]);
    expect(textGeneration.requestPlanInput?.maxRefs).toBe(2);

    const saved = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    const id = saved.images[0];
    // the placeholder became the readable name the plan chose, in the same
    // (persona's) folder the picture was reserved in
    expect(id).toMatch(/^users\/me\/a-red-boat-at-dusk-[0-9a-f]{6}\.png$/);
    // The caption is STILL the user's sentence, not the description the plan
    // offered (the stub answers with one, on purpose) — and it belongs to the
    // picture, while the line's own words stay empty.
    expect(saved.text).toBe("");
    expect(saved.pictures?.[id]?.description).toBe("Алиса у калитки в снегу");
    expect(rowOf(id)).toMatchObject({
      description: "Алиса у калитки в снегу",
      prompt: "a red boat on a calm lake, the sky orange, low evening light",
      source: "manual",
    });
    expect(jobShapes(fake.started)).toEqual([
      { id, prompt: "a red boat on a calm lake, the sky orange, low evening light", refs: [] },
    ]);
  });

  it("appends the chat's style and the reference binding to the drawn prompt", async () => {
    const chat = chats.create(["alice"], "me");
    chat.messages.push({ id: "u1", role: "user", userId: "me", kind: "text", text: "Hi", images: [], timestamp: 1 });
    chat.stylePrompt = "watercolour";
    chats.save(chat);
    characters.save({ id: "alice", name: "Alice", description: "a tall woman with short red hair" });
    const photo = path.join(root, "characters", "alice", "photo1.jpg");
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, "img");
    textGeneration.plan = {
      name: "alice at the gate",
      description: "",
      prompt: "the red-haired woman at a wooden gate",
      refs: [],
      cast: ["char:alice"],
      subjects: [{ ref: "char:alice", noun: "the red-haired woman" }],
    };
    const { message } = reply.requestPicture(chat.id, "Алиса у калитки")!;
    await flushJobs();
    const saved = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    const job = fake.started[0];
    // the face goes in as a reference, and the prompt says so in the same breath
    expect(job.refs).toEqual(["characters/alice/photo1.jpg"]);
    expect(job.prompt).toContain("the first reference image shows the red-haired woman");
    expect(job.prompt).toContain("Style: watercolour");
    // the people on the picture are recorded, which is what offers this picture
    // as Alice's anchor for the next one
    expect(saved.pictures?.[saved.images[0]]?.depicts).toEqual(["char:alice"]);
  });

  it("shows the planner only the tail of a long dialogue", async () => {
    // A plan is about the next moment, and the call has to stay inside the
    // model's context: an overflow is a provider error, which the user sees as
    // a broken card instead of his picture.
    const chat = chats.create(["alice"], "me");
    for (let i = 1; i <= 40; i++) {
      chat.messages.push({ id: `m${i}`, role: "user", userId: "me", kind: "text", text: `line-${i}`, images: [], timestamp: i });
    }
    chats.save(chat);
    reply.requestPicture(chat.id, "a red fox");
    await flushJobs();

    const context = textGeneration.requestPlanInput?.context ?? "";
    // the newest message is the one the picture has to follow
    expect(context).toContain("line-40");
    // the oldest ones are gone, and the brief says so instead of pretending
    expect(context).not.toContain("line-16\n");
    expect(context).toContain("(16 earlier messages are not shown)");
  });

  it("clips one enormous message instead of letting it eat the call", async () => {
    const chat = chats.create(["alice"], "me");
    chat.messages.push({ id: "m1", role: "user", userId: "me", kind: "text", text: "x".repeat(5000), images: [], timestamp: 1 });
    chats.save(chat);
    reply.requestPicture(chat.id, "a red fox");
    await flushJobs();

    const context = textGeneration.requestPlanInput?.context ?? "";
    expect(context).toContain("…");
    expect(context.length).toBeLessThan(2000);
  });

  it("the job is given a guard that notices the chat's deletion", async () => {
    const chat = newChat();
    reply.requestPicture(chat.id, "a red fox in the snow");
    await flushJobs(); // the job starts when the plan is in, not before
    const job = fake.started[0];
    expect(job.gone()).toBe(false);
    chats.delete(chat.id);
    expect(job.gone()).toBe(true);
  });

  it("clears the pending status when the job finishes ok", async () => {
    const chat = newChat();
    const { message } = reply.requestPicture(chat.id, "a red fox")!;
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    expect(savedMsg.imageStatus).toBeUndefined();
  });

  it("marks the card failed with the error when the job fails", async () => {
    fake.setOutcome({ status: "failed", error: "GPU exploded", hadOld: false });
    const chat = newChat();
    const { message } = reply.requestPicture(chat.id, "a red fox")!;
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    const id = savedMsg.images[0];
    expect(savedMsg.imageStatus).toEqual({ [id]: "failed" });
    expect(savedMsg.imageErrors).toEqual({ [id]: "GPU exploded" });
  });

  it("marks the card broken when the model cannot plan it", async () => {
    textGeneration.plan = null;
    const chat = newChat();
    const { message } = reply.requestPicture(chat.id, "something")!;
    await flushJobs();
    const savedMsg = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    const placeholder = savedMsg.images[0];
    expect(savedMsg.imageStatus).toEqual({ [placeholder]: "failed" });
    expect(savedMsg.imageErrors?.[placeholder]).toBe("The model did not describe a picture to draw");
    expect(fake.started).toHaveLength(0);
  });

  it("leaves a card the user cancelled while the model was thinking", async () => {
    const chat = newChat();
    const g = gate();
    textGeneration.requestPlanGate = g.promise;
    const { message } = reply.requestPicture(chat.id, "a red fox")!;
    const placeholder = message.images[0];
    await tick();
    reply.cancelImage(chats.get(chat.id)!, message, placeholder);
    g.release();
    await flushJobs();
    const saved = chats.get(chat.id)!.messages.find((m) => m.id === message.id)!;
    expect(saved.imageStatus).toEqual({ [placeholder]: "cancelled" });
    // the placeholder is still the card's picture: no job ran, no file appeared
    expect(saved.images).toEqual([placeholder]);
    expect(fake.started).toHaveLength(0);
  });

  it("returns null on an empty request and on a chat that is gone", () => {
    const chat = newChat();
    expect(reply.requestPicture(chat.id, "   ")).toBeNull();
    expect(reply.requestPicture("nope", "a fox")).toBeNull();
  });
});

describe("addPictureFile (the 🖼 disk pick)", () => {
  it("saves the file into the chat's folder and answers with the ready card", () => {
    const chat = newChat();
    const result = reply.addPictureFile(chat.id, "data:image/png;base64,aGVsbG8=")!;
    const card = result.chat.messages[result.chat.messages.length - 1];
    expect(card.kind).toBe("image");
    expect(card.images[0]).toMatch(new RegExp(`^chats/${chat.id}/img-[0-9a-f]{6}\\.png$`));
    // nothing is being drawn, so there is no status — the picture is there
    expect(card.imageStatus).toBeUndefined();
    expect(card.pictures?.[card.images[0]]?.generation).toMatchObject({ source: "upload" });
    expect(fs.existsSync(PathHelper.resolveImageId(card.images[0])!)).toBe(true);
    // A file the user hands the app is a picture of the conversation, not of a
    // person: nothing was filed under the persona the way a 📎 attachment is.
    const personDir = path.join(root, "users", "me");
    expect(fs.existsSync(personDir) ? fs.readdirSync(personDir) : []).toEqual([]);
  });

  it("reuses the picture whose bytes are already in the data folders", () => {
    const chat = newChat();
    const mine = persons.storePicture("me", "data:image/png;base64,aGVsbG8=", "my portrait");
    const again = reply.addPictureFile(chat.id, "data:image/png;base64,aGVsbG8=")!;
    const card = again.chat.messages[again.chat.messages.length - 1];
    // The bytes are the picture: the card points at the file the persona already
    // owns instead of writing a second copy into the chat's folder.
    expect(card.images).toEqual([mine]);
    expect(fs.existsSync(path.join(root, "chats", chat.id))).toBe(false);
  });

  it("returns null when the payload is not a picture", () => {
    const chat = newChat();
    expect(reply.addPictureFile(chat.id, "not a data url")).toBeNull();
    expect(reply.addPictureFile("nope", "data:image/png;base64,aGVsbG8=")).toBeNull();
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
    expect(card.pictures?.[card.images[0]]?.generation).toMatchObject({ source: "auto", model: "m1" });
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
    expect(started.pictures?.[started.images[0]]?.generation).toMatchObject({
      prompt: "a red boat on a calm lake, the sky orange, low evening light",
      source: "auto",
    });
    expect(started.imageStatus).toEqual({ [started.images[0]]: "pending" });
    expect(jobShapes(fake.started)).toEqual([
      {
        id: started.images[0],
        prompt: "a red boat on a calm lake, the sky orange, low evening light",
        refs: [],
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
      cast: [],
      subjects: [],
    };
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    expect(textGeneration.planInput?.scene).toContain("Characters: Alice");
    expect(textGeneration.planInput?.scene).toContain("Me: Hi");
    // A neutral card has no author, so the brief of the dialogue says only that a
    // picture is there and what it shows. Who is IN it reaches the planner
    // through the catalogue below (by name, with their look), which is the form
    // it answers with; who a picture belongs to is written in its path and is not
    // something a drawing ever needs, so it is never said.
    expect(textGeneration.planInput?.scene).toContain("[a picture shows: a harbour at dusk]");
    expect(textGeneration.planInput?.scene).not.toContain("shared by");
    // the only card in the text is the one that exists — the empty placeholder
    // the app just made is not part of the dialogue
    expect(textGeneration.planInput?.scene.match(/\[a picture shows/g)).toHaveLength(1);
    expect(textGeneration.planInput?.images).toHaveLength(1);
    expect(textGeneration.planInput?.images[0]).toMatchObject({
      id: photo,
      description: "a harbour at dusk",
      origin: "uploaded",
    });
    // the reference number became the picture's id
    expect(fake.started[0].refs).toEqual([photo]);
    // and the app said what that reference is for, so the generator keeps the
    // conversation's look instead of starting a new one
    expect(fake.started[0].prompt).toContain("the same harbour at night, moonlight");
    expect(fake.started[0].prompt).toContain(
      "the first reference image is a picture from this conversation — keep its art style",
    );
    // and the card knows what it was drawn from, with its reference
    const card = chats.get(chat.id)!.messages[2];
    expect(card.pictures?.[card.images[0]]?.generation?.refs).toEqual([photo]);
    expect(rowOf(card.images[0])).toMatchObject({
      description: "the harbour under the moon",
      prompt: fake.started[0].prompt,
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

  it("draws a person from their own photo and never sends their name", async () => {
    // The whole point of the cast layer: the generator has never heard of Alice,
    // so her face goes to it as a picture and her name never leaves the app —
    // not even when the model disobeyed and wrote it into the prompt.
    characters.save({
      id: "alice",
      name: "Alice",
      description: "A tall woman with short red hair, always in a green coat.",
    });
    const photo = path.join(PathHelper.characterDir("alice"), "photo1.jpg");
    fs.writeFileSync(photo, "x");
    const photoId = PathHelper.imageIdOf(photo);
    textGeneration.plan = {
      name: "a woman on the pier",
      description: "a woman leaning on a pier rail at dusk",
      prompt: "Alice leans on a pier rail at dusk",
      refs: [],
      cast: ["char:alice"],
      subjects: [{ ref: "char:alice", noun: "the red-haired woman" }],
    };
    const chat = newChat();
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    // the planner was told what she looks like (the card text is the visual
    // line of her cast entry) and which picture shows her
    expect(textGeneration.planInput?.cast.find((c) => c.ref === "char:alice")).toEqual({
      ref: "char:alice",
      name: "Alice",
      look: "A tall woman with short red hair, always in a green coat.",
      anchors: [1],
    });
    const job = fake.started[0];
    // the face went with the job, and the name did not
    expect(job.refs).toEqual([photoId]);
    expect(job.prompt).not.toContain("Alice");
    expect(job.prompt).toContain("the red-haired woman leans on a pier rail at dusk");
    expect(job.prompt).toContain(
      "the first reference image shows the red-haired woman — draw them with exactly the same face, hair and outfit",
    );
    // the card says who is on it, in its picture row, so the next
    // picture of her can be drawn from this one
    const card = chats.get(chat.id)!.messages[1];
    expect(card.pictures?.[card.images[0]]?.depicts).toEqual(["char:alice"]);
    expect(rowOf(card.images[0])).toMatchObject({
      depicts: ["char:alice"],
    });
  });

  it("prefers a face this chat already drew over the character's own photo", async () => {
    // The conversation's own picture of her is the better anchor: it is the same
    // person AND the same technique, which is what makes two pictures of one
    // chat read as one story.
    const photo = path.join(PathHelper.characterDir("alice"), "photo1.jpg");
    fs.writeFileSync(photo, "x");
    const chat = newChat();
    const drawn = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "alice at the bar" });
    const withCard = chats.get(chat.id)!;
    chats.addImageMessage(withCard, drawn, { description: "Alice at the bar", depicts: ["char:alice"] });
    textGeneration.plan = {
      name: "the same woman outside",
      description: "the same woman in the street",
      prompt: "the red-haired woman in the street",
      refs: [],
      cast: ["char:alice"],
      subjects: [{ ref: "char:alice", noun: "the red-haired woman" }],
    };
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    // the chat's own picture leads (same person AND same technique), the studio
    // photo rides along as the second view of the same face while there is room
    const photoId = PathHelper.imageIdOf(photo);
    expect(textGeneration.planInput?.cast.find((c) => c.ref === "char:alice")?.anchors).toEqual([1, 2]);
    expect(fake.started[0].refs).toEqual([drawn, photoId]);
    // and both of them are named in the prompt by their order, so the generator
    // knows which image is whose
    expect(fake.started[0].prompt).toContain("the first reference image shows the red-haired woman");
    expect(fake.started[0].prompt).toContain("the second reference image shows the red-haired woman");
  });

  it("keeps the face when the generator has room for one reference only", async () => {
    fake.setMaxRefs(1);
    const photo = path.join(PathHelper.characterDir("alice"), "photo1.jpg");
    fs.writeFileSync(photo, "x");
    const chat = newChat();
    const harbour = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a harbour" });
    chats.addImageMessage(chats.get(chat.id)!, harbour, { description: "a harbour at dusk" });
    textGeneration.plan = {
      name: "the woman at the harbour",
      description: "a woman at the harbour",
      prompt: "the red-haired woman at the harbour",
      // the model asked for the harbour (picture 1) and put Alice in the scene
      refs: [1],
      cast: ["char:alice"],
      subjects: [{ ref: "char:alice", noun: "the red-haired woman" }],
    };
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    // a familiar face beats a familiar place
    expect(fake.started[0].refs).toEqual([PathHelper.imageIdOf(photo)]);
  });

  it("gives every person of a group a face before anyone a second one", async () => {
    // Two people, two reference slots, and every person owns two photos. The
    // budget has to buy two faces, not two views of one face.
    characters.save({ id: "bob", name: "Bob", description: "A broad man with a black beard." });
    for (const file of [
      path.join(PathHelper.characterDir("alice"), "photo1.jpg"),
      path.join(PathHelper.characterDir("alice"), "photo2.jpg"),
      path.join(PathHelper.characterDir("bob"), "photo1.jpg"),
      path.join(PathHelper.characterDir("bob"), "photo2.jpg"),
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "img");
    }
    const chat = chats.create(["alice", "bob"], "me");
    chat.messages.push({ id: "u1", role: "user", userId: "me", kind: "text", text: "Hi", images: [], timestamp: 1 });
    chats.save(chat);
    textGeneration.plan = {
      name: "two people on a pier",
      description: "two people on a pier at dusk",
      prompt: "the red-haired woman and the bearded man on a pier",
      refs: [],
      cast: ["char:alice", "char:bob"],
      subjects: [
        { ref: "char:alice", noun: "the red-haired woman" },
        { ref: "char:bob", noun: "the bearded man" },
      ],
    };
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    const refs = fake.started[0].refs;
    expect(refs).toHaveLength(2);
    expect(refs.some((id) => id.startsWith("characters/alice/"))).toBe(true);
    expect(refs.some((id) => id.startsWith("characters/bob/"))).toBe(true);
    // and the binding sentence names both, in the order the generator loads them
    expect(fake.started[0].prompt).toContain("the first reference image shows the red-haired woman");
    expect(fake.started[0].prompt).toContain("the second reference image shows the bearded man");
  });

  it("forces a plan that answered in the request's language into English", async () => {
    // The planner is ASKED for an English prompt, but the request is often
    // Russian (the 🎨 dialog takes any language) and models follow the language
    // they were spoken to in. The generators read English only.
    textGeneration.plan = {
      name: "a fox at the gate",
      description: "",
      prompt: "рыжая лиса у калитки",
      refs: [],
      cast: [],
      subjects: [],
    };
    fake.setEnglish(() => "a red fox at the gate");
    const chat = newChat();
    reply.requestUserTurnImage(chat.id);
    await flushJobs();

    // what was handed to the translator is the prompt the plan wrote — the
    // binding sentence and the chat style are added around it, not translated
    expect(fake.englishPrompts[0]).toBe("рыжая лиса у калитки");
    expect(fake.started[0].prompt).toBe("a red fox at the gate");
    // the row of the picture remembers what the generator was really given
    const card = chats.get(chat.id)!.messages[1];
    expect(rowOf(card.images[0]).prompt).toBe("a red fox at the gate");
  });

  it("draws every picture of a chat in the style the chat asked for", async () => {
    const chat = newChat();
    chat.stylePrompt = "watercolour, soft edges";
    chats.save(chat);
    reply.requestUserTurnImage(chat.id);
    await flushJobs();
    expect(textGeneration.planInput?.style).toBe("watercolour, soft edges");
    expect(fake.started[0].prompt).toBe(
      "a red boat on a calm lake, the sky orange, low evening light Style: watercolour, soft edges",
    );
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
    expect(jobShapes(fake.started)).toEqual([{ id: image, prompt: "a red fox", refs: [] }]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.imageStatus).toEqual({ [image]: "pending" });
    expect(msg.pictures?.[image]?.generation).toMatchObject({ prompt: "a red fox", source: "manual" });
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
    expect(jobShapes(fake.started)).toEqual([{ id: image, prompt: "a blue fox", refs: [] }]);
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.pictures?.[image]?.generation).toMatchObject({ prompt: "a blue fox" });
    expect(msg.imageStatus).toEqual({ [image]: "pending" });
    // the row of the picture keeps pace with the card
    expect(rowOf(image)).toMatchObject({
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
    expect(jobShapes(fake.started)).toEqual([{ id: photo, prompt: "a red boat", refs: [] }]);
  });
});

describe("editPicture", () => {
  it("edits the description and the prompt of one picture, in the row and in the picture row", () => {
    const { chat, message, image } = chatWithCard();
    const fresh = reply.editPicture(chat, message, image, {
      description: "a fox at dawn",
      prompt: "a red fox at dawn",
    });
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.text).toBe("a fox at dawn");
    expect(msg.pictures?.[image]?.generation).toMatchObject({ prompt: "a red fox at dawn" });
    expect(rowOf(image)).toMatchObject({
      description: "a fox at dawn",
      prompt: "a red fox at dawn",
    });
  });

  it("edits the description alone, leaving the prompt as it was", () => {
    const { chat, message, image } = chatWithCard({ prompt: "a red fox" });
    const fresh = reply.editPicture(chat, message, image, { description: "what it shows" });
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.text).toBe("what it shows");
    expect(msg.pictures?.[image]?.generation?.prompt).toBe("a red fox");
  });

  it("returns null when the line is gone, and when it shows no such picture", () => {
    const { chat, message, image } = chatWithCard();
    chats.deleteMessage(chat, message.id, true);
    expect(reply.editPicture(chat, message, image, { description: "x" })).toBeNull();
    // a line may show several pictures, so naming one that is not there edits
    // nothing rather than guessing which one the user meant
    const other = chatWithCard();
    expect(reply.editPicture(other.chat, other.message, "chats/nope/absent.png", { description: "x" })).toBeNull();
  });

  it("points the line at another picture of the data folder and drops the old generation", () => {
    const { chat, message, image } = chatWithCard({ prompt: "a red fox" });
    const oldPath = PathHelper.resolveImageId(image)!;
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "old");
    const other = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a blue boat" });
    const fresh = reply.editPicture(chat, message, image, { repointTo: other, description: "a blue boat" });
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    expect(msg.images).toEqual([other]);
    expect(msg.text).toBe("a blue boat");
    // the picture is not the one that was drawn any more
    expect(msg.pictures?.[other]?.generation).toBeUndefined();
    expect(fs.existsSync(PathHelper.resolveImageId(image)!)).toBe(true); // the old file stays
  });

  it('kind "file" clears the prompt from the picture and its row, "generated" keeps it', () => {
    const { chat, message, image } = chatWithCard({ prompt: "a red fox" });
    const asFile = reply.editPicture(chat, message, image, { kind: "file" })!;
    const cleared = asFile.messages.find((m) => m.id === message.id)!;
    expect(cleared.pictures?.[image]?.generation).toBeUndefined();
    expect(imageMeta.get(image)?.prompt).toBeUndefined();
    // persist the cleared state before reading it back (the row is what the
    // service keeps in memory here)
    chats.save(asFile);
    expect(
      chats.get(chat.id)!.messages.find((m) => m.id === message.id)!.pictures?.[image]?.generation,
    ).toBeUndefined();

    const asGenerated = reply.editPicture(chat, message, image, {
      kind: "generated",
      prompt: "a red fox at dawn",
    })!;
    const made = asGenerated.messages.find((m) => m.id === message.id)!;
    expect(made.pictures?.[image]?.generation).toMatchObject({ prompt: "a red fox at dawn", source: "manual" });
  });

  it("an empty prompt is a real edit: the picture is left with nothing to redraw from", () => {
    const { chat, message, image } = chatWithCard({ prompt: "a red fox" });
    const fresh = reply.editPicture(chat, message, image, { kind: "generated", prompt: "   " });
    const msg = fresh!.messages.find((m) => m.id === message.id)!;
    // an empty prompt is no value, so the row does not keep one: the ↻ of the
    // card is what absence means to the UI, exactly as the empty string was
    expect(msg.pictures?.[image]?.generation?.prompt).toBeUndefined();
    expect(rowOf(image)).not.toHaveProperty("prompt");
    // the rest of the card survives the edit — only the prompt went
    expect(rowOf(image).description).toBeDefined();
  });

  it("of a line with two pictures it edits the one that was named", () => {
    // The editor opens from one picture of a line, so its Save must not touch
    // the line's other picture or the line's own words.
    const chat = newChat();
    // Two DIFFERENT pictures: identical bytes would be one picture with one row,
    // which is what the de-dup is for, and would prove nothing here.
    const boat = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a boat" });
    const fox = chats.saveImage(chat.id, "data:image/png;base64,d29ybGQ=", { nameHint: "a fox" });
    expect(fox).not.toBe(boat);
    imageMeta.set(boat, { description: "a boat", prompt: "a boat at dawn", source: "manual" });
    imageMeta.set(fox, { description: "a fox", prompt: "a fox in the snow", source: "manual" });
    const line = chats.addUserMessage(chat, "look, two", [boat, fox]);
    const fresh = reply.editPicture(chats.get(chat.id)!, line, boat, { description: "a blue boat" })!;
    const saved = fresh.messages.find((m) => m.id === line.id)!;
    expect(saved.text).toBe("look, two");
    expect(saved.pictures?.[boat]?.description).toBe("a blue boat");
    expect(saved.pictures?.[fox]?.description).toBe("a fox");
    expect(rowOf(fox).prompt).toBe("a fox in the snow");
  });
});

// The three LLM helpers of the picture-editor dialog. The model client is the
// stub: what matters here is what the reply service hands it and what it
// answers with.
describe("the picture editor's LLM helpers", () => {
  it("plans the prompt of a card from the dialogue, leaving the card itself out", async () => {
    const { chat, message } = chatWithCard({ prompt: "a red fox" });
    const plan = await reply.planPicturePrompt(chat.id, message.id);
    expect(plan?.prompt).toBe("a red boat on a calm lake, the sky orange, low evening light");
    expect(plan?.description).toBe("a red boat on a calm lake at dusk");
    // the dialogue the model read is the user's line only — the card being
    // planned is not part of the conversation it is planned into
    expect(textGeneration.planInput?.scene).toContain("Hi");
    expect(textGeneration.planInput?.scene).not.toContain("a red fox in the snow");
    expect(textGeneration.planInput?.images).toEqual([]);
  });

  it("returns null when the chat is gone and when the model cannot plan", async () => {
    expect(await reply.planPicturePrompt("nope")).toBeNull();
    textGeneration.plan = null;
    const { chat, message } = chatWithCard();
    expect(await reply.planPicturePrompt(chat.id, message.id)).toBeNull();
  });

  it("tunes a prompt for the generator with the chat's model", async () => {
    const chat = newChat();
    expect(await reply.tunePicturePrompt(chat.id, "кот на подоконнике")).toBe("a tuned english prompt");
    expect(textGeneration.tuneInput).toBe("кот на подоконнике");
    expect(await reply.tunePicturePrompt("nope", "x")).toBeNull();
  });

  it("describes an existing picture and a data URL, and refuses a model without vision", async () => {
    const { chat } = chatWithCard();
    configuration.vision = true;
    expect(await reply.describePicture(chat.id, { imageId: "chats/x/files/a.png" })).toBe(
      "a small red boat on a calm lake",
    );
    expect(textGeneration.describeInput).toEqual({
      imageId: "chats/x/files/a.png",
      language: "English",
    });
    await reply.describePicture(chat.id, { dataUrl: "data:image/png;base64,aGVsbG8=" });
    expect(textGeneration.describeInput).toEqual({
      dataUrl: "data:image/png;base64,aGVsbG8=",
      language: "English",
    });

    configuration.vision = false;
    await expect(reply.describePicture(chat.id, { imageId: "a.png" })).rejects.toThrow(
      /No model that can see pictures/,
    );
    expect(await reply.describePicture("nope", { imageId: "a.png" })).toBeNull();
  });

  // The language of the descriptions is a global setting: the app writes the
  // caption in it (a caption is for the user, not for the generator) — the
  // generation prompt itself stays English.
  it("writes the descriptions in the language the config names, English by default", async () => {
    configuration.vision = true;
    const { chat } = chatWithCard();
    expect(reply.resolvePictureLanguage()).toBe("English");

    configuration.pictureLanguage = "ru";
    expect(reply.resolvePictureLanguage()).toBe("Russian");
    await reply.describePicture(chat.id, { imageId: "a.png" });
    expect(textGeneration.describeInput).toEqual({ imageId: "a.png", language: "Russian" });

    // the caption of an attached picture rides along
    const upload = chatWithUpload();
    configuration.vision = true;
    await reply.captionPicture(upload.chat.id, upload.message.id, upload.image);
    expect(textGeneration.describeInput?.language).toBe("Russian");

    // ...and so does the description of the 📷 plan
    await reply.planPicturePrompt(chat.id);
    expect(textGeneration.planInput?.language).toBe("Russian");

    // a code the app does not know is not a language: English
    configuration.pictureLanguage = "klingon";
    expect(reply.resolvePictureLanguage()).toBe("English");
  });
});

// Which model looks at pictures: the global vision pick, else the chat model
// when that can see, else the first model of the config that can.
describe("the vision model of the chat", () => {
  it("describes pictures with the chat model when it can see", async () => {
    configuration.vision = true;
    const { chat } = chatWithCard();
    await reply.describePicture(chat.id, { imageId: "a.png" });
    expect(textGeneration.describeModel).toBe("m1");
  });

  it("describes pictures with a model that can see when the chat model cannot", async () => {
    // no pick: the first vision-capable model of the config takes the job, so a
    // roleplay model without vision still gets its cards described
    configuration.extra = { seer: llmModel("seer", true) };
    const { chat } = chatWithCard();
    expect(await reply.describePicture(chat.id, { imageId: "a.png" })).toBe("a small red boat on a calm lake");
    expect(textGeneration.describeModel).toBe("seer");
  });

  it("describes pictures with the model the vision pick names", async () => {
    configuration.extra = { seer: llmModel("seer", true), other: llmModel("other", true) };
    configuration.visionModel = "other";
    const { chat } = chatWithCard();
    await reply.describePicture(chat.id, { imageId: "a.png" });
    expect(textGeneration.describeModel).toBe("other");
  });

  it("says plainly that a picked model cannot see, instead of silently using another", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    configuration.visionModel = "m1";
    const { chat } = chatWithCard();
    await expect(reply.describePicture(chat.id, { imageId: "a.png" })).rejects.toThrow(/"m1" cannot see pictures/);
    expect(textGeneration.describeModel).toBeNull();
  });
});

// The caption of an attached picture: written by the vision model, never over
// the user's own words, and never an error when it cannot happen.
describe("captionPicture", () => {
  it("writes the caption of an attached picture that has none", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    const { chat, message, image } = chatWithUpload();
    const out = await reply.captionPicture(chat.id, message.id, image);
    // The sentence goes to the PICTURE, not to the line: the user's own words
    // stay theirs, and a line with no words of its own stays wordless.
    expect(out?.messages[1].pictures?.[image]?.description).toBe("a small red boat on a calm lake");
    expect(out?.messages[1].text).toBe("");
    expect(textGeneration.describeModel).toBe("seer");
    expect(rowOf(image)).toMatchObject({ description: "a small red boat on a calm lake" });
    // and it survives a re-read: the table is what wins there
    expect(chats.get(chat.id)!.messages[1].pictures?.[image]?.description).toBe("a small red boat on a calm lake");
  });

  it("never overwrites a caption the user gave — the model is not even asked", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    const { chat, message, image } = chatWithCard();
    const out = await reply.captionPicture(chat.id, message.id, image);
    expect(out?.messages[1].pictures?.[image]?.description).toBe("a red fox in the snow");
    expect(textGeneration.describeModel).toBeNull();
  });

  it("leaves the picture alone when nothing in the config can see", async () => {
    const { chat, message, image } = chatWithUpload();
    const out = await reply.captionPicture(chat.id, message.id, image);
    expect(out?.messages[1].pictures?.[image]?.description).toBeUndefined();
    expect(textGeneration.describeModel).toBeNull();
  });

  it("leaves the picture alone when the vision model fails — an unlabelled picture is not an error", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    textGeneration.describeFails = true;
    const { chat, message, image } = chatWithUpload();
    const out = await reply.captionPicture(chat.id, message.id, image);
    expect(out?.messages[1].pictures?.[image]?.description).toBeUndefined();
  });

  it("of a line with two pictures it captions the one it was asked about", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    const chat = newChat();
    const first = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "first" });
    const second = chats.saveImage(chat.id, "data:image/png;base64,d29ybGQ=", { nameHint: "second" });
    const line = chats.addUserMessage(chat, "two photos", [first, second]);
    await reply.captionPicture(chat.id, line.id, second);
    const saved = chats.get(chat.id)!.messages[1];
    expect(saved.pictures?.[second]?.description).toBe("a small red boat on a calm lake");
    expect(saved.pictures?.[first]?.description).toBeUndefined();
  });

  it("keeps the caption the user wrote into the row while the model was looking", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    const { chat, message, image } = chatWithUpload();
    const g = gate();
    textGeneration.describeGate = g.promise;
    const run = reply.captionPicture(chat.id, message.id, image);
    await tick();
    imageMeta.set(image, { description: "my own words" });
    g.release();
    const out = await run;
    expect(out?.messages[1].pictures?.[image]?.description).toBe("my own words");
  });

  it("returns null when the chat is gone", async () => {
    configuration.extra = { seer: llmModel("seer", true) };
    const { chat, message, image } = chatWithUpload();
    chats.delete(chat.id);
    expect(await reply.captionPicture(chat.id, message.id, image)).toBeNull();
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
    expect(saved.pictures?.[id]?.generation).toBeUndefined();
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

  it("of a user's line files the new picture in the PERSONA's folder", () => {
    const { chat, message, image } = chatWithUpload();
    const result = reply.replaceImage(chat, message, image, "data:image/png;base64,d29ybGQ=")!;
    const id = result.messages.find((m) => m.id === message.id)!.images[0];
    // The line belongs to the persona, so the file that rides inside it belongs
    // to them too — an id pointing at chats/<chatId>/ would say the chat owns a
    // picture that is shown under somebody's name.
    expect(id).toMatch(/^users\/me\/photo-[0-9a-f]{6}\.png$/);
    expect(fs.existsSync(PathHelper.resolveImageId(id)!)).toBe(true);
  });

  it("of a character's line files it in HER folder", () => {
    const chat = newChat();
    const image = characters.reservedPictureId("alice", "a red boat");
    const withLine = chats.get(chat.id)!;
    withLine.messages.push({
      id: "a1", role: "assistant", characterId: "alice", kind: "text",
      text: "look at this", images: [image], timestamp: 2,
    });
    chats.save(withLine);
    const msg = chats.get(chat.id)!.messages.find((m) => m.id === "a1")!;
    const result = reply.replaceImage(chats.get(chat.id)!, msg, image, "data:image/png;base64,d29ybGQ=")!;
    const id = result.messages.find((m) => m.id === "a1")!.images[0];
    expect(id).toMatch(/^characters\/alice\/photo-[0-9a-f]{6}\.png$/);
    expect(id).not.toBe(image);
  });

  it("of a neutral card keeps the file in the CHAT's folder", () => {
    // The card belongs to nobody but the conversation, so its file stays where
    // the conversation's own pictures live.
    const { chat, message, image } = chatWithCard();
    const result = reply.replaceImage(chat, message, image, "data:image/png;base64,d29ybGQ=")!;
    const id = result.messages.find((m) => m.id === message.id)!.images[0];
    expect(id.startsWith(`chats/${chat.id}/`)).toBe(true);
  });

  it("returns null when the chat or the message disappeared in the meantime", () => {
    const { chat, message, image } = chatWithCard();
    chats.deleteMessage(chat, message.id, true);
    expect(reply.replaceImage(chat, message, image, "data:image/png;base64,aGVsbG8=")).toBeNull();
  });
});

describe("resolveChatModel", () => {
  it("returns the model the config picks", () => {
    configuration.extra = { second: llmModel("second", false) };
    configuration.chatModel = "second";
    expect(reply.resolveChatModel()?.name).toBe("second");
  });

  it("falls back to the first model when the config names none", () => {
    configuration.extra = { second: llmModel("second", false) };
    expect(reply.resolveChatModel()?.name).toBe("m1");
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
