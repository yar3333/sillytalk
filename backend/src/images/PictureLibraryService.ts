import fs from "fs";
import path from "path";
import { ChatsService } from "../chats/ChatsService";
import { ImageMeta } from "../shared/ImageMeta";
import { HttpHelper } from "../shared/HttpHelper";
import { PathHelper } from "../shared/PathHelper";
import { createToken } from "../di";
import { ImageMetaService } from "./ImageMetaService";

// The DI token of the picture library (registered in index.ts).
export const DI_PICTURE_LIBRARY_SERVICE = createToken<PictureLibraryService>("PictureLibraryService");

// One row of the picture browser: the file and what the images table says about
// it. `exists` is false for a row whose picture is gone — the user deleted the
// file behind the app's back, and the row is what is left of its description.
export type PictureEntry = ImageMeta & {
  id: string;
  exists: boolean;
  // When the file was last written (ms) — the browser sorts by it, so the
  // picture the user just made sits on top.
  modifiedAt?: number;
  // How many OTHER pictures name this one in the reference set of their prompt
  // (their rows' refs). Computed on every read, never stored — a reference is
  // a fact about another row, and a stored counter would be a second copy of
  // it that could disagree.
  referencedBy?: number;
};

// The picture library: the browser and the editor of every picture of the data
// folder, independent of any chat. It is the top-level service of the images
// domain: the table itself (ImageMetaService) is plain storage and knows nothing
// about chats, while showing a picture to the user and renaming its file are
// things that DO reach the chats — a card points at a path, so renaming the file
// means repointing the cards that show it.
export class PictureLibraryService {
  constructor(
    private readonly meta: ImageMetaService,
    private readonly chats: ChatsService,
  ) {}

  // Every picture the user can be shown: the files of the picture folders with
  // their rows, newest first, and after them the rows whose file is gone — an
  // orphan row is not a picture, but it is information the user should be able
  // to see (and delete) rather than something silently hidden.
  browse(): PictureEntry[] {
    const rows = new Map(this.meta.list().map((row) => [row.id, row]));
    const counts = PictureLibraryService.refCounts(rows.values());
    const entries: PictureEntry[] = [];
    for (const id of PathHelper.listPictureIds()) {
      const row = rows.get(id);
      if (row) rows.delete(id);
      entries.push({
        ...(row ?? {}),
        id,
        exists: true,
        modifiedAt: PictureLibraryService.mtimeOf(id),
        referencedBy: counts.get(id) ?? 0,
      });
    }
    for (const row of rows.values()) {
      entries.push({ ...row, exists: false, referencedBy: counts.get(row.id) ?? 0 });
    }
    return entries;
  }

  // The row of one picture, as the browser shows it.
  get(id: string): PictureEntry | null {
    const row = this.meta.get(id);
    const exists = PictureLibraryService.fileOf(id) !== null;
    if (!row && !exists) return null;
    let referencedBy = 0;
    for (const other of this.meta.list()) {
      if (other.id === id) continue;
      if (ImageMetaService.listField(other, "refs").includes(id)) referencedBy += 1;
    }
    return { ...(row ?? {}), id, exists, modifiedAt: PictureLibraryService.mtimeOf(id), referencedBy };
  }

  // How many rows name each picture in their refs. One pass over the table for
  // the whole browse — the per-picture alternative was one scan per row. A row
  // naming itself (a hand-edited table) does not count itself as a user.
  private static refCounts(rows: Iterable<ImageMeta & { id: string }>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const ref of ImageMetaService.listField(row, "refs")) {
        if (ref === row.id) continue;
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
    }
    return counts;
  }

  // Edits what the images table says about a picture: its description, its
  // prompt and references, its cast. A field the patch does not carry keeps the
  // stored value; an empty one removes it (so clearing a prompt is a real edit —
  // the card then has nothing to be redrawn from).
  //
  // Nothing here is chat-specific: a caption written for a character's photo is
  // the caption the chat card of that photo shows, because both read the row.
  edit(
    id: string,
    patch: {
      description?: string;
      prompt?: string;
      refs?: string[];
      depicts?: string[];
    },
  ): PictureEntry | null {
    const file = PictureLibraryService.fileOf(id);
    const stored = this.meta.get(id);
    if (!file && !stored) return null;
    const meta: ImageMeta = {};
    if (patch.description !== undefined) meta.description = patch.description.trim();
    if (patch.prompt !== undefined) meta.prompt = patch.prompt.trim();
    if (patch.refs !== undefined) meta.refs = patch.refs.length > 0 ? patch.refs : undefined;
    if (patch.depicts !== undefined) meta.depicts = patch.depicts.length > 0 ? patch.depicts : undefined;
    this.meta.set(id, meta);
    return this.get(id);
  }

  // Renames a picture, which — an id being a path — means moving the file:
  // the file, its row, the cards of every chat that show it and the reference
  // lists of the prompts that name it all follow the new name. Returns the entry
  // under the new id, or null when there is nothing to rename.
  //
  // Throws with the reason when the new id is not a usable picture path, the
  // source file is gone, or a picture already lives at the target — a rename
  // must never overwrite a picture.
  rename(id: string, newId: string): PictureEntry | null {
    const from = PictureLibraryService.fileOf(id);
    if (!from) throw new Error(`Unknown picture "${id}"`);
    if (newId === id) return this.get(id);
    const target = PictureLibraryService.newFileOf(newId);
    if (!target) throw new Error(`"${newId}" is not a picture path of the data folder`);
    if (fs.existsSync(target)) throw new Error(`There is already a file at "${newId}"`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(from, target);
    this.meta.move(id, newId);
    // The cards of the chats carry the old path; the reference lists of the
    // stored prompts name it too.
    this.chats.repointImageId(id, newId);
    return this.get(newId);
  }

  // ---- the path rules ----

  // The file of a picture id that really is a picture of the folders pictures
  // live in, or null (the media-route rule: not the data root itself, so a
  // browser cannot be pointed at config.json).
  private static fileOf(id: string): string | null {
    const file = PathHelper.resolvePictureId(id);
    if (!file || !HttpHelper.isImage(file)) return null;
    return fs.existsSync(file) ? file : null;
  }

  // The file a NEW id would address: the same rules as fileOf, minus the
  // requirement that it already exists.
  private static newFileOf(id: string): string | null {
    const file = PathHelper.resolvePictureId(id);
    if (!file || !HttpHelper.isImage(file)) return null;
    return file;
  }

  private static mtimeOf(id: string): number | undefined {
    const file = PictureLibraryService.fileOf(id);
    if (!file) return undefined;
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  }
}
