import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { ChatsService } from "./ChatsService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { ImageMetaService } from "../images/ImageMetaService";
import { PathHelper } from "../shared/PathHelper";
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
// The one images table the chats write their picture data to — the test reads
// it directly to see what the chat store actually stored.
let imageMeta: ImageMetaService;
// Every service the test opened — all are closed before the temp root is
// wiped (on Windows an open database file blocks deleting its folder).
let open: { close(): void }[];

function makeChats(): ChatsService {
  const service = new ChatsService(() => root, new StubConfigurationService(), imageMeta);
  open.push(service);
  return service;
}

// Reads a chat through a fresh service instance — what a server restart
// would see (proves the last write reached the database, not just some
// in-memory state).
function peek(id: string): Chat | null {
  const fresh = new ChatsService(() => root, new StubConfigurationService(), imageMeta);
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
  imageMeta = new ImageMetaService(() => root);
  open.push(imageMeta);
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
    const filesDir = path.join(root, chat.id);
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
    expect(image).toMatch(new RegExp(`^${chat.id}/a-red-boat-[0-9a-f]{6}\\.png$`));
    expect(chats.get(chat.id)?.name).toBe("Важный чат");
  });
});

describe("visionModelId (the model that looks at pictures)", () => {
  it("survives save → read, and the clone carries it", () => {
    const chat = chats.create(["a"], "m1", "me");
    const configured = chats.get(chat.id)!;
    configured.visionModelId = "m2";
    chats.save(configured);
    expect(peek(chat.id)?.visionModelId).toBe("m2");
    expect(chats.clone(chat.id)?.visionModelId).toBe("m2");
  });

  it("keeps a pick the config knows, even a model that cannot see", () => {
    // both stub models are blind: the pick is the user's explicit choice and
    // survives — the describe call is what reports the model cannot look
    const chat = chats.create(["a"], "m1", "me");
    const configured = chats.get(chat.id)!;
    configured.visionModelId = "m2";
    chats.save(configured);
    expect(chats.get(chat.id)?.visionModelId).toBe("m2");
  });

  it("is dropped when its model left the config — the chat goes back to the default", () => {
    const chat = chats.create(["a"], "m1", "me");
    const configured = chats.get(chat.id)!;
    configured.visionModelId = "renamed-away";
    chats.save(configured);
    expect(chats.get(chat.id)?.visionModelId).toBeUndefined();
    expect(peek(chat.id)?.visionModelId).toBeUndefined();
  });

  it("is removed by an empty pick", () => {
    const chat = chats.create(["a"], "m1", "me");
    const configured = chats.get(chat.id)!;
    configured.visionModelId = "m2";
    chats.save(configured);
    const cleared = chats.get(chat.id)!;
    cleared.visionModelId = "";
    chats.save(cleared);
    expect(peek(chat.id)?.visionModelId).toBeUndefined();
    expect(peek(chat.id)).not.toHaveProperty("visionModelId");
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

  it("copies the pictures into the copy's own folder and repoints the card, its refs and its row", () => {
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
    expect(copiedCard.images[0]).toMatch(new RegExp(`^${copy.id}/a-fox-[0-9a-f]{6}\\.png$`));
    expect(copiedRef).toMatch(new RegExp(`^${copy.id}/a-red-boat-[0-9a-f]{6}\\.png$`));
    expect(copiedCard.text).toBe("a fox in the snow");

    // both files of the copy exist on disk, each with a row of the images table
    // of its own (the copy's row, not the source's under a new name)
    const cardFile = path.join(root, copiedCard.images[0]!.split("/").join(path.sep));
    const refFile = path.join(root, copiedRef!.split("/").join(path.sep));
    expect(fs.existsSync(cardFile)).toBe(true);
    expect(fs.existsSync(refFile)).toBe(true);
    const row = imageMeta.get(copiedCard.images[0]);
    expect(row?.description).toBe("a fox in the snow");
    expect(row?.prompt).toBe("a fox in the snow");
    expect(row?.refs).toEqual([copiedRef]);

    // the two chats are independent: deleting the source leaves the copy intact
    // (its rows included — a deleted chat takes the rows of its own files only)
    expect(chats.delete(chat.id)).toBe(true);
    const after = chats.get(copy.id)!;
    expect(after.messages[0].text).toBe("a fox in the snow");
    expect(fs.existsSync(cardFile)).toBe(true);
    expect(imageMeta.get(copiedCard.images[0])?.description).toBe("a fox in the snow");
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

  it("addImageMessage appends an image card and writes the picture's row", () => {
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
    // the row of the picture in the images table is where that came from
    const row = imageMeta.get(image);
    expect(row?.description).toBe("a red boat on a calm lake");
    expect(row?.prompt).toBe("a red boat at dusk");
    expect(row?.source).toBe("manual");
    // and the message itself persists no copy of it: a stale in-memory card
    // saved over the top cannot outlive the table's version of the truth
    const stale = chats.get(chat.id)!.messages[0];
    stale.text = "written into the row by hand";
    stale.generation = { prompt: "a prompt that was never saved" };
    chats.save(chats.get(chat.id)!);
    const again = chats.get(chat.id)!.messages[0];
    expect(again.text).toBe("a red boat on a calm lake");
    expect(again.generation?.prompt).toBe("a red boat at dusk");
  });

  it("a pending card is stored before its file exists; a card with nothing to say gets no row", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.reservedImageId(chat.id, "a picture for the conversation");
    const card = chats.addImageMessage(chat, id, { status: "pending" });
    expect(card.imageStatus).toEqual({ [id]: "pending" });
    expect(fs.existsSync(path.join(root, id))).toBe(false);
    expect(imageMeta.get(id)).toBeNull();
    expect(chats.get(chat.id)!.messages[0].imageStatus).toEqual({ [id]: "pending" });

    // once the app knows how the picture came to be, its row records it —
    // even while the file itself is still being drawn
    const planned = chats.reservedImageId(chat.id, "a red boat at dusk");
    chats.addImageMessage(chat, planned, { generation: { source: "auto", model: "m1" }, status: "pending" });
    expect(imageMeta.get(planned)).toMatchObject({ source: "auto", model: "m1" });
  });

  it("editMessage applies the text and saves (the caption of a card goes to its row)", () => {
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
    expect(imageMeta.get(image)?.description).toBe("new");
  });

  it("a card that carries a caption of its own is not read — the table is the only source", () => {
    // The shape of the old format (a legacy chat.json folder, where the message
    // row carried the picture's caption and prompt itself). The old format is
    // not supported, so that copy is not adopted into the table and not shown
    // either: a card reads its words from the images table and nowhere else. A
    // picture nobody described reads as undescribed, and the user writes its
    // caption again in the picture browser.
    const legacyId = "legacy-card";
    const image = `${legacyId}/fox.png`;
    fs.mkdirSync(path.join(root, legacyId), { recursive: true });
    fs.writeFileSync(path.join(root, legacyId, "fox.png"), "img");
    fs.writeFileSync(
      path.join(root, legacyId, "chat.json"),
      JSON.stringify({
        id: legacyId,
        characterIds: ["a"],
        userId: "me",
        modelId: "m1",
        messages: [
          {
            id: "old1",
            role: "user",
            userId: "me",
            kind: "image",
            text: "a fox in the snow",
            images: [image],
            generation: { prompt: "a fox at dawn", source: "manual" },
            depicts: ["char:alice"],
            timestamp: 1,
          },
        ],
      }),
      "utf-8",
    );

    const card = chats.get(legacyId)!.messages[0];
    expect(card.kind).toBe("image");
    expect(card.images).toEqual([image]);
    expect(card.text).toBe("");
    expect(card.generation).toBeUndefined();
    expect(card.depicts).toBeUndefined();
    expect(imageMeta.get(image)).toBeNull();

    // and the words appear the moment somebody writes them where they belong
    imageMeta.set(image, { description: "a fox in the snow", prompt: "a fox at dawn" });
    const described = chats.get(legacyId)!.messages[0];
    expect(described.text).toBe("a fox in the snow");
    expect(described.generation?.prompt).toBe("a fox at dawn");
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
    expect(imageMeta.get(image)).toMatchObject({ description: "a different scene", prompt: "a snowy pine ridge" });
  });

  it("editImageCard drops the generation fields from the row (the card is a plain file now)", () => {
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
    expect(saved.generation).toBeUndefined();
    const row = imageMeta.get(image);
    expect(row?.description).toBe("as saved");
    for (const key of ["prompt", "refs", "source", "model"]) expect(row).not.toHaveProperty(key);
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

  it("replaceMessageImageId repoints the card and moves its status and row", () => {
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
    // the row followed the name and nothing is left under the old one
    expect(imageMeta.get(readable)).toMatchObject({ description: "what it shows", prompt: "a red boat at dusk" });
    expect(imageMeta.get(placeholder)).toBeNull();
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
    expect(id).toMatch(new RegExp(`^${chat.id}/img-[0-9a-f]{6}\\.png$`));
    expect(fs.readFileSync(path.join(root, id))).toEqual(Buffer.from("aGVsbG8=", "base64"));
  });

  it("names the file after the hint and stores the metadata it was given", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, "data:image/jpeg;base64,aGVsbG8=", {
      nameHint: "A sunset over the sea",
      meta: { description: "the bay in the evening", prompt: "a sunset over the sea" },
    });
    expect(id).toMatch(new RegExp(`^${chat.id}/a-sunset-over-the-sea-[0-9a-f]{6}\\.jpg$`));
    expect(imageMeta.get(id)).toMatchObject({
      description: "the bay in the evening",
      prompt: "a sunset over the sea",
    });
    // nothing but the picture is written into the folder
    expect(fs.readdirSync(path.join(root, chat.id))).toEqual([path.basename(id)]);
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
    expect(id).toMatch(new RegExp(`^${chat.id}/a-red-boat-at-dusk-[0-9a-f]{6}\\.png$`));
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
    expect(imageMeta.get(replacement)).toMatchObject({ description: "a red fox in the snow" });
    expect(imageMeta.get(replacement)?.prompt).toBeUndefined();
    // the file that left the message keeps its own story (another picture may
    // still use it as a reference)
    expect(imageMeta.get(generated)?.prompt).toBe("a red fox in the snow");
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
    expect(id).toMatch(new RegExp(`^${chat.id}/alisa-portrait-[0-9a-f]{6}\\.png$`));
    expect(fs.readFileSync(path.join(root, id!))).toEqual(Buffer.from("img"));
  });

  it("an imported picture keeps the metadata of its source", () => {
    const chat = chats.create(["a"], "m1", "me");
    const photo = PathHelper.resolveImageId("outside/harbour.png")!;
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, "img");
    imageMeta.set("outside/harbour.png", { description: "a harbour at dusk", prompt: "a harbour" });
    const id = chats.importImage(chat.id, photo)!;
    const card = chats.addImageMessage(chat, id);
    // the card of an imported picture describes it right away
    expect(chats.get(chat.id)!.messages.find((m) => m.id === card.id)!.text).toBe("a harbour at dusk");
    // the copy has its own row; the source keeps its one
    expect(imageMeta.get("outside/harbour.png")?.description).toBe("a harbour at dusk");
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
    expect(chats.normalizeImages(chat.id, [`${chat.id}/missing.png`])).toEqual([]);
    // these files exist — they simply are not the app's pictures
    expect(chats.normalizeImages(chat.id, ["/etc/passwd", "../../etc/passwd", path.join(os.tmpdir(), "x.png")])).toEqual(
      [],
    );
  });
});

describe("the picture data on read", () => {
  function chatWithCard(): { chatId: string; id: string; cardId: string } {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a red boat" });
    const card = chats.addImageMessage(chat, id, {
      description: "as saved",
      generation: { prompt: "as drawn", source: "manual" },
    });
    return { chatId: chat.id, id, cardId: card.id };
  }

  it("the card of a chat IS the row of its picture: a row edit reads back here", () => {
    const { chatId, id } = chatWithCard();
    expect(chats.get(chatId)!.messages[0].text).toBe("as saved");

    // what the picture browser (or a hand-written UPDATE) puts into the table is
    // what the chat shows — there is no second copy that could disagree
    imageMeta.set(id, {
      description: "edited in the browser",
      prompt: "a red boat at dusk with gulls over the harbour",
      source: "manual",
    });
    const msg = chats.get(chatId)!.messages[0];
    expect(msg.text).toBe("edited in the browser");
    expect(msg.generation?.prompt).toBe("a red boat at dusk with gulls over the harbour");
  });

  it("a picture with no row reads as a card with an empty caption", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.reservedImageId(chat.id, "a red boat");
    chats.addImageMessage(chat, id);
    expect(imageMeta.get(id)).toBeNull();
    const card = chats.get(chat.id)!.messages[0];
    expect(card.text).toBe("");
    expect(card.generation).toBeUndefined();
    // the moment somebody describes the picture, every reader sees it
    imageMeta.set(id, { description: "described later" });
    expect(chats.get(chat.id)!.messages[0].text).toBe("described later");
  });

  it("a row that says nothing is deleted, not stored empty", () => {
    const { id } = chatWithCard();
    imageMeta.set(id, { description: undefined, prompt: undefined, refs: undefined, source: undefined });
    expect(imageMeta.get(id)).toBeNull();
    // clearing the prompt of a card is a real edit: the row then has no prompt
    imageMeta.set(id, { prompt: "" });
    expect(imageMeta.get(id)?.prompt).toBeUndefined();
  });

  it("a row whose refs name another chat's picture keeps them: the generator, not the store, decides", () => {
    const { chatId, id } = chatWithCard();
    // an id is a path relative to the data folder, so a picture of ANOTHER chat
    // is a perfectly good reference; only resolveRefPaths drops what does not
    // resolve to a file when the job actually runs
    const other = chats.create(["b"], "m1", "me");
    const elsewhere = chats.saveImage(other.id, "data:image/png;base64,aGVsbG8=", { nameHint: "another picture" });
    imageMeta.set(id, { refs: [elsewhere] });
    expect(chats.get(chatId)!.messages[0].generation?.refs).toEqual([elsewhere]);
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

describe("the chat ID (the date by default, the rename)", () => {
  it("names a new chat by its creation moment, not by a UUID", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(chat.id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(chats.isValidId(chat.id)).toBe(true);
    // two chats born in the same second are still two chats
    const second = chats.create(["a"], "m1", "me");
    expect(second.id).not.toBe(chat.id);
    expect(second.id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d+$/);
    expect(chats.list()).toHaveLength(2);
  });

  it("the clone of a chat gets a date id of its own", () => {
    const chat = chats.create(["a"], "m1", "me");
    const copy = chats.clone(chat.id)!;
    expect(copy.id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
    expect(copy.id).not.toBe(chat.id);
    expect(chats.list()).toHaveLength(2);
  });

  it("isValidId takes the characters of a folder name only", () => {
    expect(chats.isValidId("2026-02-08_14-03-22")).toBe(true);
    expect(chats.isValidId("my-chat.1_2")).toBe(true);
    expect(chats.isValidId("")).toBe(false);
    expect(chats.isValidId("a/b")).toBe(false);
    expect(chats.isValidId("a\\b")).toBe(false);
    expect(chats.isValidId("..")).toBe(false);
    expect(chats.isValidId(".hidden")).toBe(false);
    expect(chats.isValidId("a b")).toBe(false);
    expect(chats.isValidId(42)).toBe(false);
  });

  it("the rename moves the folder with its files, the rows and every picture id built on the old name", () => {
    const chat = chats.create(["a"], "m1", "me");
    chats.addUserMessage(chat, "hello");
    const id = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=", { nameHint: "a red boat" });
    const card = chats.addImageMessage(chat, id, {
      description: "a boat",
      generation: { prompt: "a red boat", source: "manual" },
    });
    // another chat names this picture in the reference set of its own prompt —
    // a picture id is a path, so it must follow the folder like the card does
    const other = chats.create(["a"], "m1", "me");
    const otherId = chats.saveImage(other.id, "data:image/png;base64,aGVsbG8=", { nameHint: "second" });
    const otherCard = chats.addImageMessage(other, otherId, {
      generation: { prompt: "like the first reference image", refs: [id], source: "manual" },
    });
    expect(fs.existsSync(path.join(root, chat.id, path.basename(id)))).toBe(true);

    const renamed = chats.rename(chat.id, "harbour-talk");

    expect(renamed.id).toBe("harbour-talk");
    // the folder moved with its file, the old name stands nowhere
    expect(fs.existsSync(path.join(root, chat.id))).toBe(false);
    expect(fs.existsSync(path.join(root, "harbour-talk", path.basename(id)))).toBe(true);
    expect(chats.exists(chat.id)).toBe(false);
    expect(chats.exists("harbour-talk")).toBe(true);
    // through a fresh service (a restart sees the move, not some memory)
    const seen = peek("harbour-talk")!;
    expect(seen.messages.map((m) => m.text)).toEqual(["hello", "a boat"]);
    const seenCard = seen.messages.find((m) => m.id === card.id)!;
    const newId = `harbour-talk/${path.basename(id)}`;
    expect(seenCard.images).toEqual([newId]);
    // the row of the picture moved with the file, so the card still reads its
    // caption and its prompt from the table
    expect(seenCard.text).toBe("a boat");
    expect(seenCard.generation?.prompt).toBe("a red boat");
    expect(imageMeta.get(id)).toBeNull();
    expect(imageMeta.get(newId)?.description).toBe("a boat");
    // and the reference set of the OTHER chat points at the new path — in the
    // row (the one source) and through the card that reads it
    expect(imageMeta.get(otherId)?.refs).toEqual([newId]);
    expect(peek(other.id)!.messages.find((m) => m.id === otherCard.id)!.generation?.refs).toEqual([newId]);
  });

  it("the rename takes the orphan rows of the folder along (a file the user deleted by hand)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const gone = `${chat.id}/deleted-by-hand-1a2b3c.png`;
    imageMeta.set(gone, { description: "a picture of nothing" });
    chats.rename(chat.id, "cleaned");
    expect(imageMeta.get(gone)).toBeNull();
    expect(imageMeta.get("cleaned/deleted-by-hand-1a2b3c.png")?.description).toBe("a picture of nothing");
  });

  it("the rename refuses a name that is taken, a name that is not a folder name and a chat that is not there", () => {
    const one = chats.create(["a"], "m1", "me");
    const two = chats.create(["a"], "m1", "me");
    expect(() => chats.rename(one.id, two.id)).toThrow(/already a chat/);
    expect(() => chats.rename(one.id, "a/b")).toThrow(/not a valid ID/);
    expect(() => chats.rename(one.id, ".hidden")).toThrow(/not a valid ID/);
    expect(() => chats.rename("no-such-chat", "fine")).toThrow(/no chat/);
    // a folder standing there without a row is taken too — a rename never lands
    // on files that belong to nobody
    fs.mkdirSync(path.join(root, "ghost-folder"), { recursive: true });
    expect(() => chats.rename(one.id, "ghost-folder")).toThrow(/already a chat/);
    // nothing was changed by the refusals
    expect(chats.exists(one.id)).toBe(true);
    expect(fs.existsSync(path.join(root, one.id))).toBe(false);
  });

  it("the rename refuses while a picture of the chat is still being drawn", () => {
    const chat = chats.create(["a"], "m1", "me");
    const pending = chats.reservedImageId(chat.id, "a boat");
    chats.addImageMessage(chat, pending, { status: "pending" });
    expect(() => chats.rename(chat.id, "too-soon")).toThrow(/still being generated/);
    expect(chats.exists(chat.id)).toBe(true);
  });
});

describe("saveImage de-duplication", () => {
  it("reuses the id of a picture already in the data folders (no second copy)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const bytes = Buffer.from("the very same picture bytes");
    const dataUrl = "data:image/png;base64," + bytes.toString("base64");
    // a picture the user already owns, with its facts in the row (what the disk
    // sync would have written)
    const owned = "characters/alice/a-photo-1a2b3c.png";
    const abs = path.join(root, "characters", "alice", "a-photo-1a2b3c.png");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    imageMeta.set(owned, {
      fileSize: bytes.length,
      fileModifiedAt: 1,
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      description: "the original",
    });

    const id = chats.saveImage(chat.id, dataUrl);
    // the existing picture is used, not copied into the chat (the chat folder
    // is not even created — nothing was written there)
    expect(id).toBe(owned);
    const chatDir = path.join(root, chat.id);
    const written = fs.existsSync(chatDir) ? fs.readdirSync(chatDir).filter((f) => f.endsWith(".png")) : [];
    expect(written).toHaveLength(0);
  });

  it("writes a new file when no picture matches the bytes", () => {
    const chat = chats.create(["a"], "m1", "me");
    const dataUrl = "data:image/png;base64," + Buffer.from("a brand new picture").toString("base64");
    const id = chats.saveImage(chat.id, dataUrl);
    expect(id).toMatch(new RegExp(`^${chat.id}/img-[0-9a-f]{6}\\.png$`));
    expect(fs.existsSync(PathHelper.resolveImageId(id)!)).toBe(true);
  });
});
