import fs from "fs";
import os from "os";
import path from "path";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Config } from "../configuration/Config";
import { Model } from "../configuration/Model";
import { ChatsService } from "../chats/ChatsService";
import { ImageMetaService } from "./ImageMetaService";
import { PictureLibraryService } from "./PictureLibraryService";
import { PathHelper } from "../shared/PathHelper";

// The picture browser: every picture of the data folder with the row of the
// images table that describes it, and the two edits the browser offers — the
// description/prompt of a picture and its NAME. A name is an id is a path, so
// renaming is a file move that the chat cards and the stored reference lists
// have to follow; that is what most of these tests are about.

// A distinct PNG payload per call. saveImage de-duplicates by content, so two
// pictures that are meant to be different in a test must be different bytes —
// one constant reused everywhere would collapse to one file.
let pngSeq = 0;
function PNG(): string {
  return "data:image/png;base64," + Buffer.from("picture-" + ++pngSeq).toString("base64");
}

let root: string;
let meta: ImageMetaService;
let chats: ChatsService;
let library: PictureLibraryService;
const open: { close(): void }[] = [];

function track<T extends { close(): void }>(service: T): T {
  open.push(service);
  return service;
}

function model(name: string): Model {
  return {
    name,
    id: `${name}-id`,
    baseUrl: "http://provider.test/v1",
    contextSize: 8192,
    supportsImages: false,
    reasoning: false,
    reasoningLevels: [],
  };
}

class StubConfigurationService extends ConfigurationService {
  loadConfig(): Config {
    return {
      listen: "127.0.0.1:3210",
      llmModels: { m1: model("m1") },
      imageGenerators: [],
    };
  }
}

// The file of a picture id, for the assertions about what is on disk.
function fileOf(id: string): string {
  return path.join(root, id.split("/").join(path.sep));
}

// The same folder, a new file name — an id is a path, so a rename keeps the
// picture where it lives and changes only its name.
function renamedIn(id: string, name: string): string {
  return `${id.slice(0, id.lastIndexOf("/") + 1)}${name}`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-library-"));
  process.env.SILLYTALK_DATA_DIR = root;
  meta = track(new ImageMetaService(() => root));
  chats = track(new ChatsService(() => PathHelper.chatsDir(), new StubConfigurationService(), meta));
  library = new PictureLibraryService(meta, chats);
});

afterEach(() => {
  for (const service of open) service.close();
  open.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.SILLYTALK_DATA_DIR;
});

describe("browsing the pictures", () => {
  it("shows every picture of the data folders with the row that describes it", () => {
    const chat = chats.create(["a"], "m1", "me");
    const inChat = chats.saveImage(chat.id, PNG(), { nameHint: "a red boat" });
    meta.set(inChat, { description: "a red boat on a calm lake", prompt: "a red boat at dusk" });
    const portrait = path.join(PathHelper.personsDir(), "carol/avatar.jpg");
    fs.mkdirSync(path.dirname(portrait), { recursive: true });
    fs.writeFileSync(portrait, "img");
    const avatar = PathHelper.imageIdOf(portrait);
    meta.set(avatar, { description: "a woman at a window" });

    const seen = library.browse();
    expect(seen.map((p) => p.id).sort()).toEqual([avatar, inChat].sort());
    const card = seen.find((p) => p.id === inChat)!;
    expect(card).toMatchObject({
      description: "a red boat on a calm lake",
      prompt: "a red boat at dusk",
      exists: true,
    });
    expect(card.modifiedAt).toEqual(expect.any(Number));
    // a picture nobody described is still a picture
    expect(seen.find((p) => p.id === avatar)!.description).toBe("a woman at a window");
  });

  it("lists a picture with no row at all, and a row whose file is gone after them", () => {
    const chat = chats.create(["a"], "m1", "me");
    const plain = chats.saveImage(chat.id, PNG(), { nameHint: "an undescribed picture" });
    meta.set("chats/gonechat/files/deleted-1a2b3c.png", { description: "a picture that is not there" });

    const seen = library.browse();
    expect(seen.find((p) => p.id === plain)).toMatchObject({ exists: true });
    expect(seen.find((p) => p.id === plain)!.description).toBeUndefined();
    const orphan = seen.find((p) => p.id.startsWith("chats/gonechat"))!;
    expect(orphan.exists).toBe(false);
    expect(orphan.description).toBe("a picture that is not there");
    // the orphan sits at the end: it is not a picture, it is what is left of one
    expect(seen[seen.length - 1].id).toBe(orphan.id);
  });

  it("never lists a file that is not a picture, and never reaches the data root", () => {
    const chat = chats.create(["a"], "m1", "me");
    const picture = chats.saveImage(chat.id, PNG(), { nameHint: "a boat" });
    // the JSON that sits beside the pictures, and the secret that sits beside
    // the folders: the browser walks pictures only, by name and by folder
    fs.writeFileSync(path.join(PathHelper.chatsDir(), chat.id, "a-note.txt"), "not a picture");
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ apiKey: "secret" }));

    const seen = library.browse();
    expect(seen.map((p) => p.id)).toEqual([picture]);
    expect(library.get("config.json")).toBeNull();
    expect(library.get(`${chat.id}/a-note.txt`)).toBeNull();
    // the chats database itself is inside a picture folder and must stay unseen
    expect(seen.some((p) => p.id.endsWith("chats.db"))).toBe(false);
  });

  it("reads one picture, and nothing for a picture that is neither file nor row", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a boat" });
    meta.set(id, { description: "a boat" });
    expect(library.get(id)).toMatchObject({ id, description: "a boat", exists: true });
    expect(library.get("chats/c1/files/nowhere-1a2b3c.png")).toBeNull();
  });

  it("counts the pictures that name a picture in their reference set (browse and get, computed on read)", () => {
    const chat = chats.create(["a"], "m1", "me");
    const anchor = chats.saveImage(chat.id, PNG(), { nameHint: "the anchor face" });
    const first = chats.saveImage(chat.id, PNG(), { nameHint: "first scene" });
    const second = chats.saveImage(chat.id, PNG(), { nameHint: "second scene" });
    const lonely = chats.saveImage(chat.id, PNG(), { nameHint: "nothing refers to me" });
    meta.set(first, { refs: [anchor] });
    meta.set(second, { refs: [anchor, lonely] });

    const seen = library.browse();
    expect(seen.find((p) => p.id === anchor)!.referencedBy).toBe(2);
    // lonely is named by second; the scene rows themselves are named by nobody
    expect(seen.find((p) => p.id === lonely)!.referencedBy).toBe(1);
    expect(seen.find((p) => p.id === first)!.referencedBy).toBe(0);
    expect(seen.find((p) => p.id === second)!.referencedBy).toBe(0);
    expect(library.get(anchor)!.referencedBy).toBe(2);

    // dynamic: dropping the reference from a saved prompt lowers the count on
    // the next read — the count is not stored anywhere
    library.edit(first, { refs: [] });
    expect(library.get(anchor)!.referencedBy).toBe(1);
    expect(library.browse().find((p) => p.id === anchor)!.referencedBy).toBe(1);
  });
});

describe("the disk sync (the table follows the files)", () => {
  // The pictures are files and the user may touch them outside the app: drop
  // one into a folder, rename one in Explorer. The sync at startup and on
  // every browser open must keep the table honest — a file without a row gets
  // one, a renamed file takes its row (and its cards) to the new path.

  function dropPicture(id: string, content: string): string {
    const file = fileOf(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return id;
  }

  it("gives a file the user dropped into a folder a row with the facts of its file", () => {
    const id = dropPicture("characters/alice/photos/dropped.png", "the bytes the user put there");

    library.sync();

    const row = meta.get(id);
    expect(row).not.toBeNull();
    expect(row!.fileSize).toBe(Buffer.byteLength("the bytes the user put there"));
    expect(row!.fileModifiedAt).toEqual(expect.any(Number));
    expect(row!.fileHash).toMatch(/^[0-9a-f]{64}$/);
    // and the browser shows it: the dropped picture is a picture of the library
    expect(library.browse().find((p) => p.id === id)).toMatchObject({ exists: true });

    // syncing again changes nothing — the row still vouches for the same file,
    // so the file is not read a second time
    const before = meta.get(id)!;
    library.sync();
    expect(meta.get(id)!.fileHash).toBe(before.fileHash);
    expect(meta.get(id)!.updatedAt).toBe(before.updatedAt);
  });

  it("refreshes the facts when the file's content changed under the row", () => {
    const id = dropPicture("characters/alice/photos/growing.png", "one size");
    library.sync();
    const firstHash = meta.get(id)!.fileHash;

    fs.writeFileSync(fileOf(id), "a different, longer content");
    library.sync();

    expect(meta.get(id)!.fileHash).not.toBe(firstHash);
    expect(meta.get(id)!.fileSize).toBe(Buffer.byteLength("a different, longer content"));
  });

  it("follows a picture renamed outside the app: the row, the cards and the refs", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a red boat" });
    chats.addImageMessage(chats.get(chat.id)!, id, { description: "a red boat at dusk" });
    const drawn = chats.saveImage(chat.id, PNG(), { nameHint: "the two of them" });
    meta.set(drawn, { refs: [id] });
    library.sync(); // learns the facts of the boat the way startup would

    // the user renames the file in Explorer — the app sees only a moved file
    const moved = renamedIn(id, "my-boat-9z8y7x.png");
    fs.renameSync(fileOf(id), fileOf(moved));

    library.sync();

    // the row followed the file: same picture, new path, nothing of it lost
    expect(meta.get(id)).toBeNull();
    expect(meta.get(moved)?.description).toBe("a red boat at dusk");
    // the card in the chat names the new path (the picture the user renamed IS
    // the picture his chat shows — leaving the card on the dead path would
    // break it)
    expect(chats.get(chat.id)!.messages[0].images).toEqual([moved]);
    // and the reference list the stored prompt names follows too
    expect(meta.get(drawn)?.refs).toEqual([moved]);
    // the browser shows the moved picture as the boat it is
    expect(library.browse().find((p) => p.id === moved)).toMatchObject({
      exists: true,
      description: "a red boat at dusk",
    });
  });

  it("follows a file moved to another folder and leaves a truly deleted picture as an orphan", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a boat" });
    meta.set(id, { description: "a boat" });
    library.sync();
    const facts = meta.get(id)!;

    // a moved file in another folder of the picture world is still the same
    // picture — the extension, size and content are the identity, not the folder
    const moved = "characters/alice/photos/the-boat.png";
    fs.mkdirSync(path.dirname(fileOf(moved)), { recursive: true });
    fs.renameSync(fileOf(id), fileOf(moved));
    library.sync();
    expect(meta.get(moved)?.description).toBe("a boat");
    expect(meta.get(id)).toBeNull();

    // now the file is really deleted: no file can match the row, so the row
    // stays an orphan (the user can clear it in the browser) and nothing moves
    fs.rmSync(fileOf(moved));
    library.sync();
    expect(meta.get(moved)?.description).toBe("a boat");
    expect(meta.get(moved)?.fileHash).toBe(facts.fileHash);
  });

  it("does not guess at a row with no stored facts, and identical copies do not steal each other", () => {
    // an old row with no hash: the file is gone, but there is nothing to match
    // it BY — it stays an orphan, it is not married to some new file
    meta.set("chats/oldchat/files/gone-1a2b3c.png", { description: "a picture of the old days" });
    const stranger = dropPicture("characters/alice/photos/stranger.png", "bytes nobody owns");
    library.sync();
    expect(meta.get(stranger)!.description).toBeUndefined();
    expect(meta.get("chats/oldchat/files/gone-1a2b3c.png")?.description).toBe("a picture of the old days");

    // two byte-identical unowned copies and an orphan row that recognizes
    // BOTH: the row takes one of them and the other stays a picture of its
    // own — one file cannot be the same picture twice
    const original = dropPicture("characters/carol/photos/original.png", "the very same bytes");
    meta.set(original, { description: "the one picture" });
    library.sync(); // the original learns its facts the way startup would
    fs.rmSync(fileOf(original));
    const copyA = dropPicture("characters/bob/photos/copy-a.png", "the very same bytes");
    const copyB = dropPicture("characters/alice/photos/copy-b.png", "the very same bytes");
    library.sync(); // the row of the lost original must take one of the twins

    const carried = meta.list().filter((r) => r.description === "the one picture");
    expect(carried).toHaveLength(1);
    expect([copyA, copyB]).toContain(carried[0].id);
    // the other copy is a picture of its own: a row of facts, no borrowed caption
    const other = carried[0].id === copyA ? copyB : copyA;
    expect(meta.get(other)?.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.get(other)?.description).toBeUndefined();
  });

  it("browse syncs on its own: opening the browser is the reconciliation", () => {
    const id = dropPicture("users/carol/hand-dropped.jpg", "a file the user put here");
    expect(meta.get(id)).toBeNull();
    // no sync() call — browse does it
    expect(library.browse().find((p) => p.id === id)!.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("editing a picture from the browser", () => {
  it("writes the description and the prompt that a chat card then shows", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a red boat" });
    chats.addImageMessage(chats.get(chat.id)!, id, { description: "as drawn", generation: { prompt: "a boat", source: "manual" } });

    const edited = library.edit(id, { description: "corrected by hand", prompt: "a red boat at dusk with gulls" });
    expect(edited).toMatchObject({ description: "corrected by hand", prompt: "a red boat at dusk with gulls" });
    // the ONE source: the chat card is the row, so it reads the new words at once
    const card = chats.get(chat.id)!.messages[0];
    expect(card.text).toBe("corrected by hand");
    expect(card.generation?.prompt).toBe("a red boat at dusk with gulls");
    // and the untouched fields of the row survive the patch
    expect(card.generation?.source).toBe("manual");
  });

  it("edits a picture that belongs to no chat — a character's photo, or a file the user dropped in", () => {
    const portrait = path.join(PathHelper.charactersDir(), "alice/photos/photo1.jpg");
    fs.mkdirSync(path.dirname(portrait), { recursive: true });
    fs.writeFileSync(portrait, "img");
    const id = PathHelper.imageIdOf(portrait);

    library.edit(id, { description: "alice in a green coat", depicts: ["char:alice"] });
    expect(meta.get(id)).toMatchObject({ description: "alice in a green coat", depicts: ["char:alice"] });
    // a picture is never owned by one chat: the row is what the picture planner
    // reads when it offers her a face to draw
    expect(library.get(id)?.depicts).toEqual(["char:alice"]);
  });

  it("sets the reference list a stored prompt names, and clears it with an empty one", () => {
    const chat = chats.create(["a"], "m1", "me");
    const anchor = chats.saveImage(chat.id, PNG(), { nameHint: "alice" });
    const card = chats.saveImage(chat.id, PNG(), { nameHint: "the two of them" });
    library.edit(card, { prompt: "the first reference image shows the woman in the green coat", refs: [anchor] });
    expect(meta.get(card)?.refs).toEqual([anchor]);
    library.edit(card, { refs: [] });
    expect(meta.get(card)?.refs).toBeUndefined();
  });

  it("says there is nothing to edit for a picture that does not exist", () => {
    expect(library.edit("chats/c1/files/nowhere-1a2b3c.png", { description: "x" })).toBeNull();
  });
});

describe("renaming a picture", () => {
  it("moves the file, the row and the card that shows it", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "img-1a2b3c" });
    chats.addImageMessage(chats.get(chat.id)!, id, { description: "a red boat at dusk" });

    const newId = renamedIn(id, "a-red-boat-9z8y7x.png");
    const renamed = library.rename(id, newId);
    expect(renamed).toMatchObject({ id: newId, description: "a red boat at dusk", exists: true });

    // the file itself moved; nothing was left under the old name
    expect(fs.existsSync(fileOf(newId))).toBe(true);
    expect(fs.existsSync(fileOf(id))).toBe(false);
    // the row moved with it
    expect(meta.get(id)).toBeNull();
    expect(meta.get(newId)?.description).toBe("a red boat at dusk");
    // and the card in the chat points at the new path
    expect(chats.get(chat.id)!.messages[0].images).toEqual([newId]);
  });

  it("repoints the reference lists of the prompts that name it", () => {
    const chat = chats.create(["a"], "m1", "me");
    const anchor = chats.saveImage(chat.id, PNG(), { nameHint: "alice" });
    const drawn = chats.saveImage(chat.id, PNG(), { nameHint: "the-two-of-them" });
    meta.set(drawn, { prompt: "the first reference image shows the woman", refs: [anchor] });

    const newAnchor = renamedIn(anchor, "alice-in-a-green-coat-1a2b3c.png");
    library.rename(anchor, newAnchor);

    expect(meta.get(drawn)?.refs).toEqual([newAnchor]);
    // the prompt text itself is the user's (or the model's) wording — renaming a
    // file cannot rewrite a sentence, so it is left exactly as it was
    expect(meta.get(drawn)?.prompt).toBe("the first reference image shows the woman");
  });

  it("leaves the other chat's copy of a picture alone", () => {
    const first = chats.create(["a"], "m1", "me");
    const second = chats.create(["b"], "m1", "me");
    const inFirst = chats.saveImage(first.id, PNG(), { nameHint: "a boat" });
    const inSecond = chats.saveImage(second.id, PNG(), { nameHint: "a boat" });
    meta.set(inFirst, { description: "the first chat's" });
    meta.set(inSecond, { description: "the second chat's" });

    library.rename(inFirst, renamedIn(inFirst, "renamed-1a2b3c.png"));
    expect(fs.existsSync(fileOf(inSecond))).toBe(true);
    expect(meta.get(inSecond)?.description).toBe("the second chat's");
    expect(chats.get(second.id)!.messages).toEqual([]);
  });

  it("refuses a name that another picture already has, and changes nothing", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a boat" });
    const taken = chats.saveImage(chat.id, PNG(), { nameHint: "already-there" });
    chats.addImageMessage(chats.get(chat.id)!, id, { description: "a boat" });

    expect(() => library.rename(id, taken)).toThrow(/already a file/);
    // the refused rename left the picture exactly where it was
    expect(fs.existsSync(fileOf(id))).toBe(true);
    expect(chats.get(chat.id)!.messages[0].images).toEqual([id]);
  });

  it("refuses a name outside the picture folders, a data-root file and a non-picture", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a boat" });
    for (const bad of [
      "../elsewhere.png",
      "config.json",
      "comfyui/qwen-image-2.1.json",
      renamedIn(id, "a-boat.txt"),
      `${chat.id}/files/a-boat.png`,
    ]) {
      expect(() => library.rename(id, bad)).toThrow(/not a picture path/);
    }
    expect(fs.existsSync(fileOf(id))).toBe(true);
  });

  it("says so for a picture that is not there", () => {
    expect(() => library.rename("chats/c1/files/nowhere-1a2b3c.png", "chats/c1/files/x.png")).toThrow(/Unknown picture/);
  });

  it("renaming to the same name is not an error and keeps the row", () => {
    const chat = chats.create(["a"], "m1", "me");
    const id = chats.saveImage(chat.id, PNG(), { nameHint: "a boat" });
    meta.set(id, { description: "a boat" });
    expect(library.rename(id, id)).toMatchObject({ id, description: "a boat" });
  });
});
