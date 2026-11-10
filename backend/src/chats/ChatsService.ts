import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { Chat } from "./Chat";
import { ChatMessage, ImageGenerationData, isImageMessage } from "./ChatMessage";
import { ChatSummary } from "./ChatSummary";
import { PathHelper } from "../shared/PathHelper";
import { HttpHelper } from "../shared/HttpHelper";
import { ImageMeta, IMAGE_GENERATION_KEYS } from "../shared/ImageMeta";
import { FileFacts } from "../shared/FileFacts";
import { ImageMetaService } from "../images/ImageMetaService";
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
// images. What is KNOWN about a picture (its description, its prompt, its
// cast) is not in the message row at all — it lives in the one global images
// table (ImageMetaService), which is what an image card is filled from on
// read. The root folder is read through the accessor (not injected as a
// value), so the service always sees the current SILLYTALK_CHATS_DIR / data
// root, and tests can point it at a temp dir. The models are global settings,
// so this service has no business with the config at all.
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
    private readonly imageMeta: ImageMetaService,
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

  // Whether a chat exists — a cheap row check, without parsing anything. A
  // background image job asks this before it starts: its card lives in the
  // database, so the chat's folder is not evidence (a chat owns one only once
  // it has a file).
  exists(chatId: string): boolean {
    return this.db().prepare("SELECT 1 AS one FROM chats WHERE id = ?").get(chatId) !== undefined;
  }

  // Reads one chat (its row + its message rows), repairing the format on the
  // fly (the repaired chat is saved back when anything was fixed) and filling
  // the image cards from the one global images table.
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
    // The format guard: a chat that still carries the retired per-chat model
    // picks loses them here, and the repaired chat is saved back. The models
    // are global settings now (Config.chatModel / Config.visionModel).
    const dirty = this.normalize(chat);
    if (dirty) this.save(chat);
    // The picture data comes from the images table, on every read — including
    // the client's polling, so a picture edited elsewhere shows up here.
    this.applyImageMeta(chat);
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
    delete legacy.modelId;
    delete legacy.visionModelId;
    const db = this.db();
    const upsert = db.prepare(
      "INSERT INTO chats (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    );
    const clear = db.prepare("DELETE FROM messages WHERE chat_id = ?");
    const insert = db.prepare("INSERT INTO messages (chat_id, seq, id, timestamp, data) VALUES (?, ?, ?, ?, ?)");
    this.transact(db, () => {
      upsert.run(chat.id, this.chatData(chat));
      clear.run(chat.id);
      chat.messages.forEach((msg, seq) => insert.run(chat.id, seq, msg.id, msg.timestamp ?? 0, this.messageData(msg)));
    });
  }

  // The messages-table blob of one message. An image card stores NO picture
  // data here — no caption, no prompt, no cast: the images table owns all of it
  // (see applyImageMeta / writeImageMeta), so a card and its picture cannot
  // disagree and there is exactly one place to edit them. The caption field
  // stays in the JSON as an empty string because every reader of a message
  // expects it there; it is filled from the table on read.
  private messageData(message: ChatMessage): string {
    if (!isImageMessage(message)) return JSON.stringify(message);
    const card: ChatMessage = { ...message, text: "" };
    delete card.generation;
    delete card.depicts;
    return JSON.stringify(card);
  }

  create(characterIds: string[], userId: string): Chat {
    const chat: Chat = {
      id: this.newChatId(),
      createdAt: Date.now(),
      characterIds: [...characterIds],
      userId,
      messages: [],
    };
    this.save(chat);
    return chat;
  }

  // The ID of a chat names its folder (chats/<id>/, the home of its files/) and
  // is the key of its rows at once, so the allowed characters are those of a
  // folder name — the same rule as for a character or a persona ID.
  isValidId(id: unknown): id is string {
    return (
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= 100 &&
      !id.startsWith(".") &&
      !id.includes("/") &&
      !id.includes("\\") &&
      !id.includes("\0") &&
      /^[\p{L}\p{N}._-]+$/u.test(id)
    );
  }

  // A new chat is named by its creation moment — "2026-02-08_14-03-22" — which
  // reads meaningfully in a chat ID, in a picture id (chats/<id>/files/…) and in
  // a file listing, where a UUID says nothing. Two chats created in the same
  // second take a "-2", "-3" suffix, so the name stays unique (a row or a folder
  // still standing there counts as taken).
  private newChatId(): string {
    const base = ChatsService.timestampId(Date.now());
    let id = base;
    for (let n = 2; this.exists(id) || fs.existsSync(PathHelper.chatDir(id, this.chatsRoot())); n++) {
      id = `${base}-${n}`;
    }
    return id;
  }

  // The local time as "yyyy-mm-dd_hh-mm-ss" — the folder-name-safe form of the
  // creation date (digits, "-" and "_" only).
  private static timestampId(ms: number): string {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  // Gives the chat a new ID. An ID is the key of the chat's rows AND the name of
  // its folder, so — exactly like a character rename — this is a move, not a
  // field edit: the folder goes to the new name, the rows take it and every
  // picture id built on it ("chats/<old>/files/x.png" — the cards, the status
  // maps, the stored reference sets and the rows of the images table) follows,
  // or the cards lose their files.
  //
  // Throws with the reason when the name is not a usable ID, there is no such
  // chat, another chat already lives there, or a picture of the chat is still
  // being drawn — a running job writes to the ids of the OLD name, so renaming
  // under its feet would lose its picture (the same guard the picture editor
  // applies to a card swap).
  rename(chatId: string, newId: string): Chat {
    if (!this.isValidId(newId)) {
      throw new Error(
        `"${newId}" is not a valid ID — letters, digits, ".", "-" and "_", no leading dot, at most 100 characters`,
      );
    }
    const chat = this.get(chatId);
    if (!chat) throw new Error(`There is no chat "${chatId}"`);
    if (newId === chatId) return chat;
    // Taken by a row or by a folder still standing there — a rename never
    // overwrites a chat and never lands on files that belong to nobody.
    if (this.exists(newId) || fs.existsSync(PathHelper.chatDir(newId, this.chatsRoot()))) {
      throw new Error(`There is already a chat with the ID "${newId}"`);
    }
    const pending = chat.messages.some((m) =>
      m.imageStatus ? Object.values(m.imageStatus).includes("pending") : false,
    );
    if (pending) {
      throw new Error("A picture of this chat is still being generated — wait for it or cancel it first");
    }
    // The picture ids are collected BEFORE the move (after it the folder has a
    // different name and there is nothing left to enumerate), and they include
    // the rows that describe a file the user already deleted by hand — an
    // orphan row follows too, or it stays behind naming a path that never
    // existed under the new ID.
    const fromDir = PathHelper.chatDir(chatId, this.chatsRoot());
    const pairs = this.picturePairs(fromDir, PathHelper.chatDir(newId, this.chatsRoot()));
    const db = this.db();
    chat.id = newId;
    this.transact(db, () => {
      // The blob carries the id of its chat, so the row is rewritten, not just
      // re-keyed (the message rows only name the chat through chat_id).
      db.prepare("UPDATE chats SET id = ?, data = ? WHERE id = ?").run(newId, this.chatData(chat), chatId);
      db.prepare("UPDATE messages SET chat_id = ? WHERE chat_id = ?").run(newId, chatId);
    });
    if (fs.existsSync(fromDir)) fs.renameSync(fromDir, PathHelper.chatDir(newId, this.chatsRoot()));
    // First the cards and the reference lists (repointImageId does both, and it
    // scans rows by their content, so the rewrites above do not hide them),
    // then the rows themselves — a row belongs to the picture, so it travels
    // with the file.
    for (const [oldId, nextId] of pairs) {
      this.repointImageId(oldId, nextId);
      this.imageMeta.move(oldId, nextId);
    }
    return this.get(newId) ?? chat;
  }

  // Every picture id the old chat folder addressed: the image files in it (the
  // files/ set) and the rows that describe a picture under it — collected the
  // same way EntityIdService does it for a character folder.
  private picturePairs(fromDir: string, toDir: string): Array<[string, string]> {
    const fromPrefix = `${PathHelper.imageIdOf(fromDir)}/`;
    const toPrefix = `${PathHelper.imageIdOf(toDir)}/`;
    const pairs = new Map<string, string>();
    const add = (oldId: string): void => {
      if (oldId.startsWith(fromPrefix)) pairs.set(oldId, toPrefix + oldId.slice(fromPrefix.length));
    };
    for (const file of ChatsService.pictureFiles(fromDir)) add(PathHelper.imageIdOf(file));
    for (const row of this.imageMeta.list()) add(row.id);
    return [...pairs];
  }

  // The picture files of a chat folder, recursively. The same name rule as the
  // media route, so the database file or a leftover chat.json.migrated inside
  // the folder is not treated as a picture.
  private static pictureFiles(dir: string, depth = 0): string[] {
    if (depth > 4) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (PathHelper.isDirEntry(dir, entry)) out.push(...ChatsService.pictureFiles(full, depth + 1));
      else if (HttpHelper.isImage(full)) out.push(full);
    }
    return out;
  }

  // Deletes the chat — its rows and its folder (the files/ go along, and with
  // them the rows of the images table that described those files: a picture
  // that no longer exists must not stay in the catalog of known pictures).
  delete(chatId: string): boolean {
    const db = this.db();
    const exists = db.prepare("SELECT 1 AS one FROM chats WHERE id = ?").get(chatId) !== undefined;
    this.transact(db, () => {
      db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    });
    const dir = PathHelper.chatDir(chatId, this.chatsRoot());
    this.imageMeta.removeUnder(`${PathHelper.imageIdOf(dir)}/`);
    fs.rmSync(dir, { recursive: true, force: true });
    return exists;
  }

  // Duplicates a chat: a new id, a copy of every message and a copy of the
  // chat's files/ folder with its picture rows. The participants, the persona,
  // the model, the sampling overrides and the system-prompt addition are copied;
  // the name gets a " (copy)" suffix (a nameless copy is titled by its own
  // creation date, exactly like the original).
  //
  // A picture is addressed by its path inside its own chat's folder, so the
  // copy must not point at the original's files: the folder is copied first and
  // every id of the copy — in the cards and in their reference lists — is
  // repointed at the copy's folder, and each copied picture gets a row of the
  // images table of its own. From then on the two chats are independent:
  // deleting either one leaves the other intact.
  clone(chatId: string): Chat | null {
    const source = this.get(chatId);
    if (!source) return null;
    const copy: Chat = {
      id: this.newChatId(),
      ...(source.name ? { name: `${source.name} (copy)` } : {}),
      createdAt: Date.now(),
      characterIds: [...source.characterIds],
      userId: source.userId,
      ...(source.sampling ? { sampling: { ...source.sampling } } : {}),
      ...(source.systemSuffix ? { systemSuffix: source.systemSuffix } : {}),
      ...(source.stylePrompt ? { stylePrompt: source.stylePrompt } : {}),
      messages: [],
    };
    const sourceDir = PathHelper.chatDir(source.id, this.chatsRoot());
    const copyDir = PathHelper.chatDir(copy.id, this.chatsRoot());
    if (fs.existsSync(sourceDir)) fs.cpSync(sourceDir, copyDir, { recursive: true });
    // The two folders as id prefixes ("chats/<id>/") — an id is a path
    // relative to the data root, so the prefix is computed, not guessed (the
    // chats folder may live outside the data root).
    const from = `${PathHelper.imageIdOf(sourceDir)}/`;
    const to = `${PathHelper.imageIdOf(copyDir)}/`;
    const repoint = (id: string): string => (id.startsWith(from) ? to + id.slice(from.length) : id);
    // The pictures of the copy and the ids their rows in the images table must
    // be taken from (the source's ids) — collected while the cards are mapped,
    // because the repointing is what pairs them.
    const rows: Array<{ from: string; to: string }> = [];
    copy.messages = source.messages.map((m) => {
      const message: ChatMessage = { ...m, id: PathHelper.newId(), images: m.images.map(repoint) };
      if (m.generation?.refs?.length) {
        message.generation = { ...m.generation, refs: m.generation.refs.map(repoint) };
      }
      m.images.forEach((id, i) => rows.push({ from: id, to: message.images[i] }));
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
    // The rows of the images table do not ride along with the copied folder:
    // every picture of the copy gets a row of its own, with its references
    // repointed exactly like the card's ids are. Written before save() — a card
    // reads its data from the table, so the row must be there when the copy is
    // read back.
    for (const pair of rows) {
      const meta = this.imageMeta.get(pair.from);
      if (!meta) continue;
      const refs = ImageMetaService.listField(meta, "refs").map(repoint);
      this.imageMeta.set(pair.to, { ...meta, refs: refs.length > 0 ? refs : undefined });
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

  // Appends an image card — the message that carries one picture. The card
  // itself stores only which picture it is (and its generation status); the
  // description, the prompt and the cast go into the images table, which is
  // where every reader of the card gets them from. The image is referenced by
  // id; the file itself may not exist yet (a background generation reserves its
  // id in advance and the status says so) — a row of the table can exist before
  // the file does.
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
      text: "",
      images: [image],
      imageStatus: opts.status ? { [image]: opts.status } : undefined,
      imageErrors: opts.status && opts.error ? { [image]: opts.error } : undefined,
      timestamp: Date.now(),
    };
    chat.messages.push(message);
    this.insertMessage(chat.id, message);
    this.writeImageMeta(image, opts.description, opts.generation, opts.depicts);
    // The card the caller keeps in its in-memory chat is filled from the table
    // right away, so the answer of this call already carries its caption.
    const meta = this.imageMeta.get(image);
    return meta ? ChatsService.applyMetaToCard(message, meta) : message;
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
  // the description (caption) of an image card. For a card the caption is not
  // in the row at all: the edit goes to the images table (the row keeps being
  // rewritten so its empty caption stays the truth).
  editMessage(chat: Chat, message: ChatMessage, text: string): void {
    if (isImageMessage(message)) {
      this.imageMeta.set(message.images[0], { description: text });
      message.text = text;
      this.db()
        .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
        .run(this.messageData(message), chat.id, message.id);
      return;
    }
    message.text = text;
    this.db()
      .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
      .run(JSON.stringify(message), chat.id, message.id);
  }

  // The caption of one message row, by ids (a background job that finally knows
  // what its picture shows has no message object at hand). For a card this is a
  // write to the images table. Returns false when the row is gone.
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
    if (isImageMessage(msg)) {
      this.imageMeta.set(msg.images[0], { description: text });
      db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(this.messageData(msg), chatId, messageId);
      return true;
    }
    msg.text = text;
    db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(JSON.stringify(msg), chatId, messageId);
    return true;
  }

  // Who a card claims is on its picture (cast refs), written by ids the same way
  // setMessageText writes the caption — into the images table, where the cast of
  // a picture lives. [] is a real edit: the picture claims nobody.
  // Returns false when the row is gone.
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
    if (!isImageMessage(msg)) return false;
    this.imageMeta.set(msg.images[0], { depicts: depicts.length > 0 ? depicts : undefined });
    if (depicts.length > 0) msg.depicts = depicts;
    else delete msg.depicts;
    db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(this.messageData(msg), chatId, messageId);
    return true;
  }

  // Edits what an image card says about its picture. Everything the edit touches
  // is a field of the images table — the caption, the prompt, the references, the
  // cast — so the card the UI renders and the picture the planner reads are the
  // same data, edited in one place. The row is rewritten only so the card's
  // picture id stays put.
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
    const image = message.images[0];
    const metaPatch: ImageMeta = {};
    if (patch.description !== undefined) metaPatch.description = patch.description;
    if (patch.depicts !== undefined) metaPatch.depicts = patch.depicts.length > 0 ? patch.depicts : undefined;
    if (patch.generation === null) {
      // The picture stops claiming it was generated: its generation fields go,
      // or the prompt would come back on the next read.
      for (const key of IMAGE_GENERATION_KEYS) metaPatch[key] = undefined;
    } else {
      if (patch.prompt !== undefined) metaPatch.prompt = patch.prompt;
      if (patch.generation !== undefined) Object.assign(metaPatch, ChatsService.metaOfGeneration(patch.generation));
    }
    if (Object.keys(metaPatch).length > 0) this.imageMeta.set(image, metaPatch);
    const stored = this.imageMeta.get(image);
    if (stored) ChatsService.applyMetaToCard(message, stored);
    this.db()
      .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
      .run(this.messageData(message), chat.id, message.id);
  }

  // Points an image message at another file: the id is swapped in the message
  // (and in its status/error maps), the row of the images table moves along with
  // the picture it describes, and the row is rewritten. Used when a placeholder
  // gets its real, human-readable file name — the message the user already sees
  // becomes the picture, no new row. Returns false when the chat or the message
  // is gone.
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
    db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?").run(this.messageData(msg), chatId, messageId);
    this.imageMeta.move(oldId, newId);
    // The picture of the user's own message may be named before the row of the
    // plan is written; a rename with nothing to move is the normal case here.
    return true;
  }

  // Swaps one picture of a message for another (the user replacing a generated
  // picture with their own file): the new id replaces the old one and the
  // generation data goes with the old picture — what is there now is a user
  // upload, with no prompt behind it. The old file keeps its own row (another
  // picture may still use it as a reference). The new file must already be saved
  // by the caller.
  replaceMessageImage(chat: Chat, message: ChatMessage, oldImage: string, newImage: string): void {
    message.images = message.images.map((x) => (x === oldImage ? newImage : x));
    for (const key of ["imageErrors", "imageStatus"] as const) {
      const map = message[key] as Record<string, unknown> | undefined;
      if (!map) continue;
      delete map[oldImage];
      if (Object.keys(map).length === 0) delete message[key];
    }
    if (isImageMessage(message)) {
      // The new picture is not what the app drew: its generation fields go and
      // the caption of the card becomes the description of the file.
      const cleared: ImageMeta = { description: message.text };
      for (const key of IMAGE_GENERATION_KEYS) cleared[key] = undefined;
      this.imageMeta.set(newImage, cleared);
      delete message.generation;
    }
    this.db()
      .prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?")
      .run(this.messageData(message), chat.id, message.id);
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
  // A chat image lives directly in chats/<chatId>/ and is named by its path
  // relative to the data folder ("chats/<id>/a-sunset-3f2a1c.png"), which
  // is what the message stores, what the API carries and what a row lists
  // as a generation reference.

  // Saves a data URL into the chat folder, returns the image id. `nameHint` is
  // the wanted human-readable base name ("a sunset over the sea"); a unique
  // suffix is appended either way, so two pictures never share a file. `meta`
  // becomes the row of the picture in the images table.
  //
  // A picture the user attached that is byte-for-byte a picture they already
  // have somewhere in the data folders is NOT copied again: its existing id is
  // returned, so one file does not become two cards pointing at two copies. The
  // row of that existing picture is left as it is (its caption is shared).
  saveImage(chatId: string, dataUrl: string, opts: { nameHint?: string; meta?: ImageMeta } = {}): string {
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected a data URL like data:image/...;base64,...");
    const ext = ChatsService.EXT_BY_MIME[match[1]] ?? ".png";
    const buffer = Buffer.from(match[2], "base64");
    const hash = createHash("sha256").update(buffer).digest("hex");
    const existing = this.findExistingByHash(buffer.length, hash);
    if (existing) return existing;
    const filename = `${ChatsService.slugify(opts.nameHint ?? "img", "img")}-${randomUUID().slice(0, 6)}${ext}`;
    const dir = PathHelper.chatDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filename);
    fs.writeFileSync(file, buffer);
    const id = PathHelper.imageIdOf(file);
    // The facts of the file are written here, not left to the next disk sync:
    // they are what makes an outside rename of this picture recognisable and
    // what the de-dup above looks a picture up by, and a row without them would
    // be blind to both until someone opens the picture browser. A caller's own
    // metadata is merged over them.
    this.imageMeta.set(id, { ...(FileFacts.of(file) ?? {}), ...(opts.meta ?? {}) });
    return id;
  }

  // The id of a picture already in the data folders whose row says it has this
  // exact size and content hash, or null. The first hit whose file really is
  // there wins; this is how a disk pick is de-duplicated against what the user
  // already owns.
  private findExistingByHash(size: number, hash: string): string | null {
    for (const id of this.imageMeta.findByHash(size, hash)) {
      const file = PathHelper.resolvePictureId(id);
      if (file && fs.existsSync(file)) return id;
    }
    return null;
  }

  // The id a generated image will be saved under in the chat folder (the file
  // itself appears when the background job finishes — the id is reserved in the
  // message first). `nameHint` is the human-readable English name (2–5 words).
  reservedImageId(chatId: string, nameHint: string, extension = ".png"): string {
    const dir = PathHelper.chatDir(chatId, this.chatsRoot());
    const filename = `${ChatsService.slugify(nameHint, "image")}-${randomUUID().slice(0, 6)}${extension}`;
    return PathHelper.imageIdOf(path.join(dir, filename));
  }

  // Copies a file from anywhere in the data folders into the chat folder,
  // returns its id (null when the source is missing). The row of the source in
  // the images table is copied too, so an imported picture keeps its
  // description.
  importImage(chatId: string, sourcePath: string): string | null {
    if (!fs.existsSync(sourcePath)) return null;
    const dir = PathHelper.chatDir(chatId, this.chatsRoot());
    fs.mkdirSync(dir, { recursive: true });
    const base = ChatsService.slugify(path.basename(sourcePath, path.extname(sourcePath)), "photo");
    const target = path.join(dir, `${base}-${randomUUID().slice(0, 6)}${path.extname(sourcePath)}`);
    fs.copyFileSync(sourcePath, target);
    const id = PathHelper.imageIdOf(target);
    this.imageMeta.copy(PathHelper.imageIdOf(sourcePath), id);
    // The bytes are the source's, the FILE is this copy's: its size, its own
    // modification time and the hash of what was written (the copy carries the
    // source's hash already, but the mtime is new).
    this.imageMeta.set(id, FileFacts.of(target) ?? {});
    return id;
  }

  // Copies a character photo into the chat folder (the 🎨 reference picker),
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

  // ---- the picture data: the one global images table ----

  // Records what is known about a picture: its description, the generation data
  // behind it and the cast visible on it. This is the write half of the single
  // source the cards are read from (applyImageMeta), so a card and its picture
  // are the same data by construction, not by syncing two copies.
  //
  // A field the call does not pass keeps what the row said (`set` merges); a
  // field passed as undefined is removed. An upload with nothing to say thus
  // leaves no row at all, and the files/ folder of a chat stays plain pictures.
  // `depicts` — the cast refs of the people visible on the picture; it belongs
  // to the picture, not to its generation, so an upload carries it too.
  writeImageMeta(
    imageId: string | undefined,
    description: string | undefined,
    generation?: ImageGenerationData,
    depicts?: string[],
  ): void {
    if (!imageId) return;
    if (!PathHelper.resolveImageId(imageId)) return;
    const meta: ImageMeta = {};
    if (description !== undefined) meta.description = description.trim();
    if (depicts !== undefined) meta.depicts = depicts.length > 0 ? depicts : undefined;
    if (generation !== undefined) Object.assign(meta, ChatsService.metaOfGeneration(generation));
    this.imageMeta.set(imageId, meta);
  }

  // The generation block as the fields of a row. An empty prompt is written as
  // itself — clearing the prompt of a card is a real edit (the picture then has
  // nothing to be redrawn from) — while an absent field is passed as undefined,
  // which leaves the stored one alone.
  private static metaOfGeneration(generation: ImageGenerationData): ImageMeta {
    const meta: ImageMeta = {};
    const keep = <K extends keyof ImageGenerationData>(key: K, target: keyof ImageMeta): void => {
      meta[target] = generation[key] === undefined || generation[key] === "" ? undefined : (generation[key] as never);
    };
    keep("prompt", "prompt");
    keep("negativePrompt", "negativePrompt");
    keep("source", "source");
    keep("generator", "generator");
    keep("model", "model");
    meta.refs = generation.refs && generation.refs.length > 0 ? generation.refs : undefined;
    if (generation.width !== undefined) meta.width = generation.width;
    if (generation.height !== undefined) meta.height = generation.height;
    if (generation.steps !== undefined) meta.steps = generation.steps;
    return meta;
  }

  // Fills the image cards of a chat from the images table: the caption, the
  // generation data and the cast of a card ARE its row, so a picture edited in
  // the picture browser or described by another chat reads the same way here.
  //
  // This is the only source, so it is also applied when there is no row: the
  // card then reads as a picture nobody described. A message row that still
  // carries a caption or a prompt of its own (the shape of the old format) says
  // nothing here and is stored without it from the first write on — the old
  // format is not supported, so its copy is not read and not kept.
  private applyImageMeta(chat: Chat): void {
    const cards = chat.messages.filter((m) => isImageMessage(m) && m.images.length > 0);
    if (cards.length === 0) return;
    const rows = this.imageMeta.getMany(cards.map((m) => m.images[0]));
    for (const m of cards) ChatsService.applyMetaToCard(m, rows.get(m.images[0]) ?? {});
  }

  // One card as the table describes it — in place, because the chat object the
  // caller holds is what gets rendered and handed to the model. The row's own
  // timestamps stay out of it: they say when the ROW was written, which is the
  // picture browser's business, not something a chat line should claim about
  // when the picture was made (the message carries its own timestamp).
  private static applyMetaToCard(card: ChatMessage, meta: ImageMeta): ChatMessage {
    card.text = typeof meta.description === "string" ? meta.description : "";
    const generation: ImageGenerationData = {};
    let has = false;
    for (const key of ["prompt", "negativePrompt", "source", "generator", "model"] as const) {
      if (meta[key] !== undefined) {
        Object.assign(generation, { [key]: meta[key] });
        has = true;
      }
    }
    for (const key of ["width", "height", "steps"] as const) {
      if (typeof meta[key] === "number") {
        Object.assign(generation, { [key]: meta[key] });
        has = true;
      }
    }
    const refs = ImageMetaService.listField(meta, "refs");
    if (refs.length > 0) {
      generation.refs = refs;
      has = true;
    }
    if (has) card.generation = generation;
    else delete card.generation;
    const depicts = ImageMetaService.listField(meta, "depicts");
    if (depicts.length > 0) card.depicts = depicts;
    else delete card.depicts;
    return card;
  }

  // Whether a picture is still being generated somewhere: a card of some chat
  // carries the "pending" status for exactly this id. A picture is renamed by
  // moving its file, and a job that is already running writes to the path it was
  // given when it started — under the new name its picture would appear at the
  // old one, so the rename has to wait (the same guard a chat rename applies).
  hasPendingImage(imageId: string): boolean {
    if (!imageId) return false;
    const rows = this.db()
      .prepare("SELECT data FROM messages WHERE data LIKE ?")
      .all(`%"${imageId}"%`) as Array<{ data: string }>;
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.data) as ChatMessage;
        if (msg.imageStatus?.[imageId] === "pending") return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // Points every card of every chat at another picture, and takes the status
  // maps along. Used when a picture file is renamed: an id is a path, so a
  // rename that left the cards pointing at the old name would break them.
  // Returns how many messages were rewritten.
  repointImageId(fromId: string, toId: string): number {
    if (!fromId || !toId || fromId === toId) return 0;
    return this.repointImageIds(new Map([[fromId, toId]]));
  }

  // The same for several pictures at once, applied in ONE pass over each message.
  // A rename that TRADES two ids (a moved file landing on a path whose record
  // described another picture — ImageMetaService.swap) cannot be done as two
  // single repoints: the first one would move the cards into the path the second
  // one is about to take. The map is applied entry by entry, so a swap reads
  // correctly in both directions.
  //
  // Also repoints the reference lists the stored prompts name — a reference is
  // the same kind of fact about another picture, and the callers never need one
  // without the other.
  repointImageIds(pairs: Map<string, string>): number {
    const moves = new Map([...pairs].filter(([fromId, toId]) => fromId && toId && fromId !== toId));
    if (moves.size === 0) return 0;
    const db = this.db();
    // The rows whose data names any of the ids; a message that names two of them
    // is read once (the map makes the rewrite order-free).
    const found = new Map<string, { chatId: string; id: string; data: string }>();
    for (const fromId of moves.keys()) {
      const rows = db
        .prepare("SELECT chat_id AS chatId, id, data FROM messages WHERE data LIKE ?")
        .all(`%"${fromId}"%`) as Array<{ chatId: string; id: string; data: string }>;
      for (const row of rows) found.set(`${row.chatId}\u0000${row.id}`, row);
    }
    const update = db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?");
    let touched = 0;
    for (const row of found.values()) {
      let msg: ChatMessage;
      try {
        msg = JSON.parse(row.data) as ChatMessage;
      } catch {
        continue;
      }
      let dirty = false;
      if (Array.isArray(msg.images)) {
        msg.images = msg.images.map((image) => {
          const moved = moves.get(image);
          if (moved === undefined) return image;
          dirty = true;
          return moved;
        });
      }
      for (const key of ["imageStatus", "imageErrors"] as const) {
        const map = msg[key] as Record<string, unknown> | undefined;
        if (!map) continue;
        let keyed = false;
        const next: Record<string, unknown> = {};
        for (const [image, value] of Object.entries(map)) {
          const moved = moves.get(image) ?? image;
          if (moved !== image) keyed = true;
          next[moved] = value;
        }
        if (!keyed) continue;
        dirty = true;
        (msg as Record<string, unknown>)[key] = next;
      }
      if (!dirty) continue;
      update.run(this.messageData(msg), row.chatId, row.id);
      touched += 1;
    }
    // and the references the stored prompts name
    this.imageMeta.repointRefsMap(moves);
    return touched;
  }

  // Points every chat and every message at a participant whose ID changed —
  // a character folder or a persona folder was renamed, and an ID IS the folder
  // name, so it is written into the chats and not only into the catalog: a
  // character lives in `Chat.characterIds` (the reply order) and in the
  // `characterId` of the lines it already said, a persona in `Chat.userId` (who
  // new messages of this chat go under) and in the `userId` of its lines. The
  // author fields are exactly what the display and the labeled history are
  // resolved through, so a rename that left them behind would turn every old
  // line into "unknown author".
  //
  // Only the fields of the given kind are rewritten: a character and a persona
  // may legally share an id and renaming one of them must not touch the other.
  // Returns how many records (chats + messages) were rewritten.
  repointAuthor(kind: "character" | "person", fromId: string, toId: string): number {
    if (!fromId || !toId || fromId === toId) return 0;
    const db = this.db();
    // The LIKE filter only narrows the scan (an underscore is a wildcard in
    // LIKE); the field comparison below is what decides.
    const like = `%"${fromId}"%`;
    let touched = 0;

    const chatRows = db.prepare("SELECT id, data FROM chats WHERE data LIKE ?").all(like) as Array<{
      id: string;
      data: string;
    }>;
    const updateChat = db.prepare("UPDATE chats SET data = ? WHERE id = ?");
    for (const row of chatRows) {
      let chat: Chat;
      try {
        chat = JSON.parse(row.data) as Chat;
      } catch {
        continue;
      }
      let dirty = false;
      if (kind === "character" && Array.isArray(chat.characterIds) && chat.characterIds.includes(fromId)) {
        chat.characterIds = [...new Set(chat.characterIds.map((x) => (x === fromId ? toId : x)))];
        dirty = true;
      }
      if (kind === "person" && chat.userId === fromId) {
        chat.userId = toId;
        dirty = true;
      }
      if (!dirty) continue;
      updateChat.run(this.chatData(chat), row.id);
      touched += 1;
    }

    const messageRows = db
      .prepare("SELECT chat_id AS chatId, id, data FROM messages WHERE data LIKE ?")
      .all(like) as Array<{ chatId: string; id: string; data: string }>;
    const updateMessage = db.prepare("UPDATE messages SET data = ? WHERE chat_id = ? AND id = ?");
    const castRef = `${kind === "character" ? "char" : "user"}:${fromId}`;
    const castTarget = `${kind === "character" ? "char" : "user"}:${toId}`;
    for (const row of messageRows) {
      let msg: ChatMessage;
      try {
        msg = JSON.parse(row.data) as ChatMessage;
      } catch {
        continue;
      }
      let dirty = false;
      if (kind === "character" && msg.characterId === fromId) {
        msg.characterId = toId;
        dirty = true;
      }
      if (kind === "person" && msg.userId === fromId) {
        msg.userId = toId;
        dirty = true;
      }
      // A row of the old format can still carry the cast of its own accord;
      // the pictures table is the authority, but a stored copy must not keep
      // naming the person by a ref that no longer exists.
      if (Array.isArray(msg.depicts) && msg.depicts.includes(castRef)) {
        msg.depicts = msg.depicts.map((x) => (x === castRef ? castTarget : x));
        dirty = true;
      }
      if (!dirty) continue;
      updateMessage.run(this.messageData(msg), row.chatId, row.id);
      touched += 1;
    }
    return touched;
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
    // The per-chat model picks are retired fields (the models are global
    // settings now): a stored blob that still carries them loses them on the
    // first read, so a hand-edited database cannot keep a shadow of a setting
    // that no longer exists.
    const legacy = chat as Record<string, unknown>;
    if ("modelId" in legacy || "visionModelId" in legacy) {
      delete legacy.modelId;
      delete legacy.visionModelId;
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

  // The file extension for the image MIME types the uploads may carry.
  private static readonly EXT_BY_MIME: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
}
