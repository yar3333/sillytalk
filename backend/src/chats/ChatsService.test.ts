import fs from "fs";
import os from "os";
import path from "path";
import { ChatsService } from "./ChatsService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Chat } from "./Chat";
import { Config } from "../configuration/Config";
import { Model } from "../configuration/Model";

// The config is stubbed, so the tests point the model fallback at an
// in-memory model list — no real config.json is involved.
class StubConfigurationService extends ConfigurationService {
  loadConfig(): Config {
    return configOf(modelNames);
  }
}

function model(name: string): Model {
  return {
    name,
    id: `${name}-id`,
    baseUrl: "http://provider.test/v1",
    contextSize: 8192,
    supportsImages: false,
    reasoning: false,
    reasoningLevels: [],
  };
}

function configOf(names: string[]): Config {
  return {
    listen: "127.0.0.1:3210",
    llmModels: Object.fromEntries(names.map((n) => [n, model(n)])),
    imageGenerators: [],
  };
}

let root: string;
let modelNames: string[];
let chats: ChatsService;
// Every service the test opened — all are closed before the temp root is
// wiped (on Windows an open chats.db blocks deleting its folder).
let open: ChatsService[];

function makeChats(): ChatsService {
  const service = new ChatsService(() => root, new StubConfigurationService());
  open.push(service);
  return service;
}

// Reads a chat through a fresh service instance — what a server restart
// would see (proves the last write reached the database, not just some
// in-memory state).
function peek(id: string): Chat | null {
  const fresh = new ChatsService(() => root, new StubConfigurationService());
  try {
    return fresh.get(id);
  } finally {
    fresh.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-chats-"));
  // The image ids are paths relative to the DATA folder, and only ids inside it
  // are accepted, so the suite points the data root at the same temp folder it
  // uses for the chats — otherwise every id of a test would escape the root and
  // be rejected.
  process.env.SILLYTALK_DATA_DIR = root;
  modelNames = ["m1", "m2"];
  open = [];
  chats = makeChats();
});

afterEach(() => {
  for (const service of open) service.close();
  delete process.env.SILLYTALK_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

// Writes a legacy chat.json directly (bypassing the service) to feed the
// service an old-format, corrupted or garbage chat on the first database
// open.
function writeChat(id: string, chat: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, "chat.json"), JSON.stringify(chat), "utf-8");
}

describe("create / get / list", () => {
  it("creates the chat and reads it back", () => {
    const chat = chats.create(["alice", "bob"], "m1", "me");
    expect(chat).toEqual({
      id: expect.any(String),
      createdAt: expect.any(Number),
      characterIds: ["alice", "bob"],
      userId: "me",
      modelId: "m1",
      messages: [],
    });
    expect(chats.get(chat.id)).toEqual(chat);
  });

  it("get returns null for a missing chat", () => {
    expect(chats.get("nope")).toBeNull();
  });

  it("the data survives a reopen (a fresh service on the same root)", () => {
    const chat = chats.create(["alice"], "m1", "me");
    chats.addUserMessage(chat, "hi");
    const seen = peek(chat.id);
    expect(seen?.messages.map((m) => m.text)).toEqual(["hi"]);
  });

  it("list returns summaries without the messages, newest first", () => {
    const a = chats.create(["a"], "m1", "me");
    const b = chats.create(["b"], "m1", "me");
    a.messages.push({ id: "1", role: "user", userId: "me", text: "hi", images: [], timestamp: 100 });
    b.messages.push({ id: "2", role: "user", userId: "me", text: "hey", images: [], timestamp: 200 });
    chats.save(a);
    chats.save(b);
    const list = chats.list();
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(list[0]).toEqual({
      id: b.id,
      createdAt: b.createdAt,
      characterIds: ["b"],
      userId: "me",
      modelId: "m1",
      messageCount: 1,
      lastMessageAt: 200,
    });
  });

  it("list ignores folders without chat.json and broken files", () => {
    fs.mkdirSync(path.join(root, "empty"));
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "chat.json"), "{oops", "utf-8");
    const ok = chats.create(["a"], "m1", "me");
    expect(chats.list().map((c) => c.id)).toEqual([ok.id]);
  });
});

describe("the migration from the legacy chat.json folders", () => {
  it("imports a legacy chat with its messages and renames the file", () => {
    writeChat("c1", {
      id: "c1",
      characterIds: ["alice"],
      userId: "me",
      modelId: "m1",
      messages: [
        { id: "m1", role: "user", userId: "me", text: "old", images: [], timestamp: 5 },
        { id: "m2", role: "assistant", characterId: "alice", text: "hi", images: [], timestamp: 6 },
      ],
    });
    const chat = chats.get("c1");
    expect(chat?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(chats.list().map((c) => c.id)).toEqual(["c1"]);
    expect(fs.existsSync(path.join(root, "c1", "chat.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "c1", "chat.json.migrated"))).toBe(true);
  });

  it("the retired fields do not survive the import (the creation date does)", () => {
    writeChat("c1", {
      id: "c1",
      title: "old title",
      createdAt: 1,
      updatedAt: 2,
      characterId: "alice",
      userIds: ["me"],
      characterIds: ["alice"],
      userId: "me",
      modelId: "m1",
      messages: [],
    });
    const stored = peek("c1") as Record<string, unknown>;
    expect(stored.title).toBeUndefined();
    // createdAt is a live field again (it titles a nameless chat), and the old
    // format stored it — so an imported chat keeps its real creation date.
    expect(stored.createdAt).toBe(1);
    expect(stored.updatedAt).toBeUndefined();
    expect(stored.characterId).toBeUndefined();
    expect(stored.userIds).toBeUndefined();
    expect(stored.characterIds).toEqual(["alice"]);
  });

  it("a corrupted legacy file is skipped and stays on disk", () => {
    writeChat("c1", {} as never);
    fs.writeFileSync(path.join(root, "c1", "chat.json"), "{oops", "utf-8");
    expect(chats.get("c1")).toBeNull();
    expect(fs.existsSync(path.join(root, "c1", "chat.json"))).toBe(true);
  });

  it("an already imported chat is not re-imported (the row wins)", () => {
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "m1", messages: [] });
    expect(peek("c1")).not.toBeNull(); // this first open imports it
    const chat = chats.get("c1")!;
    chat.characterIds = ["changed"];
    chats.save(chat);
    // a folder re-appearing with the old content must not resurrect it
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "m1", messages: [] });
    expect(peek("c1")?.characterIds).toEqual(["changed"]);
  });
});

describe("the format guards", () => {
  it("a legacy chat with garbage characterIds/userId is repaired on import and persisted", () => {
    writeChat("c1", {
      id: "c1",
      characterIds: ["alice", 42, "", "bob"],
      userId: 42,
      modelId: "m1",
      messages: [],
    });
    const chat = chats.get("c1");
    expect(chat?.characterIds).toEqual(["alice", "bob"]);
    expect(chat?.userId).toBe("");
    expect(peek("c1")?.characterIds).toEqual(["alice", "bob"]);
  });

  it("save normalizes a garbage chat", () => {
    const chat = { id: "c1", characterIds: null, userId: null, modelId: "m1", messages: [] } as unknown as Chat;
    chats.save(chat);
    expect(chats.get("c1")?.characterIds).toEqual([]);
    expect(chats.get("c1")?.userId).toBe("");
  });
});

describe("the model fallback", () => {
  it("attaches the first model when the chat model disappeared from the config", () => {
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "renamed-away", messages: [] });
    expect(chats.get("c1")?.modelId).toBe("m1");
  });

  it("keeps the model that is still in the config", () => {
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "m2", messages: [] });
    expect(chats.get("c1")?.modelId).toBe("m2");
  });

  it("leaves the chat alone when the config has no models at all", () => {
    modelNames = [];
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "gone", messages: [] });
    expect(chats.get("c1")?.modelId).toBe("gone");
  });
});

describe("delete", () => {
  it("deletes the chat with its folder and files", () => {
    const chat = chats.create(["a"], "m1", "me");
    const filesDir = path.join(root, chat.id, "files");
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, "img.png"), "x");
    expect(chats.delete(chat.id)).toBe(true);
    expect(chats.get(chat.id)).toBeNull();
    expect(fs.existsSync(path.join(root, chat.id))).toBe(false);
  });

  it("returns false for a missing chat", () => {
    expect(chats.delete("nope")).toBe(false);
  });
});

describe("the chat name and its creation date", () => {
  const PNG = "data:image/png;base64,aGVsbG8=";

  it("a new chat carries its creation date and no name", () => {
    const before = Date.now();
    const chat = chats.create(["a"], "m1", "me");
    expect(chat.name).toBeUndefined();
    expect(chat.createdAt).toBeGreaterThanOrEqual(before);
    expect(peek(chat.id)?.createdAt).toBe(chat.createdAt);
    // the list carries it too — that is what titles a nameless chat there
    expect(chats.list()[0].createdAt).toBe(chat.createdAt);
    expect(chats.list()[0].name).toBeUndefined();
  });

  it("a row without a creation date takes the date of its first message, and it is persisted", () => {
    writeChat("c1", {
      id: "c1",
      characterIds: ["a"],
      userId: "me",
      modelId: "m1",
      messages: [
        { id: "m1", role: "user", userId: "me", text: "old", images: [], timestamp: 5 },
        { id: "m2", role: "assistant", characterId: "a", text: "hi", images: [], timestamp: 9 },
      ],
    });
    expect(chats.get("c1")?.createdAt).toBe(5);
    expect(peek("c1")?.createdAt).toBe(5);
  });

  it("an empty row without a creation date gets the moment it is first read", () => {
    const before = Date.now();
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "m1", messages: [] });
    const created = chats.get("c1")!.createdAt;
    expect(created).toBeGreaterThanOrEqual(before);
    expect(peek("c1")?.createdAt).toBe(created);
  });

  it("the name is stored trimmed; an empty one is dropped, so the date titles the chat again", () => {
    const chat = chats.create(["a"], "m1", "me");
    const named = chats.get(chat.id)!;
    named.name = "  Road trip  ";
    chats.save(named);
    expect(chats.get(chat.id)?.name).toBe("Road trip");
    expect(chats.list()[0].name).toBe("Road trip");

    const cleared = chats.get(chat.id)!;
    cleared.name = "   ";
    chats.save(cleared);
    expect(chats.get(chat.id)?.name).toBeUndefined();
    expect(peek(chat.id) as unknown as Record<string, unknown>).not.toHaveProperty("name");
  });

  it("the name is a title: a picture file is still named by its own prompt slug", () => {
    const chat = chats.create(["a"], "m1", "me");
    const withName = chats.get(chat.id)!;
    withName.name = "Важный чат";
    chats.save(withName);
    const image = chats.saveImage(chat.id, PNG, { nameHint: "a red boat" });
    expect(image).toMatch(new RegExp(`^${chat.id}/files/a-red-boat-[0-9a-f]{6}\\.png$`));
    expect(chats.get(chat.id)?.name).toBe("Важный чат");
  });
});

describe("clone", () => {
  const PNG = "data:image/png;base64,aGVsbG8=";

  it("copies the messages, the participants and the settings under a new id", () => {
    const chat = chats.create(["alice", "bob"], "m1", "me");
    const configured = chats.get(chat.id)!;
    configured.name = "Road trip";
    configured.sampling = { temperature: 0.7 };
    configured.systemSuffix = "terse answers";
    chats.save(configured);
    const withLines = chats.get(chat.id)!;
    chats.addUserMessage(withLines, "hi");
    withLines.messages.push({
      id: "a1",
      role: "assistant",
      kind: "text",
      characterId: "alice",
      text: "hey",
      images: [],
      timestamp: 2,
    });
    chats.save(withLines);

    const copy = chats.clone(chat.id)!;
    expect(copy.id).not.toBe(chat.id);
    expect(copy.name).toBe("Road trip (copy)");
    expect(copy.createdAt).toBeGreaterThanOrEqual(chat.createdAt);
    expect(copy.characterIds).toEqual(["alice", "bob"]);
    expect(copy.userId).toBe("me");
    expect(copy.modelId).toBe("m1");
    expect(copy.sampling).toEqual({ temperature: 0.7 });
    expect(copy.systemSuffix).toBe("terse answers");
    expect(copy.messages.map((m) => m.text)).toEqual(["hi", "hey"]);
    expect(copy.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(copy.messages.map((m) => m.characterId)).toEqual([undefined, "alice"]);
    // fresh message ids — the two chats are edited independently
    expect(copy.messages.map((m) => m.id)).not.toEqual(chats.get(chat.id)!.messages.map((m) => m.id));

    // the source keeps everything it had
    const source = chats.get(chat.id)!;
    expect(source.name).toBe("Road trip");
    expect(source.messages).toHaveLength(2);
    // and the copy survives a reopen
    expect(peek(copy.id)?.messages.map((m) => m.text)).toEqual(["hi", "hey"]);
  });

  it("a nameless chat is cloned nameless, titled by its own creation date", () => {
    const chat = chats.create(["a"], "m1", "me");
    const copy = chats.clone(chat.id)!;
    expect(copy.name).toBeUndefined();
    expect(peek(copy.id) as unknown as Record<string, unknown>).not.toHaveProperty("name");
    expect(copy.createdAt).toBeGreaterThanOrEqual(chat.createdAt);
  });

  it("copies the pictures into the copy's own folder and repoints the card, its refs and its sidecar", () => {
    const chat = chats.create(["a"], "m1", "me");
    const ref = chats.saveImage(chat.id, PNG, { nameHint: "a red boat" });
    const card = chats.saveImage(chat.id, PNG, { nameHint: "a fox" });
    chats.addImageMessage(chats.get(chat.id)!, card, {
      description: "a fox in the snow",
      generation: { prompt: "a fox in the snow", refs: [ref], source: "manual" },
    });

    const copy = chats.clone(chat.id)!;
    const copiedCard = copy.messages[0];
    const copiedRef = copiedCard.generation!.refs![0];
    expect(copiedCard.images[0]).not.toBe(card);
    expect(copiedCard.images[0]).toMatch(new RegExp(`^${copy.id}/files/a-fox-[0-9a-f]{6}\\.png$`));
    expect(copiedRef).toMatch(new RegExp(`^${copy.id}/files/a-red-boat-[0-9a-f]{6}\\.png$`));
    expect(copiedCard.text).toBe("a fox in the snow");

    // both files of the copy exist on disk, with their sidecars
    const cardFile = path.join(root, copiedCard.images[0]!.split("/").join(path.sep));
    const refFile = path.join(root, copiedRef!.split("/").join(path.sep));
    expect(fs.existsSync(cardFile)).toBe(true);
    expect(fs.existsSync(refFile)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(`${cardFile}.json`, "utf-8")) as {
      description?: string;
      prompt?: string;
      refs?: string[];
    };
    expect(sidecar.description).toBe("a fox in the snow");
    expect(sidecar.prompt).toBe("a fox in the snow");
    expect(sidecar.refs).toEqual([copiedRef]);

    // the two chats are independent: deleting the source leaves the copy intact
    expect(chats.delete(chat.id)).toBe(true);
    const after = chats.get(copy.id)!;
    expect(after.messages[0].text).toBe("a fox in the snow");
    expect(fs.existsSync(cardFile)).toBe(true);
  });

  it("a picture that was still being drawn becomes a broken card with a reason", () => {
    const chat = chats.create(["a"], "m1", "me");
    const pending = chats.reservedImageId(chat.id, "a sunset");
    chats.addImageMessage(chats.get(chat.id)!, pending, {
      generation: { source: "auto" },
      status: "pending",
    });

    const copy = chats.clone(chat.id)!;
    const card = copy.messages[0];
    // never "pending": the job belongs to the source chat, so a spinner here
    // would poll forever
    expect(Object.values(card.imageStatus ?? {})).toEqual(["failed"]);
    expect(Object.values(card.imageErrors ?? {})[0]).toContain("cloned");
  });

  it("a failed or cancelled card keeps its state and its reason", () => {
    const chat = chats.create(["a"], "m1", "me");
    const image = chats.reservedImageId(chat.id, "a sunset");
    chats.addImageMessage(chats.get(chat.id)!, image, {
      generation: { prompt: "a sunset", source: "manual" },
      status: "failed",
      error: "GPU exploded",
    });
    const copy = chats.clone(chat.id)!;
    const card = copy.messages[0];
    expect(card.imageStatus?.[card.images[0]]).toBe("failed");
    expect(card.imageErrors?.[card.images[0]]).toBe("GPU exploded");
  });

  it("returns null for a missing chat", () => {
    expect(chats.clone("nope")).toBeNull();
  });
});

describe("the message primitives", () => {
  it("addUserMessage appends a text message under the active persona and saves it", () => {
    const chat = chats.create(["a"], "m1", "me");
    const msg = chats.addUserMessage(chat, "hi");
    expect(msg.role).toBe("user");
    expect(msg.kind).toBe("text");
    expect(msg.userId).toBe("me");
    expect(msg.text).toBe("hi");
    expect(msg.images).toEqual([]);
    expect(msg.id).toEqual(expect.any(String));
    expect(msg.timestamp).toEqual(expect.any(Number));
    expect(chats.get(chat.id)!.messages).toEqual([msg]);
  });

  it("addUserMessage after a save appends after the stored messages", () => {
    const chat = chats.create(["a"], "m1", "me");
    chat.messages.push({ id: "m1", role: "user", userId: "me", kind: "text", text: "first", images: [], timestamp: 1 });
    chats.save(chat);
    chats.addUserMessage(chat, "second");
    expect(chats.get(chat.id)!.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("addImageMessage appends an image card and writes its sidecar", () => {
    const chat = chats.create(["a"], "m1", "me");
    const image = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a red boat" });
    const card = chats.addImageMessage(chat, image, {
      description: "a red boat on a calm lake",
      generation: { prompt: "a red boat at dusk", refs: [], source: "manual" },
    });
    expect(card.kind).toBe("image");
    expect(card.userId).toBe("me");
    expect(card.text).toBe("a red boat on a calm lake");
    expect(card.images).toEqual([image]);
    expect(chats.get(chat.id)!.messages).toEqual([card]);
    // the sidecar next to the file carries the same story
    const sidecar = JSON.parse(fs.readFileSync(`${path.join(root, image)}.json`, "utf-8")) as Record<string, unknown>;
    expect(sidecar.description).toBe("a red boat on a calm lake");
    expect(sidecar.prompt).toBe("a red boat at dusk");
    expect(sidecar.source).toBe("manual");
  });

  it("a pending card is stored before its file exists; a card with nothing to say gets no sidecar", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.reservedImageId(chat.id, "a picture for the conversation");
    const card = chats.addImageMessage(chat, id, { status: "pending" });
    expect(card.imageStatus).toEqual({ [id]: "pending" });
    expect(fs.existsSync(path.join(root, id))).toBe(false);
    expect(fs.existsSync(`${path.join(root, id)}.json`)).toBe(false);
    expect(chats.get(chat.id)!.messages[0].imageStatus).toEqual({ [id]: "pending" });

    // once the app knows how the picture came to be, the sidecar records it —
    // even while the file itself is still being drawn
    const planned = chats.reservedImageId(chat.id, "a red boat at dusk");
    chats.addImageMessage(chat, planned, { generation: { source: "auto", model: "m1" }, status: "pending" });
    const sidecar = JSON.parse(fs.readFileSync(`${path.join(root, planned)}.json`, "utf-8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ source: "auto", model: "m1" });
  });

  it("editMessage applies the text and saves (a card refreshes its sidecar)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const image = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    chat.messages.push({
      id: "m1",
      role: "user",
      userId: "me",
      kind: "image",
      text: "old",
      images: [image],
      timestamp: 1,
    });
    chats.save(chat);
    chats.editMessage(chat, chat.messages[0], "new");
    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.text).toBe("new");
    const sidecar = JSON.parse(fs.readFileSync(`${path.join(root, image)}.json`, "utf-8")) as Record<string, unknown>;
    expect(sidecar.description).toBe("new");
  });

  it("editImageCard edits the description and the prompt together", () => {
    const chat = chats.create(["a"], "m1", "me");
    const image = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    const card = chats.addImageMessage(chat, image, {
      description: "as saved",
      generation: { prompt: "as drawn", source: "manual" },
    });
    const fresh = chats.get(chat.id)!;
    chats.editImageCard(fresh, fresh.messages.find((m) => m.id === card.id)!, {
      description: "a different scene",
      prompt: "a snowy pine ridge",
    });
    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.text).toBe("a different scene");
    expect(saved.generation).toEqual({ prompt: "a snowy pine ridge", source: "manual" });
    const sidecar = JSON.parse(fs.readFileSync(`${path.join(root, image)}.json`, "utf-8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ description: "a different scene", prompt: "a snowy pine ridge" });
  });

  it("editImageCard drops the generation block from the row and the sidecar (the card is a plain file now)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const image = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    chats.addImageMessage(chat, image, {
      description: "as saved",
      generation: { prompt: "as drawn", refs: [image], source: "manual", model: "m1" },
    });
    const fresh = chats.get(chat.id)!;
    const card = fresh.messages[0];
    chats.editImageCard(fresh, card, { generation: null });

    const saved = chats.get(chat.id)!.messages[0];
    // the sidecar wins over the row on read, so it must be cleaned too —
    // otherwise the prompt would come back
    expect(saved.generation).toBeUndefined();
    const sidecar = JSON.parse(fs.readFileSync(`${path.join(root, image)}.json`, "utf-8")) as Record<string, unknown>;
    expect(sidecar.description).toBe("as saved");
    for (const key of ["prompt", "refs", "source", "model"]) expect(sidecar).not.toHaveProperty(key);
  });

  it("editImageCard replaces the generation block with the given one", () => {
    const chat = chats.create(["a"], "m1", "me");
    const image = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    chats.addImageMessage(chat, image, { description: "x", generation: { source: "upload" } });
    const fresh = chats.get(chat.id)!;
    chats.editImageCard(fresh, fresh.messages[0], {
      generation: { prompt: "a snowy pine ridge", source: "manual" },
    });
    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.generation).toEqual({ prompt: "a snowy pine ridge", source: "manual" });
  });

  it("setMessageText rewrites one row's caption (a background job has no message object)", () => {
    const chat = chats.create(["a"], "m1", "me");
    chats.addUserMessage(chat, "one");
    const card = chats.addImageMessage(chat, chats.reservedImageId(chat.id, "a boat"), { status: "pending" });
    // the state of a job that started before the other message landed
    expect(chats.setMessageText(chat.id, card.id, "a red boat at dusk")).toBe(true);
    const fresh = chats.get(chat.id)!;
    expect(fresh.messages.map((m) => m.text)).toEqual(["one", "a red boat at dusk"]);
    expect(chats.setMessageText(chat.id, "missing", "x")).toBe(false);
  });

  it("replaceMessageImageId repoints the card and moves its status and sidecar", () => {
    const chat = chats.create(["a"], "m1", "me");
    const placeholder = chats.reservedImageId(chat.id, "a picture for the conversation");
    const card = chats.addImageMessage(chat, placeholder, {
      description: "what it shows",
      generation: { prompt: "a red boat at dusk", source: "auto" },
      status: "pending",
    });
    // the plan picked a readable name for the picture while its file is still
    // being drawn — the id is what moves, the file arrives under the new name
    const readable = chats.reservedImageId(chat.id, "a red boat at dusk");
    expect(chats.replaceMessageImageId(chat.id, card.id, placeholder, readable)).toBe(true);

    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.images).toEqual([readable]);
    expect(saved.imageStatus).toEqual({ [readable]: "pending" });
    // the metadata followed the name and nothing is left under the old one
    const sidecar = JSON.parse(
      fs.readFileSync(`${path.join(root, readable)}.json`, "utf-8"),
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ description: "what it shows", prompt: "a red boat at dusk" });
    expect(fs.existsSync(`${path.join(root, placeholder)}.json`)).toBe(false);
    // a second rename of the same image finds nothing to move
    expect(chats.replaceMessageImageId(chat.id, card.id, placeholder, readable)).toBe(false);
  });

  it("replaceMessageImageId is a no-op for another chat, message or image", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.reservedImageId(chat.id, "a boat");
    chats.addImageMessage(chat, id);
    expect(chats.replaceMessageImageId("nope", "m1", id, "x.png")).toBe(false);
    expect(chats.replaceMessageImageId(chat.id, "missing", id, "x.png")).toBe(false);
    expect(chats.replaceMessageImageId(chat.id, "missing", "not-in-the-message", "x.png")).toBe(false);
  });

  it("deleteMessage trims the tail by default and the single message with single=true", () => {
    const chat = chats.create(["a"], "m1", "me");
    chat.messages.push(
      { id: "m1", role: "user", userId: "me", text: "1", images: [], timestamp: 1 },
      { id: "m2", role: "user", userId: "me", text: "2", images: [], timestamp: 2 },
      { id: "m3", role: "user", userId: "me", text: "3", images: [], timestamp: 3 },
    );
    chats.save(chat);
    expect(chats.deleteMessage(chat, "m2")).toBe(true);
    expect(chats.get(chat.id)!.messages.map((m) => m.id)).toEqual(["m1"]);
    // re-populate and delete a single message in the middle
    chat.messages.push({ id: "m3", role: "user", userId: "me", text: "3", images: [], timestamp: 3 });
    chats.save(chat);
    expect(chats.deleteMessage(chat, "m1", true)).toBe(true);
    expect(chats.get(chat.id)!.messages.map((m) => m.id)).toEqual(["m3"]);
  });

  it("deleteMessage returns false for a missing message and saves nothing", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(chats.deleteMessage(chat, "nope")).toBe(false);
  });
});

describe("saveImage / reservedImageId", () => {
  it("saves a data URL into the chat files/ and returns its id (a path relative to the data folder)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    expect(id).toMatch(new RegExp(`^${chat.id}/files/img-[0-9a-f]{6}\\.png$`));
    expect(fs.readFileSync(path.join(root, id))).toEqual(Buffer.from("aGVsbG8=", "base64"));
  });

  it("names the file after the hint and writes the sidecar it was given", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, "data:image/jpeg;base64,aGVsbG8=", {
      nameHint: "A sunset over the sea",
      meta: { description: "the bay in the evening", prompt: "a sunset over the sea" },
    });
    expect(id).toMatch(new RegExp(`^${chat.id}/files/a-sunset-over-the-sea-[0-9a-f]{6}\\.jpg$`));
    const sidecar = JSON.parse(fs.readFileSync(`${path.join(root, id)}.json`, "utf-8")) as Record<string, unknown>;
    expect(sidecar.description).toBe("the bay in the evening");
    expect(sidecar.prompt).toBe("a sunset over the sea");
  });

  it("two saves of the same picture never share a file", () => {
    const chat = chats.create(["a"], "m1", "me");
    const first = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a red boat" });
    const second = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a red boat" });
    expect(second).not.toBe(first);
  });

  it("throws on a string that is not a data URL", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(() => chats.saveImage(chat.id, "not-a-data-url")).toThrow(/data URL/);
  });

  it("reservedImageId reserves a readable id without creating the file", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.reservedImageId(chat.id, "A red boat at dusk, finally");
    expect(id).toMatch(new RegExp(`^${chat.id}/files/a-red-boat-at-dusk-[0-9a-f]{6}\\.png$`));
    expect(fs.existsSync(path.join(root, id))).toBe(false);
    // the reservation is unique — two placeholders never collide
    expect(chats.reservedImageId(chat.id, "A red boat at dusk, finally")).not.toBe(id);
  });

  it("slugify keeps 2–5 english words and transliterates cyrillic", () => {
    expect(ChatsService.slugify("A red fox sitting on a snowy fence", "image")).toBe("a-red-fox-sitting-on");
    expect(ChatsService.slugify("рыжая лиса в снегу", "image")).toBe("ryzhaya-lisa-v-snegu");
    expect(ChatsService.slugify("!!! ??? —", "image")).toBe("image");
    expect(ChatsService.slugify("", "image")).toBe("image");
    expect(ChatsService.slugify("supercalifragilisticexpialidociously", "image").length).toBeLessThanOrEqual(48);
  });
});

describe("replaceMessageImage", () => {
  it("swaps the picture and drops the generation data together with the old file", () => {
    const chat = chats.create(["a"], "m1", "me");
    const generated = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", {
      nameHint: "a red fox",
      meta: { prompt: "a red fox in the snow" },
    });
    const card = chats.addImageMessage(chat, generated, {
      description: "a red fox in the snow",
      generation: { prompt: "a red fox in the snow", source: "manual" },
    });
    const replacement = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "my own photo" });
    const fresh = chats.get(chat.id)!;
    chats.replaceMessageImage(fresh, fresh.messages.find((m) => m.id === card.id)!, generated, replacement);

    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.images).toEqual([replacement]);
    // what hangs on the message now is the user's file: no prompt, no source
    expect(saved.generation).toBeUndefined();
    expect(saved.text).toBe("a red fox in the snow");
    const newSidecar = JSON.parse(fs.readFileSync(`${path.join(root, replacement)}.json`, "utf-8")) as Record<string, unknown>;
    expect(newSidecar).toMatchObject({ description: "a red fox in the snow" });
    expect(newSidecar.prompt).toBeUndefined();
    // the file that left the message keeps its own story (another picture may
    // still use it as a reference)
    const oldSidecar = JSON.parse(fs.readFileSync(`${path.join(root, generated)}.json`, "utf-8")) as Record<string, unknown>;
    expect(oldSidecar.prompt).toBe("a red fox in the snow");
  });

  it("clears the status and the error of the picture it replaced", () => {
    const chat = chats.create(["a"], "m1", "me");
    const failed = chats.reservedImageId(chat.id, "a first picture");
    const card = chats.addImageMessage(chat, failed, { status: "failed", error: "GPU exploded" });
    const replacement = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    const fresh = chats.get(chat.id)!;
    chats.replaceMessageImage(fresh, fresh.messages.find((m) => m.id === card.id)!, failed, replacement);
    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.imageStatus).toBeUndefined();
    expect(saved.imageErrors).toBeUndefined();
  });
});

describe("importImage / importCharacterPhoto", () => {
  it("copies the file into the chat files/ under a readable name and returns its id", () => {
    const chat = chats.create(["a"], "m1", "me");
    const photo = path.join(root, "outside", "Alisa portrait.png");
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, "img");
    const id = chats.importCharacterPhoto(chat.id, photo);
    expect(id).toMatch(new RegExp(`^${chat.id}/files/alisa-portrait-[0-9a-f]{6}\\.png$`));
    expect(fs.readFileSync(path.join(root, id!))).toEqual(Buffer.from("img"));
  });

  it("an imported picture keeps its sidecar", () => {
    const chat = chats.create(["a"], "m1", "me");
    const photo = path.join(root, "outside", "harbour.png");
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, "img");
    fs.writeFileSync(`${photo}.json`, JSON.stringify({ description: "a harbour at dusk", prompt: "a harbour" }));
    const id = chats.importImage(chat.id, photo)!;
    const card = chats.addImageMessage(chat, id);
    // the card of an imported picture describes it right away
    expect(chats.get(chat.id)!.messages.find((m) => m.id === card.id)!.text).toBe("a harbour at dusk");
  });

  it("returns null when the photo does not exist", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(chats.importCharacterPhoto(chat.id, path.join(root, "nope.png"))).toBeNull();
  });
});

describe("normalizeImages", () => {
  it("saves data URLs and keeps the ids of pictures that are really there", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    const result = chats.normalizeImages(chat.id, ["data:image/png;base64,aGVsbG8=", id, 42, null, ""]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/\/img-[0-9a-f]{6}\.png$/);
    expect(result[1]).toBe(id);
  });

  it("drops a picture whose file is missing and anything outside the data folders", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(chats.normalizeImages(chat.id, [`${chat.id}/files/missing.png`])).toEqual([]);
    // these files exist — they simply are not the app's pictures
    expect(chats.normalizeImages(chat.id, ["/etc/passwd", "../../etc/passwd", path.join(os.tmpdir(), "x.png")])).toEqual(
      [],
    );
  });
});

describe("the sidecar metadata on read", () => {
  function chatWithCard(): { chatId: string; id: string; cardId: string } {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a red boat" });
    const card = chats.addImageMessage(chat, id, {
      description: "as saved",
      generation: { prompt: "as drawn", source: "manual" },
    });
    return { chatId: chat.id, id, cardId: card.id };
  }

  it("a hand-edited sidecar wins over the copy in the database", () => {
    const { chatId, id } = chatWithCard();
    expect(chats.get(chatId)!.messages[0].text).toBe("as saved");

    fs.writeFileSync(
      path.join(root, `${id}.json`),
      JSON.stringify({
        description: "edited by hand",
        prompt: "a red boat at dusk with gulls over the harbour",
        source: "manual",
      }),
      "utf-8",
    );
    const msg = chats.get(chatId)!.messages[0];
    expect(msg.text).toBe("edited by hand");
    expect(msg.generation?.prompt).toBe("a red boat at dusk with gulls over the harbour");
  });

  it("a sidecar the user saved under the short name is found too", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.reservedImageId(chat.id, "a red boat");
    chats.addImageMessage(chat, id); // nothing to say yet — no sidecar was written
    expect(fs.existsSync(`${path.join(root, id)}.json`)).toBe(false);
    // "a-red-boat-xxxx.png.json" is the canonical name; the user wrote the
    // shorter "a-red-boat-xxxx.json" instead — the app still reads it
    const short = path.join(root, id.slice(0, -".png".length) + ".json");
    fs.mkdirSync(path.dirname(short), { recursive: true });
    fs.writeFileSync(short, JSON.stringify({ description: "the shorter name" }), "utf-8");
    expect(chats.get(chat.id)!.messages[0].text).toBe("the shorter name");

    // and the next write goes to the canonical name, removing the alias
    chats.writeSidecar(id, "now the canonical one", undefined);
    expect(fs.existsSync(short)).toBe(false);
    expect(chats.get(chat.id)!.messages[0].text).toBe("now the canonical one");
  });

  it("an unparsable sidecar is ignored, not fatal", () => {
    const { chatId, id } = chatWithCard();
    fs.writeFileSync(path.join(root, `${id}.json`), "{ this is not json", "utf-8");
    expect(chats.get(chatId)!.messages[0].text).toBe("as saved");
  });

  it("a write keeps the fields the app knows nothing about (the user's own notes)", () => {
    const { id } = chatWithCard();
    const file = path.join(root, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ my_note: "keep me", seed: 17, description: "as saved" }), "utf-8");
    chats.writeSidecar(id, "a new caption", { prompt: "a new prompt" });
    const sidecar = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(sidecar.my_note).toBe("keep me");
    expect(sidecar.seed).toBe(17);
    expect(sidecar.description).toBe("a new caption");
    expect(sidecar.prompt).toBe("a new prompt");
    expect(sidecar.updatedAt).toEqual(expect.any(String));
  });

  it("a reference list pointing outside the data folders is dropped", () => {
    const { chatId, id } = chatWithCard();
    // a picture of ANOTHER chat is still inside the data folder, so it stays;
    // a path pointing out of it never reaches the generator
    const other = chats.create(["b"], "m1", "me");
    const elsewhere = chats.saveImage(other.id, "data:image/png;base64,aGVsbG8=", { nameHint: "another picture" });
    fs.writeFileSync(
      path.join(root, `${id}.json`),
      JSON.stringify({ description: "as saved", refs: [elsewhere, "/etc/passwd", "../secret.png"] }),
      "utf-8",
    );
    const card = chats.get(chatId)!.messages[0];
    expect(card.generation?.refs).toEqual([elsewhere]);
  });
});

describe("setMessageImageStatus", () => {
  function chatWithPendingMessage(): { chat: Chat; messageId: string } {
    const chat = chats.create(["a"], "m1", "me");
    chat.messages.push({
      id: "m1",
      role: "assistant",
      characterId: "a",
      text: "",
      images: ["gen-1.png"],
      imageStatus: { "gen-1.png": "pending" },
      timestamp: 1,
    });
    chats.save(chat);
    return { chat, messageId: "m1" };
  }

  it("sets the status and the error of a message image", () => {
    const { chat, messageId } = chatWithPendingMessage();
    chats.setMessageImageStatus(chat.id, messageId, "gen-1.png", "failed", "boom");
    const msg = chats.get(chat.id)!.messages[0];
    expect(msg.imageStatus).toEqual({ "gen-1.png": "failed" });
    expect(msg.imageErrors).toEqual({ "gen-1.png": "boom" });
  });

  it("clears the status and the error when the status is undefined", () => {
    const { chat, messageId } = chatWithPendingMessage();
    chats.setMessageImageStatus(chat.id, messageId, "gen-1.png", "failed", "boom");
    chats.setMessageImageStatus(chat.id, messageId, "gen-1.png", undefined);
    const msg = chats.get(chat.id)!.messages[0];
    expect(msg.imageStatus).toBeUndefined();
    expect(msg.imageErrors).toBeUndefined();
  });

  it("does not clobber a message appended while the status was written", () => {
    const { chat, messageId } = chatWithPendingMessage();
    // the state a background job holds: the chat as it was before a
    // concurrent send landed — its status write must touch only its row.
    chats.addUserMessage(chat, "a concurrent message");
    chats.setMessageImageStatus(chat.id, messageId, "gen-1.png", undefined);
    const fresh = chats.get(chat.id)!;
    expect(fresh.messages).toHaveLength(2);
    expect(fresh.messages[0].imageStatus).toBeUndefined();
  });

  it("is a silent no-op for a missing chat or message", () => {
    expect(() => chats.setMessageImageStatus("nope", "m1", "gen-1.png", "pending")).not.toThrow();
    const chat = chats.create(["a"], "m1", "me");
    expect(() => chats.setMessageImageStatus(chat.id, "missing", "gen-1.png", "pending")).not.toThrow();
  });
});
