import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { ImageMetaService } from "./ImageMetaService";
import { PathHelper } from "../shared/PathHelper";

// The one global images table: keyed by the image id (the path of the picture
// relative to the data folder), merging on write, and holding nothing when a
// write leaves it with nothing to say. These tests drive the service directly —
// what a chat card reads is the same row, which the chats suite covers.

let root: string;
let meta: ImageMetaService;

// A picture of the data folder. The table does not require the file to exist (a
// generation reserves its id first), but the tests write one so the paths are
// real.
function picture(relative: string): string {
  const file = path.join(root, relative.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "img");
  return PathHelper.imageIdOf(file);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-images-"));
  process.env.SILLYTALK_DATA_DIR = root;
  meta = new ImageMetaService(() => root);
});

afterEach(() => {
  meta.close();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.SILLYTALK_DATA_DIR;
});

describe("reading and writing a row", () => {
  it("knows nothing about a picture nobody described", () => {
    expect(meta.get("chats/c/files/a-boat-1a2b3c.png")).toBeNull();
    expect(meta.getMany(["chats/c/files/a-boat-1a2b3c.png"]).size).toBe(0);
    expect(meta.list()).toEqual([]);
  });

  it("writes the description, the prompt and the references under the id", () => {
    const id = picture("chats/c1/files/a-red-boat-1a2b3c.png");
    meta.set(id, {
      description: "a red boat on a calm lake",
      prompt: "a red boat at dusk",
      refs: ["characters/alice/photos/photo1.jpg"],
      depicts: ["char:alice"],
      source: "manual",
    });
    expect(meta.get(id)).toMatchObject({
      description: "a red boat on a calm lake",
      prompt: "a red boat at dusk",
      refs: ["characters/alice/photos/photo1.jpg"],
      depicts: ["char:alice"],
      source: "manual",
    });
    // the id IS the relative path, so any reader that has the path has the row
    expect(meta.getMany([id]).get(id)?.prompt).toBe("a red boat at dusk");
  });

  it("merges a write into what the row already said", () => {
    const id = picture("chats/c1/files/a-fox-1a2b3c.png");
    meta.set(id, { description: "a fox in the snow", prompt: "a fox at dawn" });
    meta.set(id, { prompt: "a fox at dawn, retouched" });
    expect(meta.get(id)).toMatchObject({ description: "a fox in the snow", prompt: "a fox at dawn, retouched" });
  });

  it("a field given as undefined is removed and an empty one is no value at all", () => {
    const id = picture("chats/c1/files/a-fox-1a2b3c.png");
    meta.set(id, { description: "as saved", prompt: "as drawn", negativePrompt: "blurry" });
    meta.set(id, { prompt: undefined, negativePrompt: "" });
    const row = meta.get(id)!;
    expect(row.description).toBe("as saved");
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("negativePrompt");
  });

  it("keeps the creation date and stamps every change", () => {
    const id = picture("chats/c1/files/a-fox-1a2b3c.png");
    const first = meta.set(id, { description: "one" })!;
    expect(first.createdAt).toEqual(expect.any(String));
    expect(first.updatedAt).toEqual(expect.any(String));
    const second = meta.set(id, { description: "two" })!;
    expect(second.createdAt).toBe(first.createdAt);
    // an ISO timestamp compares as text; two writes in one millisecond share it
    expect(String(second.updatedAt) >= String(first.updatedAt)).toBe(true);
  });

  it("a row left with nothing to say is deleted instead of stored empty", () => {
    const id = picture("chats/c1/files/a-fox-1a2b3c.png");
    meta.set(id, { description: "only a caption" });
    expect(meta.set(id, { description: undefined })).toBeNull();
    expect(meta.get(id)).toBeNull();
    expect(meta.list()).toEqual([]);
  });

  it("reads several pictures in one call and skips the ones with no row", () => {
    const a = picture("chats/c1/files/a.png");
    const b = picture("chats/c1/files/b.png");
    meta.set(a, { description: "the first" });
    const rows = meta.getMany([a, b, "", "chats/c1/files/gone.png"]);
    expect(rows.size).toBe(1);
    expect(rows.get(a)?.description).toBe("the first");
  });

  it("lists every row, the most recently written one first", () => {
    // Two writes can land in the same millisecond, so the order cannot rest on
    // the timestamp alone — the rowid breaks the tie by which row came later.
    const older = picture("chats/c1/files/a.png");
    const newer = picture("chats/c2/files/b.png");
    meta.set(older, { description: "older" });
    meta.set(newer, { description: "newer" });
    const listed = meta.list();
    expect(listed.map((row) => row.id)).toEqual([newer, older]);
    expect(listed[0].description).toBe("newer");
  });

  it("refuses an empty id rather than storing a row nothing can find", () => {
    expect(meta.set("", { description: "nowhere" })).toBeNull();
    expect(meta.list()).toEqual([]);
  });
});

describe("moving, copying and removing rows", () => {
  it("a rename takes the row with the picture", () => {
    const from = picture("chats/c1/files/placeholder-1a2b3c.png");
    const to = picture("chats/c1/files/a-red-boat-4d5e6f.png");
    meta.set(from, { description: "a red boat at dusk", prompt: "a red boat at dusk" });
    expect(meta.move(from, to)).toMatchObject({ prompt: "a red boat at dusk" });
    expect(meta.get(from)).toBeNull();
    expect(meta.get(to)?.description).toBe("a red boat at dusk");
  });

  it("a rename of a picture with no row is a no-op, not an error", () => {
    const from = "chats/c1/files/none-1a2b3c.png";
    const to = "chats/c1/files/other-1a2b3c.png";
    expect(meta.move(from, to)).toBeNull();
    expect(meta.get(to)).toBeNull();
  });

  // The row of one picture must never become part of another picture's row: a
  // move that lands on an existing record would fuse a caption with a cast that
  // belong to different pictures, and nothing would ever say so.
  it("refuses to move a row onto one that already exists", () => {
    const boat = picture("chats/c1/files/a-boat-1a2b3c.png");
    const portrait = picture("chats/c1/files/alice-4d5e6f.png");
    meta.set(boat, { description: "a red boat at dusk" });
    meta.set(portrait, { description: "alice by the window", depicts: ["char:alice"] });

    expect(() => meta.move(boat, portrait)).toThrow(/already a record/);
    // both records are exactly what they were
    expect(meta.get(boat)?.description).toBe("a red boat at dusk");
    expect(meta.get(portrait)?.description).toBe("alice by the window");
    expect(meta.get(portrait)?.depicts).toEqual(["char:alice"]);
  });

  it("a copy leaves the source row alone", () => {
    const source = picture("characters/alice/photos/photo1.jpg");
    const copy = picture("chats/c1/files/photo1-1a2b3c.jpg");
    meta.set(source, { description: "alice at the window", depicts: ["char:alice"] });
    meta.copy(source, copy);
    expect(meta.get(copy)?.depicts).toEqual(["char:alice"]);
    expect(meta.get(source)?.description).toBe("alice at the window");
    expect(meta.list()).toHaveLength(2);
  });

  it("removes one row and every row under a folder prefix", () => {
    const keep = picture("chats/c2/files/b.png");
    const gone = [picture("chats/c1/files/a.png"), picture("chats/c1/files/deep/c.png")];
    for (const id of [...gone, keep]) meta.set(id, { description: "x" });
    meta.removeUnder("chats/c1/");
    expect(meta.get(gone[0])).toBeNull();
    expect(meta.get(gone[1])).toBeNull();
    expect(meta.get(keep)?.description).toBe("x");
    meta.remove(keep);
    expect(meta.get(keep)).toBeNull();
  });

  it("repoints the reference lists that name a renamed picture", () => {
    const old = picture("chats/c1/files/a-fox-1a2b3c.png");
    const renamed = picture("chats/c1/files/a-fox-at-dawn-9z8y7x.png");
    const card = picture("chats/c1/files/card-1a2b3c.png");
    const other = picture("chats/c1/files/other-1a2b3c.png");
    meta.set(card, { prompt: "the first reference image shows the fox", refs: [old, "chats/c1/files/x.png"] });
    meta.set(other, { refs: ["characters/alice/photos/photo1.jpg"] });
    meta.repointRefs(old, renamed);
    expect(meta.get(card)?.refs).toEqual([renamed, "chats/c1/files/x.png"]);
    // a row that does not name it is untouched
    expect(meta.get(other)?.refs).toEqual(["characters/alice/photos/photo1.jpg"]);
  });
});

// The old format (a "<image>.png.json" file next to every described picture) is
// not supported and not read: a picture with such a file beside it simply has no
// row. What the app promises about those leftovers is only that it neither reads
// them nor rewrites nor deletes them — switching to the table must not quietly
// touch the user's files; clearing them is the user's own decision.
describe("the leftover sidecar files of the old format", () => {
  it("reads nothing from them and leaves them exactly where they are", () => {
    const id = picture("chats/c1/files/a-red-boat-1a2b3c.png");
    const sidecar = path.join(root, "chats/c1/files/a-red-boat-1a2b3c.png.json");
    const body = JSON.stringify({ description: "an old caption", prompt: "an old prompt" });
    fs.writeFileSync(sidecar, body, "utf-8");

    expect(meta.get(id)).toBeNull();
    expect(meta.list()).toEqual([]);
    // untouched: still there, with the same bytes
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe(body);

    // a row written afterwards is the app's own — the file's words are not a
    // source anything falls back to
    meta.set(id, { description: "written in the browser" });
    expect(meta.get(id)?.description).toBe("written in the browser");
    expect(fs.readFileSync(sidecar, "utf-8")).toBe(body);
  });
});

describe("the content lookup a disk pick is de-duplicated by", () => {
  const write = (relative: string, bytes: string): string => {
    const file = path.join(root, relative.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return PathHelper.imageIdOf(file);
  };
  const hashOf = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

  it("finds the row that remembers these bytes when its file is still there", () => {
    const bytes = "the very same picture bytes";
    const id = write("chats/c1/a-red-boat-1a2b3c.png", bytes);
    meta.set(id, { fileSize: bytes.length, fileHash: hashOf(bytes) });
    expect(meta.findPictureByContent(bytes.length, hashOf(bytes))).toBe(id);
  });

  it("ignores a row whose file is gone and matches a file that really holds these bytes", () => {
    const bytes = "the very same picture bytes";
    const lost = write("chats/c1/a-lost-1a2b3c.png", "other bytes entirely");
    meta.set(lost, { fileSize: bytes.length, fileHash: hashOf(bytes) });
    fs.rmSync(path.join(root, "chats/c1/a-lost-1a2b3c.png"));
    const real = write("characters/alice/a-photo-1a2b3c.png", bytes);
    expect(meta.findPictureByContent(bytes.length, hashOf(bytes))).toBe(real);
  });

  it("finds a file the table has never seen — the bytes are the identity", () => {
    // a picture the user dropped into a folder: no row, no facts, no sync yet
    const bytes = "a picture nobody has registered";
    const id = write("users/carol/a-face-1a2b3c.png", bytes);
    expect(meta.list()).toEqual([]);
    expect(meta.findPictureByContent(bytes.length, hashOf(bytes))).toBe(id);
    // and nothing was written to the table by looking
    expect(meta.list()).toEqual([]);
  });

  it("answers null when no picture of the data folders holds these bytes", () => {
    write("chats/c1/a-red-boat-1a2b3c.png", "a red boat");
    expect(meta.findPictureByContent(11, hashOf("not a picture"))).toBeNull();
    // the size matches, the content does not — the file is not a hit
    expect(meta.findPictureByContent(10, hashOf("not a pictur"))).toBeNull();
  });
});

describe("closing", () => {
  it("a service that was closed refuses to reopen the database", () => {
    const id = picture("chats/c1/files/a.png");
    meta.set(id, { description: "before the close" });
    meta.close();
    // a late callback (a background job that settled after the shutdown) must
    // not resurrect the file the close was meant to release
    expect(() => meta.get(id)).toThrow(/closed/);
    expect(() => meta.set(id, { description: "too late" })).toThrow(/closed/);
  });
});
