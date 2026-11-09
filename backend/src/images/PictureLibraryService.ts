import fs from "fs";
import path from "path";
import { createHash } from "crypto";
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
  //
  // The read first reconciles the table with the disk (sync), so opening the
  // browser is also the moment a file the user dropped into a folder gets its
  // row and a file he renamed by hand gets his cards back.
  browse(): PictureEntry[] {
    this.sync();
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

  // ---- the disk sync ----
  //
  // The pictures are ordinary files and the user may touch them outside the
  // app: drop one into a folder, rename one in Explorer. The table must not
  // drift from the disk, so the library reconciles the two — at server start
  // and every time the browser opens. Two directions:
  //
  // - a file on disk without a row gets one, carrying the facts of its file
  //   (size, modification time, sha256 of the content);
  // - a row whose file is gone is a renamed picture when one of the files
  //   nobody's row points at has the same extension, the same size and the
  //   same hash — a rename outside the app is a move, not a new picture, so
  //   the row FOLLOWS the file: it moves to the new id and the chat cards and
  //   the stored reference lists naming the old path are repointed, exactly as
  //   through the app's own Rename.
  //
  // A row without a stored hash cannot be recognised (the app never saw the
  // file's bytes), and a file whose size and time still match what the row
  // remembers is not hashed again — the content check only runs on files that
  // are new or changed since the last sync.
  sync(): void {
    const rows = new Map(this.meta.list().map((row) => [row.id, row]));
    const diskIds = PathHelper.listPictureIds();
    const onDisk = new Set(diskIds);

    // The facts of every file: taken from the row when it vouches for the file
    // (same size, same time), computed otherwise. One stat + hash per changed
    // file, reused by both the rename search and the write below.
    const facts = new Map<string, { size: number; mtime: number; hash: string }>();
    for (const id of diskIds) {
      const f = PictureLibraryService.factsOf(id, rows.get(id));
      if (f) facts.set(id, f);
    }

    // 1) a picture renamed outside the app: its row points at a path with no
    //    file, and somewhere on the disk there is a file no row points at with
    //    the same extension, size and content. The row follows the file.
    const claimed = new Set<string>();
    for (const row of rows.values()) {
      if (onDisk.has(row.id)) continue;
      if (typeof row.fileHash !== "string" || typeof row.fileSize !== "number") continue;
      const twin = diskIds.find(
        (id) =>
          !rows.has(id) &&
          !claimed.has(id) &&
          PictureLibraryService.extensionOf(id) === PictureLibraryService.extensionOf(row.id) &&
          facts.get(id)?.size === row.fileSize &&
          facts.get(id)?.hash === row.fileHash,
      );
      if (!twin) continue;
      claimed.add(twin);
      this.meta.move(row.id, twin);
      this.chats.repointImageId(row.id, twin);
    }

    // 2) the facts of every file on disk into its row — which is also what
    //    gives a picture the user dropped into a folder a row of its own. The
    //    file a rename just moved gets its facts here too: set re-reads the
    //    row, which by now lives at the new path.
    for (const [id, f] of facts) {
      const row = rows.get(id);
      if (row && row.fileSize === f.size && row.fileModifiedAt === f.mtime && row.fileHash === f.hash) continue;
      this.meta.set(id, { fileSize: f.size, fileModifiedAt: f.mtime, fileHash: f.hash });
    }
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

  // The facts of a file on disk: what the row already knows when the file has
  // not changed since (same size, same modification time — no re-reading of
  // every picture on every sync), the stat and the content hash otherwise.
  // Null when the file cannot be read at all (gone between the listing and
  // this stat, or not readable) — no row is written from a guess.
  private static factsOf(
    id: string,
    row: (ImageMeta & { id: string }) | undefined,
  ): { size: number; mtime: number; hash: string } | null {
    const file = PictureLibraryService.fileOf(id);
    if (!file) return null;
    try {
      const stat = fs.statSync(file);
      const mtime = Math.floor(stat.mtimeMs);
      if (
        row &&
        typeof row.fileHash === "string" &&
        row.fileSize === stat.size &&
        row.fileModifiedAt === mtime
      ) {
        return { size: stat.size, mtime, hash: row.fileHash };
      }
      const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return { size: stat.size, mtime, hash };
    } catch {
      return null;
    }
  }

  // The extension a renamed file keeps (a move does not change the format);
  // compared lower-case, because the app writes lower-case and the user may
  // not. A name without a dot has no extension and matches only another such
  // name — isImage has already made sure a picture has one of the picture
  // extensions, so this never matches empty onto a real extension by accident.
  private static extensionOf(id: string): string {
    const name = id.slice(id.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot).toLowerCase();
  }
}
