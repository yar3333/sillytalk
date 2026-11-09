import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { Person } from "./Person";
import { PathHelper } from "../shared/PathHelper";
import { AvatarFile } from "../shared/AvatarFile";
import { createToken } from "../di";

// The DI token of the person service (registered in index.ts).
export const DI_PERSONS_SERVICE = createToken<PersonsService>("PersonsService");

type PersonRow = { id: string; name: string; description: string | null };

// The top-level person service: the persona catalog in the `persons` table of
// the catalogs database (catalogs.db in the data root) — the id is the primary
// key and at the same time the name of the persona's folder, where its avatar
// lives (avatar.<ext>). The card itself (name and description) is the row:
// there is no user.json any more and its files are not read.
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
        description TEXT NOT NULL DEFAULT ''
      );
    `);
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

  // The person list with the avatar flag — the avatar stays a file of the
  // persona's folder, only the card is the row.
  listWithAvatars(): Array<Person & { hasAvatar: boolean }> {
    const root = this.personsRoot();
    return this.list().map((person) => ({
      ...person,
      hasAvatar: AvatarFile.find(PathHelper.personDir(person.id, root)) !== null,
    }));
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

  // Brings the set of persons in line with the given list:
  // creates new ones, updates existing ones, deletes the extras.
  sync(persons: Person[]): void {
    const keep = new Set<string>();
    for (const person of persons) {
      this.save(person);
      keep.add(person.id);
    }
    for (const existing of this.list()) {
      if (!keep.has(existing.id)) this.delete(existing.id);
    }
    // A folder the list does not name is removed with it, as before the move
    // into the database: a leftover folder is no persona's pictures.
    const root = this.personsRoot();
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!PathHelper.isDirEntry(root, entry)) continue;
      if (!keep.has(entry.name)) {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  // ---- avatar (avatar.<ext> in the person folder) ----

  // The avatar file (the first existing avatar.<ext>), null when absent.
  findAvatar(id: string): string | null {
    if (!this.isValidId(id)) return null;
    return AvatarFile.find(PathHelper.personDir(id, this.personsRoot()));
  }

  // Saves the avatar from an image data URL (replacing any older one).
  // Throws when the payload is not an image data URL.
  saveAvatar(id: string, dataUrl: string): void {
    if (!this.isValidId(id)) {
      throw new Error(`Invalid person ID: ${String(id)}`);
    }
    AvatarFile.save(PathHelper.personDir(id, this.personsRoot()), dataUrl);
  }

  // Deletes the avatar file; returns whether anything was deleted.
  deleteAvatar(id: string): boolean {
    if (!this.isValidId(id)) return false;
    return AvatarFile.delete(PathHelper.personDir(id, this.personsRoot()));
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
