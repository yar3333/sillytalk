import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { ImageMeta } from "../shared/ImageMeta";
import { PathHelper } from "../shared/PathHelper";
import { createToken } from "../di";

// The DI token of the image metadata service (registered in index.ts).
export const DI_IMAGE_META_SERVICE = createToken<ImageMetaService>("ImageMetaService");

// The columns of the one global table, in the order the statements bind them.
// "id" is the image identifier — the path of the picture relative to the data
// folder — so the row of a picture is found by exactly the string a chat
// message, a reference list and the media route use.
const COLUMNS = [
  "name",
  "description",
  "prompt",
  "negative_prompt",
  "refs",
  "depicts",
  "source",
  "generator",
  "model",
  "width",
  "height",
  "steps",
  "created_at",
  "updated_at",
  "file_size",
  "file_mtime",
  "file_hash",
] as const;

type Column = (typeof COLUMNS)[number];
type Row = { id: string } & Record<Column, string | number | null>;

// Every field of ImageMeta and the column that carries it (the names differ
// only for the timestamps).
const FIELD_TO_COLUMN: Record<string, Column> = {
  name: "name",
  description: "description",
  prompt: "prompt",
  negativePrompt: "negative_prompt",
  refs: "refs",
  depicts: "depicts",
  source: "source",
  generator: "generator",
  model: "model",
  width: "width",
  height: "height",
  steps: "steps",
  createdAt: "created_at",
  updatedAt: "updated_at",
  fileSize: "file_size",
  fileModifiedAt: "file_mtime",
  fileHash: "file_hash",
};

// The image metadata database: the ONE place what is known about a picture is
// stored. Every picture of the data folder can have a row, whatever brought it
// here (a chat card, a character photo, a file the user dropped into a folder),
// and an image card of a chat reads its caption, its prompt and its cast from
// this table rather than from a copy of its own — so the card and the picture
// cannot drift apart.
//
// The database is a separate file of its own (images.db in the data root) with
// one table, because the pictures are not owned by any chat: a character photo
// and a picture of a conversation are described the same way.
//
// The database is opened lazily on first use. There is nothing to migrate into
// it: the "<image>.png.json" sidecar files an older version of the app kept
// next to its pictures are not read and not touched — a picture whose
// description lived there simply has no row until the user writes it again (the
// picture browser is where that happens), and the leftover file is just a file
// the app ignores.
export class ImageMetaService {
  constructor(private readonly dataRoot: () => string) {}

  private dbRef: DatabaseSync | null = null;
  private closed = false;

  // Closes the database for good (tests do it before wiping a temp root — on
  // Windows an open database file blocks deleting its folder). Any later use
  // throws: a late callback (a background job that settled after the close)
  // must not resurrect the file.
  close(): void {
    this.dbRef?.close();
    this.dbRef = null;
    this.closed = true;
  }

  private db(): DatabaseSync {
    if (this.dbRef) return this.dbRef;
    if (this.closed) throw new Error("The images database is closed");
    const file = PathHelper.imagesDatabaseFile(this.dataRoot());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file, { timeout: 5000 });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id              TEXT PRIMARY KEY,
        name            TEXT,
        description     TEXT,
        prompt          TEXT,
        negative_prompt TEXT,
        refs            TEXT,
        depicts         TEXT,
        source          TEXT,
        generator       TEXT,
        model           TEXT,
        width           INTEGER,
        height          INTEGER,
        steps           INTEGER,
        created_at      TEXT,
        updated_at      TEXT,
        file_size       INTEGER,
        file_mtime      INTEGER,
        file_hash       TEXT
      );
    `);
    // A database written before the file facts existed gets the columns added;
    // a database created now already has them, and the check keeps the ALTER
    // from erroring on every start.
    const have = new Set(
      (db.prepare(`PRAGMA table_info(images)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const column of ["file_size", "file_mtime", "file_hash"] as const) {
      if (!have.has(column)) db.exec(`ALTER TABLE images ADD COLUMN ${column}`);
    }
    this.dbRef = db;
    return db;
  }

  // ---- reading ----

  // The metadata of one picture, or null when the table has no row for it
  // (which is the normal state of a picture nobody has described yet).
  get(id: string): ImageMeta | null {
    const row = this.db()
      .prepare(`SELECT id, ${COLUMNS.join(", ")} FROM images WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? ImageMetaService.fromRow(row) : null;
  }

  // The metadata of several pictures in one query — the chat read, which wants
  // the caption and the prompt of every card of the chat at once. A missing id
  // simply has no entry in the result.
  getMany(ids: string[]): Map<string, ImageMeta> {
    const out = new Map<string, ImageMeta>();
    const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id))];
    if (wanted.length === 0) return out;
    const marks = wanted.map(() => "?").join(", ");
    const rows = this.db()
      .prepare(`SELECT id, ${COLUMNS.join(", ")} FROM images WHERE id IN (${marks})`)
      .all(...wanted) as Row[];
    for (const row of rows) out.set(row.id, ImageMetaService.fromRow(row));
    return out;
  }

  // The ids of the rows that remember a file of exactly this size and this
  // content hash. This is what a disk pick is de-duplicated by: a picture the
  // user chose that already lives in one of the data folders is reused rather
  // than copied, so the same file does not get a second id and a second row.
  // A byte-identical copy gives several ids; the caller keeps the first one
  // whose file really is there.
  findByHash(size: number, hash: string): string[] {
    const rows = this.db()
      .prepare("SELECT id FROM images WHERE file_size = ? AND file_hash = ?")
      .all(size, hash) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  // Every row of the table as `{ id, ...meta }` — the picture browser, newest
  // edit first. The rowid breaks a tie: two writes can land in the same
  // millisecond, and a browser whose order changes between two refreshes looks
  // broken, so the tie is settled by which row was written later.
  list(): Array<ImageMeta & { id: string }> {
    const rows = this.db()
      .prepare(`SELECT id, ${COLUMNS.join(", ")} FROM images ORDER BY updated_at DESC, rowid DESC`)
      .all() as Row[];
    return rows.map((row) => ({ id: row.id, ...ImageMetaService.fromRow(row) }));
  }

  // ---- writing ----

  // Merges `patch` into the row of a picture and writes it back. A key given as
  // `undefined` removes that field, so the same call can clear a prompt. The
  // timestamps are maintained here: `createdAt` of the first write, `updatedAt`
  // of every one.
  //
  // A row is only worth having when it says something: a patch that leaves the
  // picture with nothing to say deletes the row instead of storing an empty one.
  set(id: string, patch: ImageMeta): ImageMeta | null {
    if (!id) return null;
    const db = this.db();
    const merged: ImageMeta = { ...(this.get(id) ?? {}), ...patch };
    const now = new Date().toISOString();
    for (const key of Object.keys(merged)) {
      // An empty string means the same thing as no value here — a caption or a
      // prompt the user cleared, not a caption that happens to be empty — and
      // storing it would keep a row that says nothing alive.
      if (merged[key] === undefined || merged[key] === "") delete merged[key];
    }
    const meaningful = Object.keys(merged).some((key) => key !== "createdAt" && key !== "updatedAt");
    if (!meaningful) {
      db.prepare("DELETE FROM images WHERE id = ?").run(id);
      return null;
    }
    merged.updatedAt = now;
    if (!merged.createdAt) merged.createdAt = now;
    const values = COLUMNS.map((column) => ImageMetaService.toColumnValue(merged, column));
    const marks = COLUMNS.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO images (id, ${COLUMNS.join(", ")}) VALUES (?, ${marks})
       ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    ).run(id, ...values);
    return merged;
  }

  // Removes the row of a picture (with the picture itself).
  remove(id: string): void {
    if (!id) return;
    this.db().prepare("DELETE FROM images WHERE id = ?").run(id);
  }

  // Renames a row along with its picture: what is known about a picture belongs
  // to the picture, not to its file name. Missing source row — nothing to move.
  //
  // A target that already HAS a row is refused rather than merged into: the row
  // of one picture (its caption, its cast, the faces on it) must never become
  // part of another picture's row. Every caller moves into a folder or a name it
  // has just proven free; this is the backstop that keeps a hand-edited table or
  // a future caller from silently fusing two pictures.
  move(fromId: string, toId: string): ImageMeta | null {
    const meta = this.get(fromId);
    if (!meta) return null;
    if (fromId !== toId && this.get(toId)) {
      throw new Error(`There is already a record for "${toId}" — a move never merges two pictures`);
    }
    this.remove(fromId);
    return this.set(toId, meta);
  }

  // Copies the row onto another picture (a cloned chat, an imported photo keeps
  // its description). Returns the copy, or null when there was nothing to copy.
  copy(fromId: string, toId: string): ImageMeta | null {
    const meta = this.get(fromId);
    if (!meta) return null;
    return this.set(toId, meta);
  }

  // Removes the rows of every picture under a folder prefix (a deleted chat:
  // its files/ folder goes with it and the rows would only be orphans).
  removeUnder(prefix: string): void {
    if (!prefix) return;
    this.db()
      .prepare("DELETE FROM images WHERE substr(id, 1, ?) = ?")
      .run(prefix.length, prefix);
  }

  // Exchanges the rows of two ids without moving any file. Used when a picture
  // the user moved lands on a path whose record remembers DIFFERENT bytes (its
  // own file is gone): the file keeps its own record — the description of what is
  // actually there — and the stranded record takes the path the file left, where
  // it is an orphan like it was before. Neither description is lost, and neither
  // id claims bytes it does not describe.
  swap(firstId: string, secondId: string): void {
    if (!firstId || !secondId || firstId === secondId) return;
    const first = this.get(firstId);
    const second = this.get(secondId);
    if (!first && !second) return;
    this.remove(firstId);
    this.remove(secondId);
    if (first) this.set(secondId, first);
    if (second) this.set(firstId, second);
  }

  // Points every reference list at a renamed picture, so a prompt that says
  // "the first reference image shows …" keeps naming a picture that exists.
  repointRefs(fromId: string, toId: string): void {
    this.repointList("refs", ImageMetaService.pairMap(fromId, toId));
  }

  // The same for several pictures at once — a rename that trades two ids (see
  // swap) must be applied in ONE pass, or the second repoint would undo the first.
  repointRefsMap(pairs: Map<string, string>): void {
    this.repointList("refs", pairs);
  }

  // Points every picture's cast at a person that got a new ID: a row that says
  // "char:alice stands in this picture" has to say it about the same person
  // after her folder is renamed, or the next plan stops offering the card as
  // her anchor and the generator draws a stranger.
  repointDepicts(fromRef: string, toRef: string): void {
    this.repointList("depicts", ImageMetaService.pairMap(fromRef, toRef));
  }

  // One replacement as the map the list rewrite speaks.
  private static pairMap(fromValue: string, toValue: string): Map<string, string> {
    return !fromValue || !toValue || fromValue === toValue ? new Map() : new Map([[fromValue, toValue]]);
  }

  // Replaces the entries of a list column that the map names, in every row. The
  // scan is over the whole table (the lists are short and the table is one user's
  // pictures), so a row whose own id is not involved still gets fixed. A row is
  // rewritten only when one of its entries really changes.
  private repointList(column: "refs" | "depicts", pairs: Map<string, string>): void {
    if (pairs.size === 0) return;
    const db = this.db();
    const rows = db.prepare(`SELECT id, ${column} AS value FROM images`).all() as Array<{
      id: string;
      value: string | null;
    }>;
    const update = db.prepare(`UPDATE images SET ${column} = ? WHERE id = ?`);
    for (const row of rows) {
      if (!row.value) continue;
      let list: unknown;
      try {
        list = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      let changed = false;
      const next = list.map((entry) => {
        const moved = typeof entry === "string" ? pairs.get(entry) : undefined;
        if (moved === undefined) return entry;
        changed = true;
        return moved;
      });
      if (changed) update.run(JSON.stringify(next), row.id);
    }
  }

  // ---- row <-> meta ----

  private static fromRow(row: Row): ImageMeta {
    const meta: ImageMeta = {};
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      const value = row[column as Column];
      if (value === null || value === undefined) continue;
      if (column === "refs" || column === "depicts") {
        const list = ImageMetaService.parseList(String(value));
        if (list.length > 0) (meta as Record<string, unknown>)[field] = list;
        continue;
      }
      (meta as Record<string, unknown>)[field] = value;
    }
    if (meta.source !== "upload" && meta.source !== "manual" && meta.source !== "auto") delete meta.source;
    return meta;
  }

  // The column value of one field of a meta: a list is stored as JSON, an
  // absent field as NULL.
  private static toColumnValue(meta: ImageMeta, column: Column): string | number | null {
    const field = Object.keys(FIELD_TO_COLUMN).find((key) => FIELD_TO_COLUMN[key] === column);
    const value = field === undefined ? undefined : (meta as Record<string, unknown>)[field];
    if (value === undefined || value === null) return null;
    if (column === "refs" || column === "depicts") {
      return Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null;
    }
    if (typeof value === "number" || typeof value === "string") return value;
    return null;
  }

  private static parseList(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  // The list fields of a meta, exposed for the callers that build a patch out
  // of a stored one (the chat clone repoints the references of a copied row).
  static listField(meta: ImageMeta, key: "refs" | "depicts"): string[] {
    const value = meta[key];
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  }
}
