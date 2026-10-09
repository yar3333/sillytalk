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
  modelNames = ["m1", "m2"];
  open = [];
  chats = makeChats();
});

afterEach(() => {
  for (const service of open) service.close();
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
    chats.addUserMessage(chat, "hi", []);
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

  it("the retired fields do not survive the import", () => {
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
    expect(stored.createdAt).toBeUndefined();
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

describe("the message primitives", () => {
  it("addUserMessage appends the message under the active persona, normalizes the images and saves", () => {
    const chat = chats.create(["a"], "m1", "me");
    const dataName = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    const msg = chats.addUserMessage(chat, "hi", [dataName, "missing.png"]);
    expect(msg.role).toBe("user");
    expect(msg.userId).toBe("me");
    expect(msg.text).toBe("hi");
    expect(msg.images).toEqual([dataName]);
    expect(msg.id).toEqual(expect.any(String));
    expect(msg.timestamp).toEqual(expect.any(Number));
    expect(chats.get(chat.id)!.messages).toEqual([msg]);
  });

  it("addUserMessage after a save appends after the stored messages", () => {
    const chat = chats.create(["a"], "m1", "me");
    chat.messages.push({ id: "m1", role: "user", userId: "me", text: "first", images: [], timestamp: 1 });
    chats.save(chat);
    chats.addUserMessage(chat, "second", []);
    expect(chats.get(chat.id)!.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("editMessage applies the text and the images and saves", () => {
    const chat = chats.create(["a"], "m1", "me");
    const dataName = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    chat.messages.push({ id: "m1", role: "user", userId: "me", text: "old", images: [], timestamp: 1 });
    chats.save(chat);
    chats.editMessage(chat, chat.messages[0], "new", [dataName, "missing.png"]);
    const saved = chats.get(chat.id)!.messages[0];
    expect(saved.text).toBe("new");
    expect(saved.images).toEqual([dataName]);
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

describe("saveImage", () => {
  it("saves a data URL into the chat files/ and returns the file name", () => {
    const chat = chats.create(["a"], "m1", "me");
    const name = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    expect(name).toMatch(/^img-[0-9a-f]{8}\.png$/);
    const file = path.join(root, chat.id, "files", name);
    expect(fs.readFileSync(file)).toEqual(Buffer.from("aGVsbG8=", "base64"));
  });

  it("picks the extension from the MIME type and sanitizes the original name", () => {
    const chat = chats.create(["a"], "m1", "me");
    const name = chats.saveImage(chat.id, "data:image/jpeg;base64,aGVsbG8=", "my photo (1).jpg");
    // consecutive junk chars are collapsed into one underscore
    expect(name).toMatch(/^my_photo_1_-[0-9a-f]{8}\.jpg$/);
  });

  it("throws on a string that is not a data URL", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(() => chats.saveImage(chat.id, "not-a-data-url")).toThrow(/data URL/);
  });
});

describe("importCharacterPhoto", () => {
  it("copies the photo into the chat files/ with a char- prefix", () => {
    const chat = chats.create(["a"], "m1", "me");
    const photo = path.join(os.tmpdir(), `sillytalk-photo-${process.pid}.png`);
    fs.writeFileSync(photo, "img");
    try {
      const name = chats.importCharacterPhoto(chat.id, photo);
      expect(name).toMatch(/^char-[0-9a-f]{8}\.png$/);
      expect(fs.readFileSync(path.join(root, chat.id, "files", name!))).toEqual(Buffer.from("img"));
    } finally {
      fs.rmSync(photo, { force: true });
    }
  });

  it("returns null when the photo does not exist", () => {
    const chat = chats.create(["a"], "m1", "me");
    expect(chats.importCharacterPhoto(chat.id, path.join(root, "nope.png"))).toBeNull();
  });
});

describe("normalizeImages", () => {
  it("saves data URLs, keeps existing file references, drops the rest", () => {
    const chat = chats.create(["a"], "m1", "me");
    const dataName = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    const result = chats.normalizeImages(chat.id, [
      "data:image/png;base64,aGVsbG8=",
      dataName,
      "missing.png",
      42,
      null,
      "",
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^img-[0-9a-f]{8}\.png$/);
    expect(result[1]).toBe(dataName);
  });

  it("checks only the file name in the chat files/ (paths are reduced to their basename)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const name = chats.saveImage(chat.id, "data:image/png;base64,aGVsbG8=");
    expect(chats.normalizeImages(chat.id, [path.join("/elsewhere", name)])).toEqual([name]);
    expect(chats.normalizeImages(chat.id, ["/elsewhere/missing.png"])).toEqual([]);
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
    chats.addUserMessage(chat, "a concurrent message", []);
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
