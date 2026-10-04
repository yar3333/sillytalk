import fs from "fs";
import path from "path";
import { Character } from "./Character";
import { PathHelper } from "../shared/PathHelper";
import { AvatarFile } from "../shared/AvatarFile";
import { createToken } from "../di";

// The DI token of the character service (registered in index.ts).
export const DI_CHARACTERS_SERVICE = createToken<CharactersService>("CharactersService");

// The top-level character service: the character catalog on top of the
// characters/<id>/ folders — the folder name is the character ID,
// character.json holds name and description, photos/ is the "starter" photo
// set, avatar.<ext> the character avatar. The root folder is read through the
// accessor (not injected as a value), so the service always sees the current
// SILLYTALK_CHARACTERS_DIR / data root, and tests can point it at a temp dir.
export class CharactersService {
  constructor(private readonly charactersRoot: () => string) {}

  // The character ID is a folder name, so the allowed characters are limited.
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

  // The character list: every folder with a character.json. Sorted by name.
  list(): Character[] {
    const root = this.charactersRoot();
    if (!fs.existsSync(root)) return [];
    const result: Character[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!PathHelper.isDirEntry(root, entry)) continue;
      const character = this.readCharacterFile(entry.name, root);
      if (character) result.push(character);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  // The character list with the starter-set photos and the avatar flag.
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
    return this.readCharacterFile(id, this.charactersRoot());
  }

  // The absolute path of a starter-set photo (the file name is reduced to its
  // basename); null when the id is not a valid character id. The existence is
  // up to the caller (ChatsService.importCharacterPhoto answers null for a
  // missing file).
  photoFile(id: string, name: string): string | null {
    if (!this.isValidId(id)) return null;
    return path.join(PathHelper.characterPhotosDir(id, this.charactersRoot()), path.basename(name));
  }

  // Creates the character folder (including photos/) and writes character.json.
  save(character: Character): void {
    const root = this.charactersRoot();
    if (!this.isValidId(character.id)) {
      throw new Error(`Invalid character ID: ${String(character.id)}`);
    }
    fs.mkdirSync(PathHelper.characterPhotosDir(character.id, root), { recursive: true });
    const data = {
      name: character.name ?? "",
      description: character.description ?? "",
    };
    fs.writeFileSync(PathHelper.characterFile(character.id, root), JSON.stringify(data, null, 2), "utf-8");
  }

  // Deletes the character together with its folder (photos and everything else).
  delete(id: string): boolean {
    if (!this.isValidId(id)) return false;
    const dir = PathHelper.characterDir(id, this.charactersRoot());
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // Copies the character folder (character.json, photos/, the avatar) into a
  // new one; the copy is named "<name> (copy)". Returns the new id, null when
  // the source does not exist.
  clone(id: string): string | null {
    const root = this.charactersRoot();
    if (!this.isValidId(id)) return null;
    const source = this.readCharacterFile(id, root);
    if (!source) return null;
    const newId = this.nextCloneId(id, root);
    fs.cpSync(PathHelper.characterDir(id, root), PathHelper.characterDir(newId, root), { recursive: true });
    this.save({ id: newId, name: `${source.name} (copy)`, description: source.description });
    return newId;
  }

  // Brings the set of characters in line with the given list:
  // creates new ones, updates existing ones, deletes the extras.
  sync(characters: Character[]): void {
    const root = this.charactersRoot();
    const keep = new Set<string>();
    for (const character of characters) {
      this.save(character);
      keep.add(character.id);
    }
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

  // Migration from the old config.json format: character entries are moved
  // into folders; existing character.json files are not overwritten.
  migrate(entries: unknown): void {
    const root = this.charactersRoot();
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<Character>;
      if (!this.isValidId(candidate.id)) continue;
      if (fs.existsSync(PathHelper.characterFile(candidate.id, root))) continue;
      this.save({
        id: candidate.id,
        name: typeof candidate.name === "string" ? candidate.name : candidate.id,
        description: typeof candidate.description === "string" ? candidate.description : "",
      });
    }
  }

  // Reads character.json of one folder (null when missing or broken).
  private readCharacterFile(id: string, root: string): Character | null {
    const file = PathHelper.characterFile(id, root);
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Character>;
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
