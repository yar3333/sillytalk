import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { Chat } from "./Chat";
import { ChatMessage, ImageGenerationData, isImageMessage } from "./ChatMessage";
import { ChatSummary } from "./ChatSummary";
import { PathHelper } from "../shared/PathHelper";
import { ImageMeta, IMAGE_GENERATION_KEYS } from "../shared/ImageMeta";
import { ImageMetaFile } from "../shared/ImageMetaFile";
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

  // The chats-table blob of a chat: only the stored fields — the retired ones
  // (title/updatedAt, a single characterId and userIds) are never serialized.
  private chatData(chat: Chat): string {
    return JSON.stringify({
      id: chat.id,
      name: chat.name,
      createdAt: chat.createdAt,
      characterIds: chat.characterIds,
      userId: chat.userId,
      modelId: chat.modelId,
      sampling: chat.sampling,
      systemSuffix: chat.systemSuffix,
      stylePrompt: chat.stylePrompt,
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
          name: chat.name,
          createdAt: chat.createdAt,
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
  // fly (the repaired chat is saved back when anything was fixed) and refreshing
  // the image cards from the sidecar *.json next to their files.
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
    // The sidecars are not persisted back into the database (they are the
    // portable copy the user may edit at any time), so this runs on every read
    // and is guarded by a stat-based cache.
    this.applySidecars(chat);
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
      createdAt: Date.now(),
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

  // Duplicates a chat: a new id, a copy of every message and a copy of the
  // chat's files/ folder with its sidecars. The participants, the persona, the
  // model, the sampling overrides and the system-prompt addition are copied;
  // the name gets a " (copy)" suffix (a nameless copy is titled by its own
  // creation date, exactly like the original).
  //
  // A picture is addressed by its path inside its own chat's folder, so the
  // copy must not point at the original's files: the folder is copied first and
  // every id of the copy — in the cards, in their reference lists and in the
  // sidecars — is repointed at the copy's folder. From then on the two chats
  // are independent: deleting either one leaves the other intact.
  clone(chatId: string): Chat | null {
    const source = this.get(chatId);
    if (!source) return null;
    const copy: Chat = {
      id: PathHelper.newId(),
      ...(source.name ? { name: `${source.name} (copy)` } : {}),
      createdAt: Date.now(),
      characterIds: [...source.characterIds],
      userId: source.userId,
      modelId: source.modelId,
      ...(source.sampling ? { sampling: { ...source.sampling } } : {}),
      ...(source.systemSuffix ? { systemSuffix: source.systemSuffix } : {}),
      ...(source.stylePrompt ? { stylePrompt: source.stylePrompt } : {}),
      messages: [],
    };
    const sourceDir = PathHelper.chatFilesDir(source.id, this.chatsRoot());
    const copyDir = PathHelper.chatFilesDir(copy.id, this.chatsRoot());
    if (fs.existsSync(sourceDir)) fs.cpSync(sourceDir, copyDir, { recursive: true });
    // The two folders as id prefixes ("chats/<id>/files/") — an id is a path
    // relative to the data root, so the prefix is computed, not guessed (the
    // chats folder may live outside the data root).
    const from = `${PathHelper.imageIdOf(sourceDir)}/`;
    const to = `${PathHelper.imageIdOf(copyDir)}/`;
    const repoint = (id: string): string => (id.startsWith(from) ? to + id.slice(from.length) : id);
    copy.messages = source.messages.map((m) => {
      const message: ChatMessage = { ...m, id: PathHelper.newId(), images: m.images.map(repoint) };
      if (m.generation?.refs?.length) {
        message.generation = { ...m.generation, refs: m.generation.refs.map(repoint) };
      }
      if (m.imageStatus) {
        const status: Record<string, "pending" | "failed" | "cancelled"> = {};
        const errors: Record<string, string> = {};
        for (const [id, value] of Object.entries(m.imageStatus)) {
          const img = repoint(id);
          if (value === "pending") {
            // The job that draws it belongs to the original chat — its file
            // lands there, never in the copy. A spinner that can never finish
            // is worse than a broken card with a reason and a Regenerate button.
            status[img] = "failed";
            errors[img] = "The chat was cloned while this picture was being drawn — regenerate it.";
          } else {
            status[img] = value;
            const error = m.imageErrors?.[id];
            if (error) errors[img] = error;
          }
        }
        message.imageStatus = status;
        if (Object.keys(errors).length > 0) message.imageErrors = errors;
      }
      return message;
    });
    // The sidecars came along with the folder, so the references they list
    // still name the original's files; only a sidecar whose refs actually
    // changed is rewritten (its updatedAt is the user's copy, not ours to bump).
    for (const m of copy.messages) {
      for (const id of m.images) {
        const file = PathHelper.resolveImageId(id);
        if (!file) continue;
        const meta = ImageMetaFile.read(file);
        if (!meta?.refs?.length) continue;
        const refs = meta.refs.map(repoint);
        if (refs.join(",") !== meta.refs.join(",")) ImageMetaFile.write(file, { ...meta, refs });
      }
    }
    this.save(copy);
    return this.get(copy.id) ?? copy;
  }

  // ---- messages ----

  // Appends a text message (the chat's active persona is the author). A single
  // row insert — a concurrent change of the other messages (a job finishing,
  // another send) is not clobbered. A text message carries no images: a picture
  // is always its own card (addImageMessage).
  addUserMessage(chat: Chat, text: string): ChatMessage {
    const message: ChatMessage = {
      id: PathHelper.newId(),
      role: "user" as const,
      kind: "text",
      userId: chat.userId,
      text,
      images: [],
      timestamp: Date.now(),
    };
    chat.messages.push(message);
    this.insertMessage(chat.id, message);
    return message;
  }

  // Appends an image card — the message that carries one picture with its own
  // description and generation data. The image is referenced by id; the file
  // itself may not exist yet (a background generation reserves its id in
  // advance and the status says so).
  //
  // The generation data is written into the sidecar *.json next to the file
  // too, so the picture carries its own story out of the database. A pending
  // image has no file yet, so its sidecar appears when the generation starts.
  addImageMessage(
    chat: Chat,
    image: string,
    opts: {
      userId?: string;
      description?: string;
      generation?: ImageGenerationData;
      depicts?: string[];
      status?: "pending" | "failed" | "cancelled";
      error?: string;
    } = {},
  ): ChatMessage {
    const message: ChatMessage = {
      id: PathHelper.newId(),
      role: "user" as const,
      kind: "image",
      userId: opts.userId ?? chat.userId,
      text: opts.description ?? "",
      images: [image],
      generation: opts.generation,
      depicts: opts.depicts && opts.depicts.length > 0 ? opts.depicts : undefined,
      imageStatus: opts.status ? { [image]: opts.status } : undefined,
      imageErrors: opts.status && opts.error ? { [image]: opts.error } : undefined,
      timestamp: Date.now(),
    };
    chat.messages.push(message);
    this.insertMessage(chat.id, message);
    this.writeSidecar(image, opts.description, opts.generation, message.depicts);
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

  // Applies a text edit to an existing message — the line of a text message,
  // the description (caption) of an image card — updating that one row. For a
  // card the sidecar next to the file is refreshed too, so the two copies of
  // the description do not drift apart.
  editMessage(chat: Chat, message: ChatMessage, text: string): void {
    message.text = text;
    this.db()
      .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
      .run(JSON.stringify(message), chat.id, message.id);
    if (isImageMessage(message)) this.writeSidecar(message.images[0], text, message.generation, message.depicts);
  }

  // The caption of one message row, by ids (a background job that finally knows
  // what its picture shows has no message object at hand). The sidecar of the
  // card is refreshed with it. Returns false when the row is gone.
  setMessageText(chatId: string, messageId: string, text: string): boolean {
    const db = this.db();
    const row = db.prepare("SELECT data FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as
      | MessageRow
      | undefined;
    if (!row) return false;
    let msg: ChatMessage;
    try {
      msg = JSON.parse(row.data) as ChatMessage;
    } catch {
      return false;
    }
    msg.text = text;
    db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(JSON.stringify(msg), chatId, messageId);
    if (isImageMessage(msg)) this.writeSidecar(msg.images[0], text, msg.generation, msg.depicts);
    return true;
  }

  // Who a card claims is on its picture (cast refs), written by ids the same
  // way setMessageText writes the caption: the sidecar next to the file is
  // refreshed with it, so the picture carries its cast outside the database and
  // the user can correct it by hand. Returns false when the row is gone.
  setMessageDepicts(chatId: string, messageId: string, depicts: string[]): boolean {
    const db = this.db();
    const row = db.prepare("SELECT data FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as
      | MessageRow
      | undefined;
    if (!row) return false;
    let msg: ChatMessage;
    try {
      msg = JSON.parse(row.data) as ChatMessage;
    } catch {
      return false;
    }
    if (depicts.length > 0) msg.depicts = depicts;
    else delete msg.depicts;
    db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(JSON.stringify(msg), chatId, messageId);
    if (isImageMessage(msg)) this.writeSidecar(msg.images[0], msg.text, msg.generation, msg.depicts);
    return true;
  }

  // Edits an image card: its description (what is on the picture) and its
  // generation prompt. Both go into the row and into the sidecar, so the two
  // copies never disagree — the sidecar is the one the user may hand-edit,
  // the row the one the UI renders.
  editImageCard(
    chat: Chat,
    message: ChatMessage,
    patch: {
      description?: string;
      prompt?: string;
      // The people visible on the picture (cast refs). Given as [] — nobody is
      // claimed, which stops the card being offered as somebody's look
      // reference.
      depicts?: string[];
      // undefined — keep the generation block as it is; null — the card stops
      // claiming a generation (the picture is just a file now); an object —
      // replaces the block (the caller merges what it keeps).
      generation?: ImageGenerationData | null;
    },
  ): void {
    if (patch.description !== undefined) message.text = patch.description;
    if (patch.depicts !== undefined) {
      if (patch.depicts.length > 0) message.depicts = patch.depicts;
      else delete message.depicts;
    }
    if (patch.prompt !== undefined) {
      message.generation = { ...(message.generation ?? {}), prompt: patch.prompt };
    }
    if (patch.generation !== undefined) {
      if (patch.generation === null) delete message.generation;
      else message.generation = patch.generation;
    }
    this.db()
      .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
      .run(JSON.stringify(message), chat.id, message.id);
    // The sidecar wins over the row on read, so a dropped generation block has
    // to go from the file too (ImageMetaFile.write removes a key given as
    // undefined) — otherwise the prompt would come back on the next read.
    const file = patch.generation === null ? PathHelper.resolveImageId(message.images[0]) : null;
    if (file) {
      const cleared: ImageMeta = {};
      for (const key of IMAGE_GENERATION_KEYS) cleared[key] = undefined;
      ImageMetaFile.write(file, cleared);
    }
    this.writeSidecar(message.images[0], message.text, message.generation, message.depicts);
  }

  // Points an image message at another file: the id is swapped in the message
  // (and in its status/error maps), the sidecar moves along with it, and the row
  // is rewritten. Used when a placeholder gets its real, human-readable file name
  // — the message the user already sees becomes the picture, no new row.
  // Returns false when the chat or the message is gone.
  replaceMessageImageId(chatId: string, messageId: string, oldId: string, newId: string): boolean {
    const db = this.db();
    const row = db
      .prepare("SELECT data FROM messages WHERE chat_id = ? AND id = ?")
      .get(chatId, messageId) as MessageRow | undefined;
    if (!row) return false;
    let msg: ChatMessage;
    try {
      msg = JSON.parse(row.data) as ChatMessage;
    } catch {
      return false;
    }
    if (!msg.images.includes(oldId)) return false;
    msg.images = msg.images.map((x) => (x === oldId ? newId : x));
    if (msg.imageStatus && oldId in msg.imageStatus) {
      msg.imageStatus[newId] = msg.imageStatus[oldId];
      delete msg.imageStatus[oldId];
    }
    if (msg.imageErrors && oldId in msg.imageErrors) {
      msg.imageErrors[newId] = msg.imageErrors[oldId];
      delete msg.imageErrors[oldId];
    }
    db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(JSON.stringify(msg), chatId, messageId);
    const from = PathHelper.resolveImageId(oldId);
    const to = PathHelper.resolveImageId(newId);
    if (from && to) ImageMetaFile.move(from, to);
    return true;
  }

  // Swaps one picture of a message for another (the user replacing a generated
  // picture with their own file): the new id replaces the old one and the
  // generation data goes with the old picture — what is there now is a user
  // upload, with no prompt behind it. The old file stays on disk (another
  // picture may still use it as a reference, sidecar and all). The new file
  // must already be saved by the caller.
  replaceMessageImage(chat: Chat, message: ChatMessage, oldImage: string, newImage: string): void {
    message.images = message.images.map((x) => (x === oldImage ? newImage : x));
    for (const key of ["imageErrors", "imageStatus"] as const) {
      const map = message[key] as Record<string, unknown> | undefined;
      if (!map) continue;
      delete map[oldImage];
      if (Object.keys(map).length === 0) delete message[key];
    }
    if (isImageMessage(message)) {
      delete message.generation;
      this.writeSidecar(newImage, message.text, undefined);
    }
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
  //
  // A chat image lives in chats/<chatId>/files/ and is named by its path
  // relative to the data folder ("chats/<id>/files/a-sunset-3f2a1c.png"), which
  // is what the message stores, what the API carries and what a sidecar lists
  // as a generation reference.

  // Saves a data URL into the chat files/, returns the image id. `nameHint` is
  // the wanted human-readable base name ("a sunset over the sea"); a unique
  // suffix is appended either way, so two pictures never share a file. `meta`
  // is written next to the file as its sidecar.
  saveImage(chatId: string, dataUrl: string, opts: { nameHint?: string; meta?: ImageMeta } = {}): string {
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected a data URL like data:image/...;base64,...");
    const ext = ChatsService.EXT_BY_MIME[match[1]] ?? ".png";
    const filename = `${ChatsService.slugify(opts.nameHint ?? "img", "img")}-${randomUUID().slice(0, 6)}${ext}`;
    const dir = PathHelper.chatFilesDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filename);
    fs.writeFileSync(file, Buffer.from(match[2], "base64"));
    if (opts.meta) ImageMetaFile.write(file, opts.meta);
    return PathHelper.imageIdOf(file);
  }

  // The id a generated image will be saved under in the chat files/ (the file
  // itself appears when the background job finishes — the id is reserved in the
  // message first). `nameHint` is the human-readable English name (2–5 words).
  reservedImageId(chatId: string, nameHint: string, extension = ".png"): string {
    const dir = PathHelper.chatFilesDir(chatId, this.chatsRoot());
    const filename = `${ChatsService.slugify(nameHint, "image")}-${randomUUID().slice(0, 6)}${extension}`;
    return PathHelper.imageIdOf(path.join(dir, filename));
  }

  // Copies a file from anywhere in the data folders into the chat files/,
  // returns its id (null when the source is missing). The sidecar of the source
  // is copied along, so an imported picture keeps its description.
  importImage(chatId: string, sourcePath: string): string | null {
    if (!fs.existsSync(sourcePath)) return null;
    const dir = PathHelper.chatFilesDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    const base = ChatsService.slugify(path.basename(sourcePath, path.extname(sourcePath)), "photo");
    const target = path.join(dir, `${base}-${randomUUID().slice(0, 6)}${path.extname(sourcePath)}`);
    fs.copyFileSync(sourcePath, target);
    const id = PathHelper.imageIdOf(target);
    ImageMetaFile.copy(sourcePath, target);
    return id;
  }

  // Copies a character photo into the chat files/ (the 🎨 reference picker),
  // returns the image id.
  importCharacterPhoto(chatId: string, photoPath: string): string | null {
    return this.importImage(chatId, photoPath);
  }

  // Normalizes an incoming image list into image ids: a data URL is saved as a
  // new file and an id is kept when its file is there. Anything else — a path
  // outside the data folders, a missing file, garbage — is dropped.
  normalizeImages(chatId: string, images: unknown[]): string[] {
    const saved: string[] = [];
    for (const img of images) {
      if (typeof img !== "string" || !img) continue;
      if (img.startsWith("data:")) {
        saved.push(this.saveImage(chatId, img));
        continue;
      }
      const abs = PathHelper.resolveImageId(img);
      if (abs && fs.existsSync(abs)) saved.push(PathHelper.imageIdOf(abs));
    }
    return saved;
  }

  // A file-name-safe English slug of 2–5 words: the leading words of the prompt
  // or name with everything that is not a letter or a digit dropped,
  // transliterated out of Cyrillic (a Russian prompt reaches the slug through
  // the translated prompt, but a hand-named file may not) and joined with "-".
  // Empty input falls back to `fallback`.
  static slugify(text: string, fallback = "image"): string {
    const cyrillic: Record<string, string> = {
      а: "a",
      б: "b",
      в: "v",
      г: "g",
      д: "d",
      е: "e",
      ё: "e",
      ж: "zh",
      з: "z",
      и: "i",
      й: "y",
      к: "k",
      л: "l",
      м: "m",
      н: "n",
      о: "o",
      п: "p",
      р: "r",
      с: "s",
      т: "t",
      у: "u",
      ф: "f",
      х: "h",
      ц: "c",
      ч: "ch",
      ш: "sh",
      щ: "sch",
      ъ: "",
      ы: "y",
      ь: "",
      э: "e",
      ю: "yu",
      я: "ya",
    };
    const latin = [...text.toLowerCase()].map((ch) => (ch in cyrillic ? cyrillic[ch] : ch)).join("");
    const slug = latin
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0)
      .slice(0, 5)
      .join("-")
      .slice(0, 48)
      .replace(/^-+|-+$/g, "");
    return slug || (fallback && fallback !== text ? ChatsService.slugify(fallback, "image") : "") || "image";
  }

  // ---- the sidecar *.json next to an image ----

  // Writes the description + the generation data next to the image file. Only
  // called when there is something to say: an upload with no description gets
  // no sidecar, so the files/ folder is not littered with empty ones.
  // `depicts` — the cast refs of the people visible on the picture; it belongs
  // to the picture, not to its generation, so an upload carries it too.
  writeSidecar(
    imageId: string | undefined,
    description: string | undefined,
    generation?: ImageGenerationData,
    depicts?: string[],
  ): void {
    if (!imageId) return;
    const file = PathHelper.resolveImageId(imageId);
    if (!file) return;
    const meta: ImageMeta = {};
    if (description && description.trim()) meta.description = description.trim();
    if (depicts && depicts.length > 0) meta.depicts = depicts;
    if (generation) {
      // An empty prompt is written as-is: clearing the prompt of a card is a
      // real edit (the picture then has nothing to be redrawn from), and only
      // an explicit value — never its absence — may overwrite the sidecar.
      if (generation.prompt !== undefined) meta.prompt = generation.prompt;
      if (generation.refs && generation.refs.length > 0) meta.refs = generation.refs;
      if (generation.negativePrompt) meta.negativePrompt = generation.negativePrompt;
      if (generation.source) meta.source = generation.source;
      if (generation.generator) meta.generator = generation.generator;
      if (generation.model) meta.model = generation.model;
      if (generation.width !== undefined) meta.width = generation.width;
      if (generation.height !== undefined) meta.height = generation.height;
      if (generation.steps !== undefined) meta.steps = generation.steps;
    }
    if (Object.keys(meta).length === 0) return;
    ImageMetaFile.write(file, meta);
  }

  // Refreshes the image cards from the sidecars next to their files: the file
  // next to the picture is the copy the user may edit by hand, so on read it
  // wins over the snapshot in the database. A card whose file has no sidecar
  // keeps what the message stores (a pending generation, for instance).
  //
  // Runs on every get() — including the client's polling — so the parsed files
  // are cached per (size, mtime) and re-read only when they actually change.
  private applySidecars(chat: Chat): void {
    for (const m of chat.messages) {
      if (!isImageMessage(m) || m.images.length === 0) continue;
      const meta = this.sidecarMeta(m.images[0]);
      if (!meta) continue;
      if (meta.description !== undefined && meta.description !== m.text) m.text = meta.description;
      const generation: ImageGenerationData = { ...(m.generation ?? {}) };
      let dirty = false;
      for (const key of ["prompt", "negativePrompt", "source", "generator", "model"] as const) {
        if (meta[key] !== undefined && generation[key] !== meta[key]) {
          Object.assign(generation, { [key]: meta[key] });
          dirty = true;
        }
      }
      for (const key of ["width", "height", "steps"] as const) {
        if (meta[key] !== undefined && generation[key] !== meta[key]) {
          Object.assign(generation, { [key]: meta[key] });
          dirty = true;
        }
      }
      if (meta.refs !== undefined && meta.refs.join(",") !== (generation.refs ?? []).join(",")) {
        generation.refs = meta.refs;
        dirty = true;
      }
      if (dirty) m.generation = generation;
      // Who is on the picture: the sidecar is the copy the user can fix by hand
      // ("this photo is Alice"), so it wins here too.
      if (meta.depicts !== undefined) {
        const fromFile = Array.isArray(meta.depicts) ? meta.depicts.filter((x) => typeof x === "string") : [];
        if (fromFile.join(",") !== (m.depicts ?? []).join(",")) m.depicts = fromFile.length > 0 ? fromFile : undefined;
      }
    }
  }

  // The sidecar of one image, cached by the file's signature (size + mtime) so
  // a poll does not re-read and re-parse every picture of the chat.
  private readonly sidecarCache = new Map<string, { signature: string; meta: ImageMeta | null }>();

  private sidecarMeta(imageId: string): ImageMeta | null {
    const file = PathHelper.resolveImageId(imageId);
    if (!file) return null;
    const signature = ImageMetaFile.signature(file);
    const cached = this.sidecarCache.get(file);
    if (cached && cached.signature === signature) return cached.meta;
    const meta = ImageMetaFile.read(file);
    this.sidecarCache.set(file, { signature, meta });
    return meta;
  }

  // Drops the cached sidecars (a test that rewrote the files behind the
  // service's back, or a data root that moved).
  clearSidecarCache(): void {
    this.sidecarCache.clear();
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
  // userId — a string, createdAt — the creation date. After the one-off
  // conversion of old chat.json files this is only a guard against garbage, not
  // support for the old format.
  private normalize(chat: Chat): boolean {
    let dirty = false;
    // The creation date is the title of a nameless chat, so a chat without one
    // (a row written before the field existed) takes the date of its first
    // message — the closest thing to when it started — or, for an empty one,
    // the moment it is first read.
    if (typeof chat.createdAt !== "number" || !Number.isFinite(chat.createdAt)) {
      const first = Array.isArray(chat.messages) ? chat.messages[0]?.timestamp : undefined;
      chat.createdAt = typeof first === "number" && Number.isFinite(first) ? first : Date.now();
      dirty = true;
    }
    // name: a trimmed non-empty string or nothing at all (an absent name means
    // "title this chat by its creation date"). Emptying it in the dialog is
    // flagged dirty so the cleanup is persisted.
    if (chat.name !== undefined) {
      const t = typeof chat.name === "string" ? chat.name.trim() : "";
      if (t) chat.name = t;
      else {
        delete chat.name;
        dirty = true;
      }
    }
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
    // sampling: keep only the valid numeric fields (an all-empty object is
    // dropped entirely so the blob stays small).
    if (chat.sampling !== undefined) {
      const s = chat.sampling as Record<string, unknown>;
      const clean: Record<string, number> = {};
      for (const [key, range] of [
        ["temperature", [0, 2]],
        ["minP", [0, 1]],
        ["repetitionPenalty", [0, 2]],
      ] as const) {
        const v = s[key];
        if (typeof v === "number" && Number.isFinite(v) && v >= range[0] && v <= range[1]) {
          clean[key] = v;
        } else {
          dirty = true;
        }
      }
      chat.sampling = Object.keys(clean).length > 0 ? (clean as Chat["sampling"]) : undefined;
    }
    // systemSuffix: a trimmed non-empty string or nothing. Emptying it in the
    // dialog is flagged dirty so the cleanup is persisted.
    if (chat.systemSuffix !== undefined) {
      const t = typeof chat.systemSuffix === "string" ? chat.systemSuffix.trim() : "";
      if (t) chat.systemSuffix = t;
      else {
        delete chat.systemSuffix;
        dirty = true;
      }
    }
    // stylePrompt: the one look every picture of this chat shares — the same
    // rule as systemSuffix (a trimmed non-empty string or nothing at all).
    if (chat.stylePrompt !== undefined) {
      const t = typeof chat.stylePrompt === "string" ? chat.stylePrompt.trim() : "";
      if (t) chat.stylePrompt = t;
      else {
        delete chat.stylePrompt;
        dirty = true;
      }
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
