import fs from "fs";
import path from "path";
import { Person } from "./Person";
import { PathHelper } from "../configuration/PathHelper";
import { AvatarFile } from "../shared/AvatarFile";
import { createToken } from "../di";

// The DI token of the person service (registered in index.ts).
export const DI_PERSONS_SERVICE = createToken<PersonsService>("PersonsService");

// The top-level person service: the persona catalog on top of the
// users/<id>/ folders — the folder name is the person ID, user.json holds
// name and description, avatar.<ext> the persona avatar. The root folder is
// read through the accessor (not injected as a value), so the service always
// sees the current SILLYTALK_USERS_DIR / data root, and tests can point it at
// a temp dir.
export class PersonsService {
  constructor(private readonly personsRoot: () => string) {}

  // The person ID is a folder name, so the allowed characters are limited.
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

  // The person list: every folder with a user.json. Sorted by name.
  list(): Person[] {
    const root = this.personsRoot();
    if (!fs.existsSync(root)) return [];
    const result: Person[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!PathHelper.isDirEntry(root, entry)) continue;
      const person = this.readPersonFile(entry.name, root);
      if (person) result.push(person);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  // The person list with the avatar flag.
  listWithAvatars(): Array<Person & { hasAvatar: boolean }> {
    const root = this.personsRoot();
    return this.list().map((person) => ({
      ...person,
      hasAvatar: AvatarFile.find(PathHelper.personDir(person.id, root)) !== null,
    }));
  }

  get(id: string): Person | null {
    if (!this.isValidId(id)) return null;
    return this.readPersonFile(id, this.personsRoot());
  }

  // Creates the person folder and writes user.json.
  save(person: Person): void {
    const root = this.personsRoot();
    if (!this.isValidId(person.id)) {
      throw new Error(`Invalid person ID: ${String(person.id)}`);
    }
    fs.mkdirSync(PathHelper.personDir(person.id, root), { recursive: true });
    const data = {
      name: person.name ?? "",
      description: person.description ?? "",
    };
    fs.writeFileSync(PathHelper.personFile(person.id, root), JSON.stringify(data, null, 2), "utf-8");
  }

  // Deletes the person together with the folder (avatar and everything else).
  delete(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const dir = PathHelper.personDir(id, this.personsRoot());
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // Copies the person folder (user.json, the avatar) into a new one; the copy
  // is named "<name> (copy)". Returns the new id, null when the source does
  // not exist.
  clone(id: string): string | null {
    const root = this.personsRoot();
    if (!this.isValidId(id)) return null;
    const source = this.readPersonFile(id, root);
    if (!source) return null;
    const newId = this.nextCloneId(id, root);
    fs.cpSync(PathHelper.personDir(id, root), PathHelper.personDir(newId, root), { recursive: true });
    this.save({ id: newId, name: `${source.name} (copy)`, description: source.description });
    return newId;
  }

  // Brings the set of persons in line with the given list:
  // creates new ones, updates existing ones, deletes the extras.
  sync(persons: Person[]): void {
    const root = this.personsRoot();
    const keep = new Set<string>();
    for (const person of persons) {
      this.save(person);
      keep.add(person.id);
    }
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

  // Reads user.json of one folder (null when missing or broken).
  private readPersonFile(id: string, root: string): Person | null {
    const file = PathHelper.personFile(id, root);
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Person>;
      return {
        id,
        name: typeof data.name === "string" ? data.name : id,
        description: typeof data.description === "string" ? data.description : "",
      };
    } catch {
      return null;
    }
  }

  // The next free clone folder: <id>-copy, <id>-copy2, … (a timestamp-based
  // name when the base is too long for a folder).
  private nextCloneId(base: string, root: string): string {
    if (base.length + 5 > 100) {
      let id = `copy${Date.now()}`;
      while (fs.existsSync(path.join(root, id))) {
        id = `copy${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      }
      return id;
    }
    let id = `${base}-copy`;
    let n = 2;
    while (fs.existsSync(path.join(root, id))) id = `${base}-copy${n++}`;
    return id;
  }
}
