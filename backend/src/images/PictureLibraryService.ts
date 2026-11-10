import fs from "fs";
import path from "path";
import { ChatsService } from "../chats/ChatsService";
import { ImageMeta } from "../shared/ImageMeta";
import { FileFacts, PictureFileFacts } from "../shared/FileFacts";
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
  // The OTHER pictures whose bytes are this picture's: the same extension, the
  // same size and the same sha256, at another path. Also computed on every read
  // — two byte-identical files are two pictures (a cloned chat owns its copy, and
  // a name is a path), so the table does not forbid them; the browser says they
  // exist instead, which is what a user needs before he deletes one of them.
  sameAs?: string[];
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
    const diskIds = PathHelper.listPictureIds();
    const all = this.meta.list();
    const rows = new Map(all.map((row) => [row.id, row]));
    const counts = PictureLibraryService.refCounts(rows.values());
    const same = PictureLibraryService.sameContent(all, new Set(diskIds));
    const entries: PictureEntry[] = [];
    for (const id of diskIds) {
      const row = rows.get(id);
      if (row) rows.delete(id);
      entries.push({
        ...(row ?? {}),
        id,
        exists: true,
        modifiedAt: PictureLibraryService.mtimeOf(id),
        referencedBy: counts.get(id) ?? 0,
        ...PictureLibraryService.sameOf(same, id),
      });
    }
    for (const row of rows.values()) {
      entries.push({
        ...row,
        exists: false,
        referencedBy: counts.get(row.id) ?? 0,
        ...PictureLibraryService.sameOf(same, row.id),
      });
    }
    return entries;
  }

  // The row of one picture, as the browser shows it.
  get(id: string): PictureEntry | null {
    const row = this.meta.get(id);
    const exists = PictureLibraryService.fileOf(id) !== null;
    if (!row && !exists) return null;
    let referencedBy = 0;
    const all = this.meta.list();
    for (const other of all) {
      if (other.id === id) continue;
      if (ImageMetaService.listField(other, "refs").includes(id)) referencedBy += 1;
    }
    const onDisk = new Set(all.map((r) => r.id).filter((r) => PictureLibraryService.fileOf(r) !== null));
    const same = PictureLibraryService.sameContent(all, onDisk);
    return {
      ...(row ?? {}),
      id,
      exists,
      modifiedAt: PictureLibraryService.mtimeOf(id),
      referencedBy,
      ...PictureLibraryService.sameOf(same, id),
    };
  }

  // The identical-content groups among the given rows, as `id -> the other ids`.
  // Only pictures whose file is really there are compared (an orphan row's facts
  // describe bytes that are gone, and saying "the same file as that record"
  // about a file nobody can open is noise) and only rows that remember their
  // file's facts can be compared at all.
  private static sameContent(
    rows: Array<ImageMeta & { id: string }>,
    onDisk: Set<string>,
  ): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      if (!onDisk.has(row.id)) continue;
      if (typeof row.fileSize !== "number" || typeof row.fileHash !== "string") continue;
      const key = `${PictureLibraryService.extensionOf(row.id)}|${row.fileSize}|${row.fileHash}`;
      const group = groups.get(key);
      if (group) group.push(row.id);
      else groups.set(key, [row.id]);
    }
    const same = new Map<string, string[]>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const id of group) same.set(id, group.filter((other) => other !== id));
    }
    return same;
  }

  // The `sameAs` field of one entry — absent (not an empty array) for the common
  // picture that is the only copy of its bytes.
  private static sameOf(same: Map<string, string[]>, id: string): { sameAs?: string[] } {
    const twins = same.get(id);
    return twins && twins.length > 0 ? { sameAs: twins } : {};
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

  // Renames a picture, which — an id being a path — means moving what is there:
  //
  // - a picture whose file exists moves its FILE, and its row, the cards of
  //   every chat that show it and the reference lists that name it follow the
  //   new name;
  // - a record whose file is gone (the user deleted it, or renamed it in a way
  //   the disk sync could not recognise — another extension, rewritten bytes, a
  //   row the app never learned a hash for) moves its ROW. That is how a
  //   description is put back onto a file the user has: when a file already
  //   lives at the new id, the record simply attaches to it, and its facts are
  //   re-read from that file.
  //
  // Both never create anything and never destroy anything: the folder of the new
  // id must already exist (a rename that invented `characters/<new-id>/` would
  // make a folder that is not a character — no row names it, nothing reads it,
  // and the picture in it belongs to nobody), the target must not have a file
  // (a rename must never overwrite a picture) and it must not have a record of
  // its own (two pictures never fuse into one).
  //
  // Returns the entry under the new id, or null when there is neither a file nor
  // a record at the old one. Throws with the reason otherwise.
  rename(id: string, newId: string): PictureEntry | null {
    const from = PictureLibraryService.fileOf(id);
    const row = this.meta.get(id);
    if (!from && !row) return null;
    if (newId === id) return this.get(id);
    const target = PictureLibraryService.newFileOf(newId);
    if (!target) throw new Error(`"${newId}" is not a picture path of the data folder`);
    if (from && this.chats.hasPendingImage(id)) {
      throw new Error("This picture is still being generated — wait for it or cancel it first");
    }
    const dir = path.dirname(target);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`The folder of "${newId}" does not exist — a rename does not create folders`);
    }
    if (from && fs.existsSync(target)) throw new Error(`There is already a file at "${newId}"`);
    if (this.meta.get(newId)) {
      throw new Error(`A record already uses "${newId}" — clear it first`);
    }
    if (from) fs.renameSync(from, target);
    this.meta.move(id, newId);
    if (!from) {
      // Attached to a file that is already there: the facts of the old file are
      // no memory of this one, so they are re-read (or dropped when unreadable,
      // and the next sync writes them).
      const facts = fs.existsSync(target) ? FileFacts.of(target) : null;
      if (facts) this.meta.set(newId, facts);
    }
    // The cards of the chats carry the old path; the reference lists of the
    // stored prompts name it too.
    this.chats.repointImageId(id, newId);
    return this.get(newId);
  }

  // Drops the record of a picture whose file is gone — the one delete the
  // browser offers, so an orphan row (what is left of a picture the user removed
  // outside the app) does not have to live forever. A picture whose file is still
  // there is NOT deleted from here: the app does not remove pictures, and losing
  // a caption because the wrong row was clicked is worse than a stray row.
  //
  // Returns whether there was a record to drop.
  forget(id: string): boolean {
    if (!this.meta.get(id)) return false;
    if (PictureLibraryService.fileOf(id)) {
      throw new Error("The file is still there — delete it in its folder, or rename the picture");
    }
    this.meta.remove(id);
    return true;
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
    const facts = new Map<string, PictureFileFacts>();
    for (const id of diskIds) {
      const f = PictureLibraryService.factsOf(id, rows.get(id));
      if (f) facts.set(id, f);
    }

    // 1) a picture renamed or moved outside the app: its row points at a path
    //    with no file, and somewhere on the disk there is a file with the same
    //    size and content. THE ROW FOLLOWS THE FILE — the bytes are the picture,
    //    the path is only where it lives — so the user may sort the files into
    //    folders himself, and a move may change the name and its extension too
    //    (the extension is part of the name, not of the picture).
    //
    //    The file keeps its path only when that path already belongs to a record
    //    that remembers THESE bytes (a copy of the same picture, or the same
    //    picture found twice): then it is not the lost one and nothing moves.
    //
    //    When the path carries a record of DIFFERENT bytes, that record is a
    //    stranded description whose own picture is gone. The two records trade
    //    places (ImageMetaService.swap): the file keeps the description of what
    //    is really in it, and the stranded one becomes an orphan at the path the
    //    file left — neither description is lost. A record without facts cannot
    //    be judged, so it keeps its path.
    const claimed = new Set<string>();
    for (const row of rows.values()) {
      if (onDisk.has(row.id)) continue;
      if (typeof row.fileHash !== "string" || typeof row.fileSize !== "number") continue;
      const twin = diskIds.find((id) => {
        if (claimed.has(id)) return false;
        const file = facts.get(id);
        if (!file || file.fileSize !== row.fileSize || file.fileHash !== row.fileHash) return false;
        const occupant = rows.get(id);
        if (!occupant) return true; // a file no record points at — the ordinary move
        if (typeof occupant.fileHash !== "string" || typeof occupant.fileSize !== "number") return false;
        return occupant.fileSize !== file.fileSize || occupant.fileHash !== file.fileHash;
      });
      if (!twin) continue;
      claimed.add(twin);
      if (rows.has(twin)) {
        this.meta.swap(row.id, twin);
        this.chats.repointImageIds(new Map([[row.id, twin], [twin, row.id]]));
      } else {
        this.meta.move(row.id, twin);
        this.chats.repointImageIds(new Map([[row.id, twin]]));
      }
    }

    // 2) the facts of every file on disk into its row — which is also what
    //    gives a picture the user dropped into a folder a row of its own. The
    //    file a rename just moved gets its facts here too: set re-reads the
    //    row, which by now lives at the new path.
    for (const [id, f] of facts) {
      const row = rows.get(id);
      if (
        row &&
        row.fileSize === f.fileSize &&
        row.fileModifiedAt === f.fileModifiedAt &&
        row.fileHash === f.fileHash
      ) {
        continue;
      }
      this.meta.set(id, f);
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
  ): PictureFileFacts | null {
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
        return { fileSize: stat.size, fileModifiedAt: mtime, fileHash: row.fileHash };
      }
      return FileFacts.of(file);
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
