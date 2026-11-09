import fs from "fs";
import path from "path";
import { CharactersService } from "../characters/CharactersService";
import { ChatsService } from "../chats/ChatsService";
import { ImageMetaService } from "../images/ImageMetaService";
import { PersonsService } from "../persons/PersonsService";
import { HttpHelper } from "../shared/HttpHelper";
import { PathHelper } from "../shared/PathHelper";
import { createToken } from "../di";

// The DI token of the entity-id service (registered in index.ts).
export const DI_ENTITY_ID_SERVICE = createToken<EntityIdService>("EntityIdService");

// What a rename has to follow: the two catalogs are mirror-image domains, so the
// differences between them are collected here instead of being branched on at
// every step.
type EntityTarget = {
  kind: "character" | "person";
  word: string;
  // The prefix a cast ref of this kind carries ("char:alice" / "user:carol").
  cast: "char" | "user";
  dir: (id: string) => string;
  isValid: (id: string) => boolean;
  // Whether the catalog has such an entity — the row of the catalogs table is
  // what a character/persona is; its folder only holds its pictures.
  exists: (id: string) => boolean;
  // The row's primary key and the entity's folder move together — the domain's
  // own service owns both.
  rename: (id: string, newId: string) => boolean;
};

// The ID of a character or a persona is the PRIMARY KEY of its row in the
// catalogs table and the NAME OF ITS FOLDER at once, and through that folder it
// is written all over the data —
//   characters/<id>/            the card's photos/ set, its avatar
//   chats: Chat.characterIds, Chat.userId, the characterId/userId of every line
//   picture ids: characters/<id>/photos/x.jpg, users/<id>/avatar.jpg — the very
//                primary keys of the images table and the ids the cards point at
//   picture rows: their refs (a saved prompt's reference set) and their depicts
//                (the cast refs "char:<id>" / "user:<id>")
// So renaming one is not editing a field: it is a move whose trail every one of
// those has to pick up, or the old lines of a chat lose their author, a card
// loses its file and the next picture of the same woman is drawn with a new
// face.
//
// This service is the piece that walks that trail. It sits above the two catalog
// domains (whose services stay catalog-persistence and know nothing about
// chats), the chat store and the images table — exactly like
// PictureLibraryService sits above the table and the chats for the same reason:
// a rename is nothing one row or one folder can do on its own.
export class EntityIdService {
  constructor(
    private readonly characters: CharactersService,
    private readonly persons: PersonsService,
    private readonly chats: ChatsService,
    private readonly imageMeta: ImageMetaService,
  ) {}

  // Gives a character a new ID. Throws with the reason when the name is not a
  // usable ID, there is no such character, or a character already lives there —
  // a rename never overwrites one.
  renameCharacter(id: string, newId: string): void {
    this.rename(this.characterTarget(), id, newId);
  }

  // Gives a persona a new ID. Same rules as a character.
  renamePerson(id: string, newId: string): void {
    this.rename(this.personTarget(), id, newId);
  }

  private rename(target: EntityTarget, id: string, newId: string): void {
    if (id === newId) return;
    if (!target.isValid(id)) throw new Error(`"${id}" is not a valid ID`);
    if (!target.isValid(newId)) {
      throw new Error(
        `"${newId}" is not a valid ID — letters, digits, ".", "-" and "_", no leading dot, at most 100 characters`,
      );
    }
    const from = target.dir(id);
    const to = target.dir(newId);
    if (!target.exists(id)) throw new Error(`There is no ${target.word} "${id}"`);
    // Taken by a row or by a folder still standing there — a rename never
    // overwrites an entity, and never lands on files that belong to nobody.
    if (target.exists(newId) || fs.existsSync(to)) {
      throw new Error(`There is already a ${target.word} with the ID "${newId}"`);
    }

    // The picture ids are collected BEFORE the move (after it, the folder has a
    // different name and there is nothing left to enumerate).
    const pairs = this.picturePairs(from, to);
    if (!target.rename(id, newId)) {
      throw new Error(`The ${target.word} "${id}" could not be renamed to "${newId}"`);
    }

    // First the cards and the reference lists (repointImageId does both, and it
    // scans rows by their content, so it also fixes the rows that are still
    // under the old id), then the rows themselves — a row belongs to the
    // picture, so it travels with the file.
    for (const [oldId, nextId] of pairs) {
      this.chats.repointImageId(oldId, nextId);
      this.imageMeta.move(oldId, nextId);
    }
    this.chats.repointAuthor(target.kind, id, newId);
    this.imageMeta.repointDepicts(`${target.cast}:${id}`, `${target.cast}:${newId}`);
  }

  // Every picture id the old folder addressed: the files in it (a starter-set
  // photo, an avatar) and the rows that describe a picture of it — including the
  // row of a file the user already deleted by hand, which follows so it does not
  // stay behind as an orphan naming a path that never existed under the new ID.
  private picturePairs(fromDir: string, toDir: string): Array<[string, string]> {
    const fromPrefix = `${PathHelper.imageIdOf(fromDir)}/`;
    const toPrefix = `${PathHelper.imageIdOf(toDir)}/`;
    const pairs = new Map<string, string>();
    const add = (oldId: string): void => {
      if (oldId.startsWith(fromPrefix)) pairs.set(oldId, toPrefix + oldId.slice(fromPrefix.length));
    };
    for (const file of EntityIdService.pictureFiles(fromDir)) add(PathHelper.imageIdOf(file));
    for (const row of this.imageMeta.list()) add(row.id);
    return [...pairs].map(([oldId, nextId]) => [oldId, nextId]);
  }

  // The picture files of a folder, recursively (photos/ and the avatar live at
  // different depths). The same name rule as the catalog, so a leftover
  // sidecar or a database file inside a folder is not treated as a picture.
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
      if (PathHelper.isDirEntry(dir, entry)) out.push(...EntityIdService.pictureFiles(full, depth + 1));
      else if (HttpHelper.isImage(full)) out.push(full);
    }
    return out;
  }

  private characterTarget(): EntityTarget {
    const service = this.characters;
    return {
      kind: "character",
      word: "character",
      cast: "char",
      dir: (id) => PathHelper.characterDir(id),
      isValid: (id) => service.isValidId(id),
      exists: (id) => service.get(id) !== null,
      rename: (id, newId) => service.rename(id, newId),
    };
  }

  private personTarget(): EntityTarget {
    const service = this.persons;
    return {
      kind: "person",
      word: "persona",
      cast: "user",
      dir: (id) => PathHelper.personDir(id),
      isValid: (id) => service.isValidId(id),
      exists: (id) => service.get(id) !== null,
      rename: (id, newId) => service.rename(id, newId),
    };
  }
}
