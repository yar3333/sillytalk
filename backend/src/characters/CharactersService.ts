import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { Character } from "./Character";
import { PathHelper } from "../shared/PathHelper";
import { DataUrl } from "../shared/DataUrl";
import { PictureName } from "../shared/PictureName";
import { ImageMetaService } from "../images/ImageMetaService";
import { createToken } from "../di";

// The DI token of the character service (registered in index.ts).
export const DI_CHARACTERS_SERVICE = createToken<CharactersService>("CharactersService");

type CharacterRow = { id: string; name: string; description: string | null; avatar: string | null };

// The top-level character service: the character catalog in the `characters`
// table of the catalogs database (catalogs.db in the data root) — the id is the
// primary key and at the same time the name of the character's folder, where
// its pictures lie directly (no subfolder): the "starter" set are the image
// files of the folder, and the avatar is one of them, named by an image id the
// row keeps in its `avatar` column. The card itself (name and description) is
// the row: there is no character.json any more and its files are not read.
//
// The root folder is read through the accessor (not injected as a value), so
// the service always sees the current SILLYTALK_CHARACTERS_DIR / data root, and
// tests can point it at a temp dir. The database is opened lazily on first use
// and close() is final — later use throws.
export class CharactersService {
  constructor(
    private readonly charactersRoot: () => string,
    private readonly databaseFile: () => string,
    // The images table, used only to de-duplicate an avatar picked from disk (a
    // file the user chose that is already a picture of the data folder is
    // referenced, not copied). Optional so the catalog can be used without the
    // table; without it a disk pick is always written as a new file.
    private readonly imageMeta?: ImageMetaService,
  ) {}

  private dbRef: DatabaseSync | null = null;
  private closed = false;

  // Closes the database for good (tests do it before wiping a temp root — on
  // Windows an open database file blocks deleting its folder). Any later use
  // throws: a late callback must not resurrect the file.
  close(): void {
    this.dbRef?.close();
    this.dbRef = null;
    this.closed = true;
  }

  private db(): DatabaseSync {
    if (this.dbRef) return this.dbRef;
    if (this.closed) throw new Error("The catalogs database is closed");
    const file = this.databaseFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file, { timeout: 5000 });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS characters (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        avatar      TEXT
      );
    `);
    // A table written before the avatar column existed gets it added (an empty
    // value simply means "no avatar picked yet"); a fresh table has it already.
    if (!(db.prepare(`PRAGMA table_info(characters)`).all() as Array<{ name: string }>).some((c) => c.name === "avatar")) {
      db.exec("ALTER TABLE characters ADD COLUMN avatar TEXT");
    }
    this.dbRef = db;
    return db;
  }

  // The ID still names the character's folder (the home of its photos and its
  // avatar), so the allowed characters are those of a folder name.
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

  // The character list: every row of the table. Sorted by name.
  list(): Character[] {
    const rows = this.db().prepare("SELECT id, name, description FROM characters").all() as CharacterRow[];
    return rows.map((row) => CharactersService.fromRow(row)).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  // The character list with the starter-set picture ids and the avatar image id
  // — the pictures are files of the character's folder (addressed by their
  // data-root-relative id), only the card is the row.
  listWithPhotos(): Array<Character & { photos: string[]; avatar: string | null }> {
    const rows = this.db()
      .prepare("SELECT id, name, description, avatar FROM characters")
      .all() as CharacterRow[];
    return rows
      .map((row) => ({
        ...CharactersService.fromRow(row),
        photos: this.pictureIdsOf(row.id),
        avatar: typeof row.avatar === "string" && row.avatar ? row.avatar : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  // The image ids of a character's folder (the "starter" set plus any avatar
  // file), sorted; an empty list when the folder does not exist yet. The ids
  // are data-root-relative, exactly as every other picture id.
  pictureIdsOf(id: string): string[] {
    if (!this.isValidId(id)) return [];
    const dir = PathHelper.characterDir(id, this.charactersRoot());
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
        .sort()
        .map((f) => PathHelper.imageIdOf(path.join(dir, f)));
    } catch {
      return [];
    }
  }

  get(id: string): Character | null {
    if (!this.isValidId(id)) return null;
    const row = this.db()
      .prepare("SELECT id, name, description FROM characters WHERE id = ?")
      .get(id) as CharacterRow | undefined;
    return row ? CharactersService.fromRow(row) : null;
  }

  // Writes the character's row and creates its folder, the home of its pictures
  // (the starter set and the avatar lie directly in it).
  save(character: Character): void {
    if (!this.isValidId(character.id)) {
      throw new Error(`Invalid character ID: ${String(character.id)}`);
    }
    this.db()
      .prepare(
        `INSERT INTO characters (id, name, description) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`,
      )
      .run(character.id, character.name ?? "", character.description ?? "");
    fs.mkdirSync(PathHelper.characterDir(character.id, this.charactersRoot()), { recursive: true });
  }

  // Deletes the character's row and its folder (photos and everything else).
  delete(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const removed = this.db().prepare("DELETE FROM characters WHERE id = ?").run(id).changes > 0;
    const dir = PathHelper.characterDir(id, this.charactersRoot());
    const hadFolder = fs.existsSync(dir);
    if (hadFolder) fs.rmSync(dir, { recursive: true, force: true });
    return removed || hadFolder;
  }

  // Gives the character a new ID: the primary key of its row moves, and its
  // folder — the home of its photos and its avatar, which are picture ids —
  // moves with it. Nothing else is touched here: what else has to follow the
  // new ID — the chats that name this character, the picture ids and the cast
  // of the picture rows — is the caller's business (EntityIdService), because
  // this service owns the catalog and its folders only.
  //
  // Returns false when there is no such character or the name is taken (by a
  // row or by a folder that is still there); a rename never overwrites one.
  rename(id: string, newId: string): boolean {
    if (!this.isValidId(id) || !this.isValidId(newId) || id === newId) return false;
    if (!this.get(id) || this.get(newId)) return false;
    const root = this.charactersRoot();
    const from = PathHelper.characterDir(id, root);
    const to = PathHelper.characterDir(newId, root);
    if (fs.existsSync(to)) return false;
    this.db().prepare("UPDATE characters SET id = ? WHERE id = ?").run(newId, id);
    if (fs.existsSync(from)) fs.renameSync(from, to);
    return true;
  }

  // Copies the character — the row and the folder with it (photos/, the
  // avatar); the copy is named "<name> (copy)". Returns the new id, null when
  // the source does not exist.
  clone(id: string): string | null {
    if (!this.isValidId(id)) return null;
    const source = this.get(id);
    if (!source) return null;
    const root = this.charactersRoot();
    const newId = this.nextCloneId(id, root);
    const from = PathHelper.characterDir(id, root);
    if (fs.existsSync(from)) fs.cpSync(from, PathHelper.characterDir(newId, root), { recursive: true });
    this.save({
      id: newId,
      name: `${source.name} (copy)`,
      description: source.description,
    });
    return newId;
  }

  // The id a NEW picture of this character will be saved under — the file does
  // not exist yet, the background generation writes it when it finishes and the
  // card reserves the name in advance (the same trick a chat's reserved id is).
  // It lands in the character's own folder, so a picture the character asked for
  // becomes part of its starter set: the next scene of the same conversation can
  // be drawn from the same face, and the picture browser shows it like any other
  // picture of the folder.
  //
  // The folder is created here, because a picture with no folder to live in is a
  // card that cannot ever become a picture. Throws on a bad id.
  reservedPictureId(id: string, nameHint: string, extension = ".png"): string {
    if (!this.isValidId(id)) throw new Error(`Invalid character ID: ${String(id)}`);
    const dir = PathHelper.characterDir(id, this.charactersRoot());
    fs.mkdirSync(dir, { recursive: true });
    return PathHelper.imageIdOf(path.join(dir, PictureName.fileName(nameHint, "image", extension)));
  }

  // ---- avatar (an image id the row keeps in its `avatar` column) ----
  //
  // The avatar is not a special file any more: it is one of the character's
  // pictures, named by its data-root-relative id, and the preview is served
  // through the usual media route. Setting it copies a picked file into the
  // folder — unless that file is already a picture of the data folder, in which
  // case the existing id is reused (no duplicate); or points the column at an
  // existing picture id directly. Clearing it only drops the designation, never
  // the file (the picture stays a normal folder picture the browser can delete).

  // The id of the character's avatar, or null when none is picked.
  getAvatarId(id: string): string | null {
    if (!this.isValidId(id)) return null;
    const row = this.db().prepare("SELECT avatar FROM characters WHERE id = ?").get(id) as
      | { avatar: string | null }
      | undefined;
    return row && typeof row.avatar === "string" && row.avatar ? row.avatar : null;
  }

  // Picks the avatar from a picture the user chose: either an existing picture
  // id of the data folder (`imageId` — reused as is) or the bytes of a disk file
  // (`dataUrl` — re-used when its content already lives in a data folder, else
  // copied into the character's folder). Returns the avatar image id now stored.
  // Throws on a bad id or an unreadable pick.
  setAvatarImage(id: string, source: { dataUrl?: string; imageId?: string }): string {
    if (!this.isValidId(id)) throw new Error(`Invalid character ID: ${String(id)}`);
    if (!this.get(id)) throw new Error(`No such character: ${id}`);
    let avatarId: string;
    if (typeof source.imageId === "string" && source.imageId) {
      const abs = PathHelper.resolvePictureId(source.imageId);
      if (!abs || !fs.existsSync(abs)) throw new Error(`Unknown picture "${source.imageId}"`);
      avatarId = source.imageId;
    } else if (typeof source.dataUrl === "string" && source.dataUrl) {
      avatarId = this.storePickedPicture(id, DataUrl.image(source.dataUrl));
    } else {
      throw new Error("Expected a picked picture (data or image field)");
    }
    this.db().prepare("UPDATE characters SET avatar = ? WHERE id = ?").run(avatarId, id);
    return avatarId;
  }

  // Drops the avatar designation; the file itself is left as a normal folder
  // picture. Returns whether a designation was there to clear.
  clearAvatar(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const changed = this.db()
      .prepare("UPDATE characters SET avatar = NULL WHERE id = ? AND avatar IS NOT NULL")
      .run(id).changes;
    return changed > 0;
  }

  // Follows a renamed picture in the avatar column (a folder rename moves the
  // file the avatar points at; a picked avatar that names a picture elsewhere is
  // left alone — its path did not change).
  repointAvatar(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    this.db().prepare("UPDATE characters SET avatar = ? WHERE avatar = ?").run(toId, fromId);
  }

  // Places the bytes of a picked file: a byte-identical picture already in the
  // data folders gives its id back (the file is not written again), otherwise a
  // new file lands in the character's folder and gets a row carrying its facts,
  // so the next sync and the next dedup see it. The lookup is by CONTENT, not by
  // a row of the table alone — a picture the user just dropped into a folder (or
  // one whose row predates the file facts) is still the same picture
  // (ImageMetaService.findPictureByContent).
  private storePickedPicture(
    id: string,
    picked: { buffer: Buffer; ext: string; hash: string },
  ): string {
    const duplicate = this.imageMeta?.findPictureByContent(picked.buffer.length, picked.hash);
    if (duplicate) return duplicate;
    const dir = PathHelper.characterDir(id, this.charactersRoot());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `avatar-${randomUUID().slice(0, 6)}${picked.ext}`);
    fs.writeFileSync(file, picked.buffer);
    const newId = PathHelper.imageIdOf(file);
    this.imageMeta?.set(newId, {
      fileSize: picked.buffer.length,
      fileModifiedAt: Math.floor(fs.statSync(file).mtimeMs),
      fileHash: picked.hash,
    });
    return newId;
  }

  // Migration from the old config.json format: character entries become rows;
  // existing characters are not overwritten.
  migrate(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<Character>;
      if (!this.isValidId(candidate.id)) continue;
      if (this.get(candidate.id)) continue;
      this.save({
        id: candidate.id,
        name: typeof candidate.name === "string" ? candidate.name : candidate.id,
        description: typeof candidate.description === "string" ? candidate.description : "",
      });
    }
  }

  private static fromRow(row: CharacterRow): Character {
    return {
      id: row.id,
      name: typeof row.name === "string" ? row.name : row.id,
      description: typeof row.description === "string" ? row.description : "",
    };
  }

  // The next free clone id: <id>-copy, <id>-copy2, … (a timestamp-based one
  // when the base is too long); free means neither a row nor a folder.
  private nextCloneId(base: string, root: string): string {
    const free = (id: string): boolean => !this.get(id) && !fs.existsSync(path.join(root, id));
    if (base.length + 5 > 100) {
      let id = `copy${Date.now()}`;
      while (!free(id)) id = `copy${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      return id;
    }
    let id = `${base}-copy`;
    let n = 2;
    while (!free(id)) id = `${base}-copy${n++}`;
    return id;
  }
}
