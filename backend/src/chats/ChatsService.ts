import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Chat } from "./Chat";
import { ChatMessage } from "./ChatMessage";
import { ChatSummary } from "./ChatSummary";
import { PathHelper } from "../shared/PathHelper";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { createToken } from "../di";

// The DI token of the chat service (registered in index.ts).
export const DI_CHATS_SERVICE = createToken<ChatsService>("ChatsService");

// The top-level chat service: chat + chat-file persistence on top of the
// chats/<id>/ folders (chat.json + files/ — the chat's uploaded/generated
// images). The root folder is read through the accessor (not injected as a
// value), so the service always sees the current SILLYTALK_CHATS_DIR / data
// root, and tests can point it at a temp dir; the configuration service is
// injected the same way (the model fallback in get() needs the current model
// list).
export class ChatsService {
  constructor(
    private readonly chatsRoot: () => string,
    private readonly configuration: ConfigurationService,
  ) {}

  // The chat list: every folder with a chat.json, newest first (by the
  // timestamp of the last message).
  list(): ChatSummary[] {
    const root = this.chatsRoot();
    if (!fs.existsSync(root)) return [];
    const result: ChatSummary[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!PathHelper.isDirEntry(root, entry)) continue;
      const file = PathHelper.chatFile(entry.name, root);
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
    const file = PathHelper.chatFile(chatId, this.chatsRoot());
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
    fs.mkdirSync(PathHelper.chatDir(chat.id, root), { recursive: true });
    fs.writeFileSync(PathHelper.chatFile(chat.id, root), JSON.stringify(chat, null, 2), "utf-8");
  }

  create(characterIds: string[], modelId: string, userId: string): Chat {
    const chat: Chat = {
      id: PathHelper.newId(),
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
    const dir = PathHelper.chatDir(chatId, this.chatsRoot());
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ---- messages ----

  // Appends the user message (the chat's active persona is the author) and
  // saves the chat. `images` is the raw client list: a data URL is saved as a
  // new file, a file name is kept only when the file is in the chat files/.
  addUserMessage(chat: Chat, text: string, images: unknown[]): ChatMessage {
    const message: ChatMessage = {
      id: PathHelper.newId(),
      role: "user" as const,
      userId: chat.userId,
      text,
      images: this.normalizeImages(chat.id, images),
      timestamp: Date.now(),
    };
    chat.messages.push(message);
    this.save(chat);
    return message;
  }

  // Applies an edit to an existing message: the text and/or the image list
  // (normalized to the chat files/), saving the chat.
  editMessage(chat: Chat, message: ChatMessage, text: string | undefined, images: string[] | undefined): void {
    if (text !== undefined) message.text = text;
    if (images !== undefined) message.images = this.normalizeImages(chat.id, images);
    this.save(chat);
  }

  // Deletes a message: only it (single) or it and everything after it (trims
  // the tail of the dialogue), saving the chat. Returns false when the chat
  // has no such message.
  deleteMessage(chat: Chat, messageId: string, single = false): boolean {
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    if (single) chat.messages.splice(idx, 1);
    else chat.messages.splice(idx);
    this.save(chat);
    return true;
  }

  // ---- chat files (uploaded/generated images) ----

  // Saves a data URL into the chat files/, returns the file name.
  saveImage(chatId: string, dataUrl: string, originalName?: string): string {
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected a data URL like data:image/...;base64,...");
    const ext = ChatsService.EXT_BY_MIME[match[1]] ?? ".png";
    const base = (originalName ? path.basename(originalName, path.extname(originalName)) : "img")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 40);
    const filename = `${base || "img"}-${randomUUID().slice(0, 8)}${ext}`;
    const dir = PathHelper.chatFilesDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(match[2], "base64"));
    return filename;
  }

  // Copies a character photo into the chat files/, returns the file name.
  importCharacterPhoto(chatId: string, photoPath: string): string | null {
    if (!fs.existsSync(photoPath)) return null;
    const filename = `char-${randomUUID().slice(0, 8)}${path.extname(photoPath)}`;
    const dir = PathHelper.chatFilesDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(photoPath, path.join(dir, filename));
    return filename;
  }

  // Normalizes the image list to file names in the chat files/: a data URL
  // is saved as a new file; a string without data: is a reference to an
  // existing file (kept only when the file is there); anything else is
  // dropped.
  normalizeImages(chatId: string, images: unknown[]): string[] {
    const filesDir = PathHelper.chatFilesDir(chatId, this.chatsRoot());
    const saved: string[] = [];
    for (const img of images) {
      if (typeof img !== "string" || !img) continue;
      if (img.startsWith("data:")) {
        saved.push(this.saveImage(chatId, img));
      } else {
        const safe = path.basename(img);
        if (fs.existsSync(path.join(filesDir, safe))) saved.push(safe);
      }
    }
    return saved;
  }

  // Sets (or clears, when status is undefined) the generation status of one
  // image of one message, saving the chat. The chat is re-read on every call
  // so a job finishing never clobbers a concurrent change (a new message,
  // another job finishing). A missing chat or message is a silent no-op (it
  // was deleted while the job ran).
  setMessageImageStatus(
    chatId: string,
    messageId: string,
    image: string,
    status: "pending" | "failed" | "cancelled" | undefined,
    error?: string,
  ): void {
    const chat = this.get(chatId);
    if (!chat) return;
    const msg = chat.messages.find((m) => m.id === messageId);
    if (!msg) return;
    let dirty = false;
    if (status === undefined) {
      // The image is ready (or no longer belongs to the message): clear its
      // pending/failed status and the stored error.
      if (msg.imageStatus && image in msg.imageStatus) {
        delete msg.imageStatus[image];
        if (Object.keys(msg.imageStatus).length === 0) delete msg.imageStatus;
        dirty = true;
      }
      if (msg.imageErrors && image in msg.imageErrors) {
        delete msg.imageErrors[image];
        if (Object.keys(msg.imageErrors).length === 0) delete msg.imageErrors;
        dirty = true;
      }
    } else {
      msg.imageStatus = { ...(msg.imageStatus ?? {}), [image]: status };
      if (error !== undefined) msg.imageErrors = { ...(msg.imageErrors ?? {}), [image]: error };
      dirty = true;
    }
    if (dirty) this.save(chat);
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
    const models = this.configuration.listModels(this.configuration.loadConfig());
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
