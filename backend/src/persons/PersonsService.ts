import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { Person } from "./Person";
import { PathHelper } from "../shared/PathHelper";
import { DataUrl } from "../shared/DataUrl";
import { PictureName } from "../shared/PictureName";
import { ImageMetaService } from "../images/ImageMetaService";
import { createToken } from "../di";

// The DI token of the person service (registered in index.ts).
export const DI_PERSONS_SERVICE = createToken<PersonsService>("PersonsService");

type PersonRow = { id: string; name: string; description: string | null; avatar: string | null };

// The top-level person service: the persona catalog in the `persons` table of
// the catalogs database (catalogs.db in the data root) — the id is the primary
// key and at the same time the name of the persona's folder, where its pictures
// lie directly (no subfolder): the avatar is one of them, named by an image id
// the row keeps in its `avatar` column. The card itself (name and description)
// is the row: there is no user.json any more and its files are not read.
//
// The on-disk folder layout (users/) and the SILLYTALK_USERS_DIR env var are
// historical — the domain concept in the code is person/persons.
//
// The root folder is read through the accessor (not injected as a value), so
// the service always sees the current SILLYTALK_USERS_DIR / data root, and
// tests can point it at a temp dir. The database is opened lazily on first use
// and close() is final — later use throws.
export class PersonsService {
  constructor(
    private readonly personsRoot: () => string,
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
      CREATE TABLE IF NOT EXISTS persons (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        avatar      TEXT
      );
    `);
    // A table written before the avatar column existed gets it added (an empty
    // value simply means "no avatar picked yet"); a fresh table has it already.
    if (!(db.prepare(`PRAGMA table_info(persons)`).all() as Array<{ name: string }>).some((c) => c.name === "avatar")) {
      db.exec("ALTER TABLE persons ADD COLUMN avatar TEXT");
    }
    this.dbRef = db;
    return db;
  }

  // The ID still names the persona's folder (the home of its avatar), so the
  // allowed characters are those of a folder name.
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

  // The person list: every row of the table. Sorted by name.
  list(): Person[] {
    const rows = this.db().prepare("SELECT id, name, description FROM persons").all() as PersonRow[];
    return rows.map((row) => PersonsService.fromRow(row)).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  // The person list with the avatar image id — the avatar is a picture of the
  // persona's folder, addressed by its data-root-relative id; only the card is
  // the row.
  listWithAvatars(): Array<Person & { avatar: string | null }> {
    const rows = this.db()
      .prepare("SELECT id, name, description, avatar FROM persons")
      .all() as PersonRow[];
    return rows
      .map((row) => ({
        ...PersonsService.fromRow(row),
        avatar: typeof row.avatar === "string" && row.avatar ? row.avatar : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  // The image ids of a persona's folder, sorted (an avatar the user dropped in
  // is one of them); empty when the folder does not exist yet.
  pictureIdsOf(id: string): string[] {
    if (!this.isValidId(id)) return [];
    const dir = PathHelper.personDir(id, this.personsRoot());
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

  get(id: string): Person | null {
    if (!this.isValidId(id)) return null;
    const row = this.db()
      .prepare("SELECT id, name, description FROM persons WHERE id = ?")
      .get(id) as PersonRow | undefined;
    return row ? PersonsService.fromRow(row) : null;
  }

  // Writes the persona's row and creates its folder, the home of the avatar.
  save(person: Person): void {
    if (!this.isValidId(person.id)) {
      throw new Error(`Invalid person ID: ${String(person.id)}`);
    }
    this.db()
      .prepare(
        `INSERT INTO persons (id, name, description) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`,
      )
      .run(person.id, person.name ?? "", person.description ?? "");
    fs.mkdirSync(PathHelper.personDir(person.id, this.personsRoot()), { recursive: true });
  }

  // Deletes the persona's row and its folder (the avatar and everything else).
  delete(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const removed = this.db().prepare("DELETE FROM persons WHERE id = ?").run(id).changes > 0;
    const dir = PathHelper.personDir(id, this.personsRoot());
    const hadFolder = fs.existsSync(dir);
    if (hadFolder) fs.rmSync(dir, { recursive: true, force: true });
    return removed || hadFolder;
  }

  // Gives the persona a new ID: the primary key of its row moves, and its
  // folder — the home of its avatar, which is a picture id — moves with it.
  // Nothing else is touched here: what else has to follow the new ID — the
  // chats and messages authored by this persona, the picture ids and the cast
  // of the picture rows — is the caller's business (EntityIdService), because
  // this service owns the catalog and its folders only.
  //
  // Returns false when there is no such persona or the name is taken (by a row
  // or by a folder that is still there); a rename never overwrites one.
  rename(id: string, newId: string): boolean {
    if (!this.isValidId(id) || !this.isValidId(newId) || id === newId) return false;
    if (!this.get(id) || this.get(newId)) return false;
    const root = this.personsRoot();
    const from = PathHelper.personDir(id, root);
    const to = PathHelper.personDir(newId, root);
    if (fs.existsSync(to)) return false;
    this.db().prepare("UPDATE persons SET id = ? WHERE id = ?").run(newId, id);
    if (fs.existsSync(from)) fs.renameSync(from, to);
    return true;
  }

  // Copies the persona — the row and the folder with it (the avatar); the copy
  // is named "<name> (copy)". Returns the new id, null when the source does
  // not exist.
  clone(id: string): string | null {
    if (!this.isValidId(id)) return null;
    const source = this.get(id);
    if (!source) return null;
    const root = this.personsRoot();
    const newId = this.nextCloneId(id, root);
    const from = PathHelper.personDir(id, root);
    if (fs.existsSync(from)) fs.cpSync(from, PathHelper.personDir(newId, root), { recursive: true });
    this.save({
      id: newId,
      name: `${source.name} (copy)`,
      description: source.description,
    });
    return newId;
  }

  // ---- avatar (an image id the row keeps in its `avatar` column) ----
  //
  // The avatar is one of the persona's pictures, named by its data-root-relative
  // id (previewed through the media route). Setting it copies a picked file into
  // the folder unless the file is already a picture of the data folder (then the
  // existing id is reused), or points the column at an existing picture id.
  // Clearing it drops the designation only, never the file.

  // The id of the persona's avatar, or null when none is picked.
  getAvatarId(id: string): string | null {
    if (!this.isValidId(id)) return null;
    const row = this.db().prepare("SELECT avatar FROM persons WHERE id = ?").get(id) as
      | { avatar: string | null }
      | undefined;
    return row && typeof row.avatar === "string" && row.avatar ? row.avatar : null;
  }

  // Picks the avatar from a picture the user chose: an existing picture id
  // (`imageId`, reused) or the bytes of a disk file (`dataUrl`, de-duplicated
  // against the data folders, else copied into the persona's folder). Returns
  // the avatar image id now stored. Throws on a bad id or an unreadable pick.
  setAvatarImage(id: string, source: { dataUrl?: string; imageId?: string }): string {
    if (!this.isValidId(id)) throw new Error(`Invalid person ID: ${String(id)}`);
    if (!this.get(id)) throw new Error(`No such persona: ${id}`);
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
    this.db().prepare("UPDATE persons SET avatar = ? WHERE id = ?").run(avatarId, id);
    return avatarId;
  }

  // Drops the avatar designation; the file stays a normal folder picture.
  clearAvatar(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const changed = this.db()
      .prepare("UPDATE persons SET avatar = NULL WHERE id = ? AND avatar IS NOT NULL")
      .run(id).changes;
    return changed > 0;
  }

  // Follows a renamed picture in the avatar column (a folder rename moves the
  // file the avatar points at; a picked avatar that names a picture elsewhere is
  // left alone — its path did not change).
  repointAvatar(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    this.db().prepare("UPDATE persons SET avatar = ? WHERE avatar = ?").run(toId, fromId);
  }

  // ---- the persona's own pictures ----

  // Stores a picture the user brought into the conversation (a 📎 attachment) in
  // the persona's folder and returns its id. The bytes belong to the person who
  // shared them, not to one chat's folder, so the same photo attached twice —
  // here or in another chat — stays ONE picture with ONE row. A byte-identical
  // picture that already lives anywhere in the data folders gives its id back
  // instead of being written again. Throws on a bad persona id or a payload that
  // is not an image data URL.
  storePicture(id: string, dataUrl: string, nameHint = "photo"): string {
    if (!this.isValidId(id)) throw new Error(`Invalid persona ID: ${String(id)}`);
    return this.writePicture(id, DataUrl.image(dataUrl), nameHint);
  }

  // The id a NEW picture of this persona will be saved under — the file does not
  // exist yet, so this is how a picture that still has to be DRAWN gets its name
  // in advance: a 🎨 request attached to the user's line reserves its place here,
  // because the bytes will belong to the person who asked for the picture, and
  // the id in the message is what says so. The folder is created (a picture with
  // no folder to live in is a card that can never become a picture); the file is
  // not. Throws on a bad id.
  reservedPictureId(id: string, nameHint: string, extension = ".png"): string {
    if (!this.isValidId(id)) throw new Error(`Invalid persona ID: ${String(id)}`);
    const dir = PathHelper.personDir(id, this.personsRoot());
    fs.mkdirSync(dir, { recursive: true });
    return PathHelper.imageIdOf(path.join(dir, PictureName.fileName(nameHint, "image", extension)));
  }

  // Places the bytes of a picked file: a byte-identical picture already in the
  // data folders gives its id back; otherwise a new file lands in the persona's
  // folder with a row carrying its facts. The lookup is by CONTENT, not by a row
  // of the table alone — a picture the user just dropped into a folder (or one
  // whose row predates the file facts) is still the same picture
  // (ImageMetaService.findPictureByContent).
  private storePickedPicture(
    id: string,
    picked: { buffer: Buffer; ext: string; hash: string },
  ): string {
    return this.writePicture(id, picked, "avatar");
  }

  // The one write of a picture into the persona's folder (see storePicture and
  // storePickedPicture above): the file is named from `nameHint` so a picture
  // the user attached reads by what it shows, while an avatar is recognisable as
  // one in a file listing.
  private writePicture(
    id: string,
    picked: { buffer: Buffer; ext: string; hash: string },
    nameHint: string,
  ): string {
    const duplicate = this.imageMeta?.findPictureByContent(picked.buffer.length, picked.hash);
    if (duplicate) return duplicate;
    const dir = PathHelper.personDir(id, this.personsRoot());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, PictureName.fileName(nameHint, "photo", picked.ext));
    fs.writeFileSync(file, picked.buffer);
    const newId = PathHelper.imageIdOf(file);
    this.imageMeta?.set(newId, {
      fileSize: picked.buffer.length,
      fileModifiedAt: Math.floor(fs.statSync(file).mtimeMs),
      fileHash: picked.hash,
    });
    return newId;
  }

  private static fromRow(row: PersonRow): Person {
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
