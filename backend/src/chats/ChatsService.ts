import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { Chat } from "./Chat";
import { ChatMessage } from "./ChatMessage";
import { ChatSummary } from "./ChatSummary";
import { PathHelper } from "../shared/PathHelper";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { createToken } from "../di";

// The DI token of the chat service (registered in index.ts).
export const DI_CHATS_SERVICE = createToken<ChatsService>("ChatsService");

// The row shapes of the chats database (node:sqlite, chats.db in the chats
// root): the chat fields as a JSON blob + one row per message (a JSON blob
// with seq/timestamp columns for the order and the list query).
type ChatRow = { data: string };
type MessageRow = { data: string };

// The top-level chat service: chat + chat-file persistence on top of the
// chats database — the `chats` table holds the chat fields, `messages` one
// row per message (both as JSON blobs). The images stay files on disk:
// chats/<id>/files/ is still the folder of the chat's uploaded/generated
// images. The root folder is read through the accessor (not injected as a
// value), so the service always sees the current SILLYTALK_CHATS_DIR / data
// root, and tests can point it at a temp dir; the configuration service is
// injected the same way (the model fallback in get() needs the current model
// list).
//
// The database is opened lazily on first use; at open the legacy per-chat
// chat.json folders are imported once. Every write is a single statement or
// a transaction: the message primitives (addUserMessage, editMessage,
// deleteMessage, setMessageImageStatus) touch only their own rows, so a
// background image job finishing can never clobber a concurrent change —
// the whole-file read-modify-write of the old format had that window.
export class ChatsService {
  constructor(
    private readonly chatsRoot: () => string,
    private readonly configuration: ConfigurationService,
  ) {}

  private dbRef: DatabaseSync | null = null;
  private closed = false;

  // Closes the database for good (tests do it before wiping a temp root — on
  // Windows an open database file blocks deleting its folder). Any later use
  // throws: a late callback (e.g. a background job that settled after the
  // close) must not resurrect the database file.
  close(): void {
    this.dbRef?.close();
    this.dbRef = null;
    this.closed = true;
  }

  // Opens the database on first use: WAL + the schema (idempotent), then the
  // one-time import of the legacy chat.json folders.
  private db(): DatabaseSync {
    if (this.dbRef) return this.dbRef;
    if (this.closed) throw new Error("The chats database is closed");
    const root = this.chatsRoot();
    fs.mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(PathHelper.chatsDatabaseFile(root), { timeout: 5000 });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        chat_id   TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        id        TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data      TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id, id);
    `);
    this.dbRef = db;
    this.importLegacyChats(db, root);
    return db;
  }

  // Runs fn inside a transaction (the counterpart of the old single-file
  // write's atomicity: a crash leaves the previous state, never half a chat).
  private transact(db: DatabaseSync, fn: () => void): void {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // The one-time import of the old format: every chats/<id>/chat.json is
  // inserted into the database and renamed to chat.json.migrated (kept for
  // recovery, never read again). A file that does not parse is skipped and
  // stays as it is — a corrupted chat was skipped by the old list() too.
  private importLegacyChats(db: DatabaseSync, root: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!PathHelper.isDirEntry(root, entry)) continue;
      const file = PathHelper.chatFile(entry.name, root);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf-8");
      } catch {
        continue; // no chat.json — a files/ folder of a chat, not an old chat
      }
      try {
        const chat = JSON.parse(raw) as Chat;
        if (typeof chat.id !== "string" || !chat.id) chat.id = entry.name;
        this.normalize(chat);
        if (!Array.isArray(chat.messages)) chat.messages = [];
        const known = db.prepare("SELECT 1 AS one FROM chats WHERE id = ?").get(chat.id);
        if (!known) {
          const insertMessage = db.prepare(
            "INSERT INTO messages (chat_id, seq, id, timestamp, data) VALUES (?, ?, ?, ?, ?)",
          );
          this.transact(db, () => {
            db.prepare("INSERT INTO chats (id, data) VALUES (?, ?)").run(chat.id, this.chatData(chat));
            chat.messages.forEach((msg, seq) => insertMessage.run(chat.id, seq, msg.id, msg.timestamp ?? 0, JSON.stringify(msg)));
          });
        }
        fs.renameSync(file, `${file}.migrated`);
      } catch {
        // a corrupted chat: skipped, its file stays for a manual look
      }
    }
  }

  // The chats-table blob of a chat: only the stored fields — the retired
  // ones (title/createdAt/updatedAt, a single characterId and userIds) are
  // never serialized.
  private chatData(chat: Chat): string {
    return JSON.stringify({
      id: chat.id,
      characterIds: chat.characterIds,
      userId: chat.userId,
      modelId: chat.modelId,
    });
  }

  // The chat list: every row with the message count and the timestamp of the
  // last message (0 for an empty chat), newest first — one SQL query, no
  // per-chat file reads.
  list(): ChatSummary[] {
    const rows = this.db()
      .prepare(
        `SELECT c.data AS data, COUNT(m.seq) AS messageCount, COALESCE(MAX(m.timestamp), 0) AS lastMessageAt
         FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
         GROUP BY c.id`,
      )
      .all() as (ChatRow & { messageCount: number; lastMessageAt: number })[];
    const result: ChatSummary[] = [];
    for (const row of rows) {
      try {
        const chat = JSON.parse(row.data) as Chat;
        result.push({
          id: chat.id,
          characterIds: chat.characterIds,
          userId: chat.userId,
          modelId: chat.modelId,
          messageCount: row.messageCount,
          lastMessageAt: row.lastMessageAt,
        });
      } catch {
        // skip a corrupted row (the blobs are written by save(), so this is
        // only a guard against a hand-edited database)
      }
    }
    return result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  // Reads one chat (its row + its message rows), repairing the format on the
  // fly (the repaired chat is saved back when anything was fixed).
  get(chatId: string): Chat | null {
    const db = this.db();
    const row = db.prepare("SELECT data FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!row) return null;
    let chat: Chat;
    try {
      chat = JSON.parse(row.data) as Chat;
    } catch {
      return null;
    }
    const rows = db
      .prepare("SELECT data FROM messages WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as MessageRow[];
    chat.messages = rows.map((m) => JSON.parse(m.data) as ChatMessage);
    // Called as methods (not as a bare-function array) — ensureModelId
    // needs the instance (the injected config loader).
    const dirty = this.normalize(chat) || this.ensureModelId(chat);
    if (dirty) this.save(chat);
    return chat;
  }

  // Writes the chat: the fields row + a full rewrite of its message rows in
  // one transaction (the callers of save mutate the message array in memory
  // — e.g. the splice-based regenerate path). The primitives below touch
  // single rows instead.
  save(chat: Chat): void {
    this.normalize(chat);
    const legacy = chat as Record<string, unknown>;
    delete legacy.title;
    delete legacy.createdAt;
    delete legacy.updatedAt;
    delete legacy.characterId;
    delete legacy.userIds;
    const db = this.db();
    const upsert = db.prepare(
      "INSERT INTO chats (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    );
    const clear = db.prepare("DELETE FROM messages WHERE chat_id = ?");
    const insert = db.prepare("INSERT INTO messages (chat_id, seq, id, timestamp, data) VALUES (?, ?, ?, ?, ?)");
    this.transact(db, () => {
      upsert.run(chat.id, this.chatData(chat));
      clear.run(chat.id);
      chat.messages.forEach((msg, seq) => insert.run(chat.id, seq, msg.id, msg.timestamp ?? 0, JSON.stringify(msg)));
    });
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

  // Deletes the chat — its rows and its folder (the files/ go along).
  delete(chatId: string): boolean {
    const db = this.db();
    const exists = db.prepare("SELECT 1 AS one FROM chats WHERE id = ?").get(chatId) !== undefined;
    this.transact(db, () => {
      db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    });
    fs.rmSync(PathHelper.chatDir(chatId, this.chatsRoot()), { recursive: true, force: true });
    return exists;
  }

  // ---- messages ----

  // Appends the user message (the chat's active persona is the author). A
  // single row insert — a concurrent change of the other messages (a job
  // finishing, another send) is not clobbered. `images` is the raw client
  // list: a data URL is saved as a new file, a file name is kept only when
  // the file is in the chat files/.
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
    this.insertMessage(chat.id, message);
    return message;
  }

  // Appends one message row after the last row of the chat.
  private insertMessage(chatId: string, message: ChatMessage): void {
    const db = this.db();
    const { seq } = db
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM messages WHERE chat_id = ?")
      .get(chatId) as { seq: number };
    db.prepare("INSERT INTO messages (chat_id, seq, id, timestamp, data) VALUES (?, ?, ?, ?, ?)").run(
      chatId,
      seq,
      message.id,
      message.timestamp ?? 0,
      JSON.stringify(message),
    );
  }

  // Applies an edit to an existing message: the text and/or the image list
  // (normalized to the chat files/), updating that one row.
  editMessage(chat: Chat, message: ChatMessage, text: string | undefined, images: string[] | undefined): void {
    if (text !== undefined) message.text = text;
    if (images !== undefined) message.images = this.normalizeImages(chat.id, images);
    this.db()
      .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
      .run(JSON.stringify(message), chat.id, message.id);
  }

  // Deletes a message: only it (single) or it and everything after it (trims
  // the tail of the dialogue) — a targeted row delete by the message's
  // stored order. Returns false when the chat has no such message.
  deleteMessage(chat: Chat, messageId: string, single = false): boolean {
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    if (single) chat.messages.splice(idx, 1);
    else chat.messages.splice(idx);
    const db = this.db();
    if (single) {
      db.prepare("DELETE FROM messages WHERE chat_id = ? AND id = ?").run(chat.id, messageId);
    } else {
      db.prepare(
        `DELETE FROM messages
         WHERE chat_id = ?
           AND seq >= COALESCE((SELECT seq FROM messages WHERE chat_id = ? AND id = ?), -1)`,
      ).run(chat.id, chat.id, messageId);
    }
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
  // image of one message. A single-row read-modify-write, so a job finishing
  // never clobbers a concurrent change to the other messages (a new message,
  // another job finishing). A missing chat or message is a silent no-op (it
  // was deleted while the job ran).
  setMessageImageStatus(
    chatId: string,
    messageId: string,
    image: string,
    status: "pending" | "failed" | "cancelled" | undefined,
    error?: string,
  ): void {
    const db = this.db();
    const row = db.prepare("SELECT data FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as
      | MessageRow
      | undefined;
    if (!row) return;
    let msg: ChatMessage;
    try {
      msg = JSON.parse(row.data) as ChatMessage;
    } catch {
      return;
    }
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
    if (dirty) {
      db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(JSON.stringify(msg), chatId, messageId);
    }
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
