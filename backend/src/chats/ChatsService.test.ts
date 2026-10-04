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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-chats-"));
  modelNames = ["m1", "m2"];
  chats = new ChatsService(() => root, new StubConfigurationService());
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Writes a chat.json directly (bypassing the service) to feed the service a
// corrupted or legacy-format file.
function writeChat(id: string, chat: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, "chat.json"), JSON.stringify(chat), "utf-8");
}

function rawChat(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, id, "chat.json"), "utf-8"));
}

describe("create / get / list", () => {
  it("creates the chat in its folder and reads it back", () => {
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

describe("get / save normalization", () => {
  it("get repairs a garbage characterIds and userId and saves it back", () => {
    writeChat("c1", { id: "c1", characterIds: "alice", userId: 42, modelId: "m1", messages: [] });
    const chat = chats.get("c1");
    expect(chat?.characterIds).toEqual([]);
    expect(chat?.userId).toBe("");
    // the repair landed on disk
    expect(rawChat("c1").characterIds).toEqual([]);
    expect(rawChat("c1").userId).toBe("");
  });

  it("get drops non-string entries from characterIds", () => {
    writeChat("c1", {
      id: "c1",
      characterIds: ["alice", 42, "", "bob"],
      userId: "me",
      modelId: "m1",
      messages: [],
    });
    expect(chats.get("c1")?.characterIds).toEqual(["alice", "bob"]);
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
    chats = new ChatsService(() => root, new StubConfigurationService());
    writeChat("c1", { id: "c1", characterIds: ["a"], userId: "me", modelId: "gone", messages: [] });
    expect(chats.get("c1")?.modelId).toBe("gone");
  });
});

describe("legacy fields", () => {
  it("save strips the fields that are no longer stored", () => {
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
    chats.save(chats.get("c1")!);
    const raw = rawChat("c1");
    expect(raw.title).toBeUndefined();
    expect(raw.createdAt).toBeUndefined();
    expect(raw.updatedAt).toBeUndefined();
    expect(raw.characterId).toBeUndefined();
    expect(raw.userIds).toBeUndefined();
  });
});

describe("delete", () => {
  it("deletes the chat folder with its files", () => {
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

  it("is a silent no-op for a missing chat or message", () => {
    expect(() => chats.setMessageImageStatus("nope", "m1", "gen-1.png", "pending")).not.toThrow();
    const chat = chats.create(["a"], "m1", "me");
    expect(() => chats.setMessageImageStatus(chat.id, "missing", "gen-1.png", "pending")).not.toThrow();
  });
});
