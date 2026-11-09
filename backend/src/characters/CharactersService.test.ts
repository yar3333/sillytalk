import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { CharactersService } from "./CharactersService";
import { ImageMetaService } from "../images/ImageMetaService";

let root: string;
let dir: string; // the characters folder (the home of the picture folders)
let characters: CharactersService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-chars-"));
  // The picture ids are paths relative to the DATA folder, so the data root has
  // to be the temp folder (otherwise an id of a test would escape it).
  process.env.SILLYTALK_DATA_DIR = root;
  dir = path.join(root, "characters");
  characters = new CharactersService(() => dir, () => path.join(root, "catalogs.db"));
});

afterEach(() => {
  characters.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isValidId", () => {
  it("accepts ordinary folder names", () => {
    expect(characters.isValidId("assistant")).toBe(true);
    expect(characters.isValidId("alisa")).toBe(true);
    expect(characters.isValidId("c1712345678901")).toBe(true);
    // unicode letters are allowed: the id names the folder of the pictures
    expect(characters.isValidId("а-лиса_1.2")).toBe(true);
  });

  it("rejects empty and dangerous values", () => {
    expect(characters.isValidId("")).toBe(false);
    expect(characters.isValidId("a/b")).toBe(false);
    expect(characters.isValidId("a\\b")).toBe(false);
    expect(characters.isValidId("..")).toBe(false);
    expect(characters.isValidId(".hidden")).toBe(false);
    expect(characters.isValidId("a b")).toBe(false);
    expect(characters.isValidId(42)).toBe(false);
    expect(characters.isValidId(undefined)).toBe(false);
  });
});

describe("save / get / list", () => {
  it("saves the character into a row and reads it back", () => {
    characters.save({ id: "alisa", name: "Alice", description: "a kind fairy" });
    expect(characters.get("alisa")).toEqual({
      id: "alisa",
      name: "Alice",
      description: "a kind fairy",
    });
    expect(characters.list().map((c) => c.id)).toEqual(["alisa"]);
  });

  it("sorts the list by name", () => {
    characters.save({ id: "b", name: "Bob", description: "" });
    characters.save({ id: "a", name: "Anna", description: "" });
    expect(characters.list().map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("overwrites the row on a second save", () => {
    characters.save({ id: "alisa", name: "Alice", description: "first" });
    characters.save({ id: "alisa", name: "Alice", description: "second" });
    expect(characters.list()).toEqual([{ id: "alisa", name: "Alice", description: "second" }]);
  });

  it("creates the character's folder", () => {
    characters.save({ id: "a", name: "A", description: "" });
    expect(fs.existsSync(path.join(dir, "a"))).toBe(true);
  });

  it("the table is the catalog: folders are not read, old character.json files are ignored", () => {
    // a leftover folder of the old format — with a card file in it — is no
    // character: nothing reads those files any more
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    fs.mkdirSync(path.join(dir, "stale"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "stale", "character.json"),
      JSON.stringify({ name: "Stale", description: "not a character" }),
      "utf-8",
    );
    characters.save({ id: "ok", name: "OK", description: "" });
    expect(characters.list().map((c) => c.id)).toEqual(["ok"]);
    expect(characters.get("stale")).toBeNull();
  });
});

describe("pictureIdsOf", () => {
  it("lists the character's folder images as ids, sorted", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    fs.writeFileSync(path.join(dir, "alice", "p2.png"), "x");
    fs.writeFileSync(path.join(dir, "alice", "p1.jpg"), "x");
    fs.writeFileSync(path.join(dir, "alice", "notes.txt"), "x"); // not a picture
    expect(characters.pictureIdsOf("alice")).toEqual([
      "characters/alice/p1.jpg",
      "characters/alice/p2.png",
    ]);
  });

  it("is empty for a character without a folder or an invalid id", () => {
    expect(characters.pictureIdsOf("ghost")).toEqual([]);
    expect(characters.pictureIdsOf("a b")).toEqual([]);
  });
});

describe("sync", () => {
  it("creates new ones, updates changed ones, deletes the extras", () => {
    characters.save({ id: "one", name: "One", description: "old" });
    characters.save({ id: "two", name: "Two", description: "" });
    characters.sync([
      { id: "one", name: "One", description: "new" },
      { id: "three", name: "Three", description: "" },
    ]);
    expect(
      characters
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["one", "three"]);
    expect(characters.get("one")?.description).toBe("new");
  });

  it("deletes the character together with the photos", () => {
    characters.save({ id: "one", name: "One", description: "" });
    fs.writeFileSync(path.join(dir, "one", "a.png"), "x");
    characters.sync([]);
    expect(fs.existsSync(path.join(dir, "one"))).toBe(false);
  });

  it("removes a leftover folder no row names", () => {
    fs.mkdirSync(path.join(dir, "stranger"), { recursive: true });
    characters.sync([{ id: "ok", name: "OK", description: "" }]);
    expect(fs.existsSync(path.join(dir, "stranger"))).toBe(false);
    expect(characters.list().map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("rename", () => {
  it("moves the row and the folder with everything in it", () => {
    characters.save({ id: "alice", name: "Alice", description: "a kind fairy" });
    fs.writeFileSync(path.join(dir, "alice", "a.png"), "x");
    fs.writeFileSync(path.join(dir, "alice", "avatar.jpg"), "y");

    expect(characters.rename("alice", "elf")).toBe(true);

    expect(fs.existsSync(path.join(dir, "alice"))).toBe(false);
    expect(characters.get("elf")).toEqual({ id: "elf", name: "Alice", description: "a kind fairy" });
    expect(characters.get("alice")).toBeNull();
    expect(fs.existsSync(path.join(dir, "elf", "a.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "elf", "avatar.jpg"))).toBe(true);
  });

  it("refuses a name that is taken and a character that is not there", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    characters.save({ id: "bob", name: "Bob", description: "" });
    expect(characters.rename("alice", "bob")).toBe(false);
    expect(characters.rename("ghost", "someone")).toBe(false);
    // the refused rename left both exactly where they were
    expect(characters.get("alice")).toMatchObject({ name: "Alice" });
    expect(characters.get("bob")).toMatchObject({ name: "Bob" });
  });

  it("refuses a folder standing at the new name", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    fs.mkdirSync(path.join(dir, "ghost-folder"));
    expect(characters.rename("alice", "ghost-folder")).toBe(false);
    expect(characters.get("alice")).toMatchObject({ name: "Alice" });
    expect(fs.existsSync(path.join(dir, "ghost-folder"))).toBe(true);
  });

  it("refuses an ID that is not a folder name", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    for (const bad of ["", "two words", "../elsewhere", ".hidden", "a/b", "a\\b"]) {
      expect(characters.rename("alice", bad)).toBe(false);
    }
    // the same name is not a rename
    expect(characters.rename("alice", "alice")).toBe(false);
    expect(characters.get("alice")).toMatchObject({ name: "Alice" });
  });
});

describe("migrate", () => {
  it("moves entries from the old config into rows", () => {
    characters.migrate([
      { id: "alisa", name: "Alice", description: "kind" },
      { id: "bad id", name: "X", description: "" },
      "not an object",
      null,
    ]);
    expect(characters.list().map((c) => c.id)).toEqual(["alisa"]);
    expect(characters.get("alisa")?.description).toBe("kind");
  });

  it("does not overwrite an existing character", () => {
    characters.save({ id: "alisa", name: "New", description: "" });
    characters.migrate([{ id: "alisa", name: "Old", description: "" }]);
    expect(characters.get("alisa")?.name).toBe("New");
  });
});

describe("delete", () => {
  it("deletes the row and the character folder", () => {
    characters.save({ id: "a", name: "A", description: "" });
    fs.writeFileSync(path.join(dir, "a", "p.png"), "x");
    expect(characters.delete("a")).toBe(true);
    expect(characters.get("a")).toBeNull();
    expect(fs.existsSync(path.join(dir, "a"))).toBe(false);
    expect(characters.delete("a")).toBe(false);
    expect(characters.delete("a/b")).toBe(false);
  });
});

describe("clone", () => {
  it("copies the row and the folder (photos and avatar go along) with the (copy) name", () => {
    characters.save({ id: "alice", name: "Alice", description: "a friend" });
    fs.writeFileSync(path.join(dir, "alice", "p1.png"), "img");
    fs.writeFileSync(path.join(dir, "alice", "avatar.jpg"), "av");
    const newId = characters.clone("alice");
    expect(newId).toBe("alice-copy");
    expect(characters.get("alice-copy")).toEqual({
      id: "alice-copy",
      name: "Alice (copy)",
      description: "a friend",
    });
    expect(fs.existsSync(path.join(dir, "alice-copy", "p1.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "alice-copy", "avatar.jpg"))).toBe(true);
    // the source is left untouched
    expect(characters.get("alice")?.name).toBe("Alice");
  });

  it("finds a free id when the first candidate is taken", () => {
    characters.save({ id: "a", name: "A", description: "" });
    characters.save({ id: "a-copy", name: "Taken", description: "" });
    expect(characters.clone("a")).toBe("a-copy2");
  });

  it("returns null for a missing or invalid source", () => {
    expect(characters.clone("nope")).toBeNull();
    expect(characters.clone("a b")).toBeNull();
  });
});

describe("avatar (an image id in the row)", () => {
  let meta: ImageMetaService;
  let svc: CharactersService;
  const PNG = "data:image/png;base64,aGVsbG8=";
  const pngBytes = Buffer.from("aGVsbG8=", "base64");

  beforeEach(() => {
    meta = new ImageMetaService(() => root);
    svc = new CharactersService(() => dir, () => path.join(root, "catalogs.db"), meta);
    svc.save({ id: "alice", name: "Alice", description: "" });
  });
  afterEach(() => {
    svc.close();
    meta.close();
  });

  it("picks an avatar from a disk file: it lands in the folder and the row keeps its id", () => {
    const id = svc.setAvatarImage("alice", { dataUrl: PNG });
    expect(id).toMatch(/^characters\/alice\/avatar-[0-9a-f]{6}\.png$/);
    expect(fs.existsSync(path.join(root, id.split("/").join(path.sep)))).toBe(true);
    expect(svc.getAvatarId("alice")).toBe(id);
    // the new file got a row carrying its facts, so a later dedup sees it
    expect(meta.get(id)?.fileHash).toBe(createHash("sha256").update(pngBytes).digest("hex"));
  });

  it("reuses a picture that is already in the data folders instead of writing a copy", () => {
    // a chat picture the user already owns, described by a row with its facts
    const existing = "chats/room/a-boat-1a2b3c.png";
    const abs = path.join(root, "chats", "room", "a-boat-1a2b3c.png");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, pngBytes);
    meta.set(existing, {
      fileSize: pngBytes.length,
      fileModifiedAt: 1,
      fileHash: createHash("sha256").update(pngBytes).digest("hex"),
    });
    const id = svc.setAvatarImage("alice", { dataUrl: PNG });
    expect(id).toBe(existing);
    expect(svc.getAvatarId("alice")).toBe(existing);
    // no avatar file was created in the character folder — the existing one is used
    expect(svc.pictureIdsOf("alice")).toEqual([]);
  });

  it("points the avatar at an existing picture id directly (no copy)", () => {
    const abs = path.join(root, "characters", "alice", "face.png");
    fs.writeFileSync(abs, "img");
    const id = svc.setAvatarImage("alice", { imageId: "characters/alice/face.png" });
    expect(id).toBe("characters/alice/face.png");
    expect(svc.getAvatarId("alice")).toBe("characters/alice/face.png");
  });

  it("clearing drops the designation but keeps the file", () => {
    const id = svc.setAvatarImage("alice", { dataUrl: PNG });
    expect(svc.clearAvatar("alice")).toBe(true);
    expect(svc.getAvatarId("alice")).toBeNull();
    expect(fs.existsSync(path.join(root, id.split("/").join(path.sep)))).toBe(true);
    // clearing an avatar that is not there is a no-op
    expect(svc.clearAvatar("alice")).toBe(false);
  });
});
