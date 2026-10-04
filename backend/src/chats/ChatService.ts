import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Chat, ChatSummary, Config } from "../types";
import { chatDir, chatFile, chatFilesDir, isDirEntry, listModels, newId } from "../config";
import { createToken } from "../di";

// The DI token of the chat service (registered in index.ts).
export const CHATS = createToken<ChatService>("ChatService");

// The top-level chat service: chat + chat-file persistence on top of the
// chats/<id>/ folders (chat.json + files/ — the chat's uploaded/generated
// images). The root folder is read through the accessor (not injected as a
// value), so the service always sees the current SILLYTALK_CHATS_DIR / data
// root, and tests can point it at a temp dir; the config loader is injected
// the same way (the model fallback in get() needs the current model list).
export class ChatService {
  constructor(
    private readonly chatsRoot: () => string,
    private readonly loadConfig: () => Config,
  ) {}

  // The chat list: every folder with a chat.json, newest first (by the
  // timestamp of the last message).
  list(): ChatSummary[] {
    const root = this.chatsRoot();
    if (!fs.existsSync(root)) return [];
    const result: ChatSummary[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!isDirEntry(root, entry)) continue;
      const file = chatFile(entry.name, root);
      if (!fs.existsSync(file)) continue;
      try {
        const chat = JSON.parse(fs.readFileSync(file, "utf-8")) as Chat;
        const { messages, ...rest } = chat;
        const lastMessageAt = messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
        result.push({ ...rest, messageCount: messages.length, lastMessageAt });
      } catch {
        // skip a corrupted chat
      }
    }
    return result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  // Reads one chat, repairing the format on the fly (the repaired chat is
  // saved back when anything was fixed).
  get(chatId: string): Chat | null {
    const file = chatFile(chatId, this.chatsRoot());
    if (!fs.existsSync(file)) return null;
    try {
      const chat = JSON.parse(fs.readFileSync(file, "utf-8")) as Chat;
      // Called as methods (not as a bare-function array) — ensureModelId
      // needs the instance (the injected config loader).
      const dirty = this.normalize(chat) || this.ensureModelId(chat);
      if (dirty) this.save(chat);
      return chat;
    } catch {
      return null;
    }
  }

  // Writes the chat to disk. Old chat.json files may still carry
  // title/createdAt/updatedAt, a single characterId and userIds — they are
  // stripped on every write; the fields are no longer stored.
  save(chat: Chat): void {
    this.normalize(chat);
    const legacy = chat as Record<string, unknown>;
    delete legacy.title;
    delete legacy.createdAt;
    delete legacy.updatedAt;
    delete legacy.characterId;
    delete legacy.userIds;
    const root = this.chatsRoot();
    fs.mkdirSync(chatDir(chat.id, root), { recursive: true });
    fs.writeFileSync(chatFile(chat.id, root), JSON.stringify(chat, null, 2), "utf-8");
  }

  create(characterIds: string[], modelId: string, userId: string): Chat {
    const chat: Chat = {
      id: newId(),
      characterIds: [...characterIds],
      userId,
      modelId,
      messages: [],
    };
    this.save(chat);
    return chat;
  }

  // Deletes the chat together with its folder (the files/ go along).
  delete(chatId: string): boolean {
    const dir = chatDir(chatId, this.chatsRoot());
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ---- chat files (uploaded/generated images) ----

  // Saves a data URL into the chat files/, returns the file name.
  saveImage(chatId: string, dataUrl: string, originalName?: string): string {
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected a data URL like data:image/...;base64,...");
    const ext = ChatService.EXT_BY_MIME[match[1]] ?? ".png";
    const base = (originalName ? path.basename(originalName, path.extname(originalName)) : "img")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 40);
    const filename = `${base || "img"}-${randomUUID().slice(0, 8)}${ext}`;
    const dir = chatFilesDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(match[2], "base64"));
    return filename;
  }

  // Copies a character photo into the chat files/, returns the file name.
  importCharacterPhoto(chatId: string, photoPath: string): string | null {
    if (!fs.existsSync(photoPath)) return null;
    const filename = `char-${randomUUID().slice(0, 8)}${path.extname(photoPath)}`;
    const dir = chatFilesDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(photoPath, path.join(dir, filename));
    return filename;
  }

  // ---- on-disk format guards ----

  // Guarantees the current chat format: characterIds — an array of strings,
  // userId — a string. After the one-off conversion of old chat.json files
  // this is only a guard against garbage, not support for the old format.
  private normalize(chat: Chat): boolean {
    let dirty = false;
    if (!Array.isArray(chat.characterIds)) {
      chat.characterIds = [];
      dirty = true;
    } else {
      const before = chat.characterIds.length;
      chat.characterIds = chat.characterIds.filter((id) => typeof id === "string" && id);
      if (chat.characterIds.length !== before) dirty = true;
    }
    if (typeof chat.userId !== "string") {
      chat.userId = "";
      dirty = true;
    }
    return dirty;
  }

  // The chat's model may have disappeared from the config (renamed/deleted) —
  // attach the first available one so the chat keeps working.
  private ensureModelId(chat: Chat): boolean {
    const models = listModels(this.loadConfig());
    if (models.length === 0 || models.some((m) => m.name === chat.modelId)) return false;
    chat.modelId = models[0].name;
    return true;
  }

  // The file extension for the image MIME types the uploads may carry.
  private static readonly EXT_BY_MIME: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
}
