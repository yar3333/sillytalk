import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { Character } from "./Character";
import { PathHelper } from "../shared/PathHelper";
import { AvatarFile } from "../shared/AvatarFile";
import { createToken } from "../di";

// The DI token of the character service (registered in index.ts).
export const DI_CHARACTERS_SERVICE = createToken<CharactersService>("CharactersService");

type CharacterRow = { id: string; name: string; description: string | null };

// The top-level character service: the character catalog in the `characters`
// table of the catalogs database (catalogs.db in the data root) — the id is the
// primary key and at the same time the name of the character's folder, where
// its pictures live: photos/ is the "starter" photo set, avatar.<ext> the
// character avatar. The card itself (name and description) is the row: there
// is no character.json any more and its files are not read.
//
// The root folder is read through the accessor (not injected as a value), so
// the service always sees the current SILLYTALK_CHARACTERS_DIR / data root, and
// tests can point it at a temp dir. The database is opened lazily on first use
// and close() is final — later use throws.
export class CharactersService {
  constructor(
    private readonly charactersRoot: () => string,
    private readonly databaseFile: () => string,
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
        description TEXT NOT NULL DEFAULT ''
      );
    `);
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

  // The character list with the starter-set photos and the avatar flag — the
  // pictures stay files of the character's folder, only the card is the row.
  listWithPhotos(): Array<Character & { photos: string[]; hasAvatar: boolean }> {
    const root = this.charactersRoot();
    return this.list().map((character) => {
      const dir = PathHelper.characterPhotosDir(character.id, root);
      let photos: string[] = [];
      if (fs.existsSync(dir)) {
        photos = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
      }
      return { ...character, photos, hasAvatar: AvatarFile.find(PathHelper.characterDir(character.id, root)) !== null };
    });
  }

  get(id: string): Character | null {
    if (!this.isValidId(id)) return null;
    const row = this.db()
      .prepare("SELECT id, name, description FROM characters WHERE id = ?")
      .get(id) as CharacterRow | undefined;
    return row ? CharactersService.fromRow(row) : null;
  }

  // The absolute path of a starter-set photo (the file name is reduced to its
  // basename); null when the id is not a valid character id. The existence is
  // up to the caller (ChatsService.importCharacterPhoto answers null for a
  // missing file).
  photoFile(id: string, name: string): string | null {
    if (!this.isValidId(id)) return null;
    return path.join(PathHelper.characterPhotosDir(id, this.charactersRoot()), path.basename(name));
  }

  // Writes the character's row and creates its folder (including photos/), the
  // home of the starter set and the avatar.
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
    fs.mkdirSync(PathHelper.characterPhotosDir(character.id, this.charactersRoot()), { recursive: true });
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

  // Brings the set of characters in line with the given list:
  // creates new ones, updates existing ones, deletes the extras.
  sync(characters: Character[]): void {
    const keep = new Set<string>();
    for (const character of characters) {
      this.save(character);
      keep.add(character.id);
    }
    for (const existing of this.list()) {
      if (!keep.has(existing.id)) this.delete(existing.id);
    }
    // A folder the list does not name is removed with it, as before the move
    // into the database: a leftover folder is no character's pictures.
    const root = this.charactersRoot();
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!PathHelper.isDirEntry(root, entry)) continue;
      if (!keep.has(entry.name)) {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  // ---- avatar (avatar.<ext> in the character folder) ----

  // The avatar file (the first existing avatar.<ext>), null when absent.
  findAvatar(id: string): string | null {
    if (!this.isValidId(id)) return null;
    return AvatarFile.find(PathHelper.characterDir(id, this.charactersRoot()));
  }

  // Saves the avatar from an image data URL (replacing any older one).
  // Throws when the payload is not an image data URL.
  saveAvatar(id: string, dataUrl: string): void {
    if (!this.isValidId(id)) {
      throw new Error(`Invalid character ID: ${String(id)}`);
    }
    AvatarFile.save(PathHelper.characterDir(id, this.charactersRoot()), dataUrl);
  }

  // Deletes the avatar file; returns whether anything was deleted.
  deleteAvatar(id: string): boolean {
    if (!this.isValidId(id)) return false;
    return AvatarFile.delete(PathHelper.characterDir(id, this.charactersRoot()));
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
