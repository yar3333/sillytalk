import fs from "fs";
import os from "os";
import path from "path";
import { PersonsService } from "./PersonsService";
import { ImageMetaService } from "../images/ImageMetaService";
import { PathHelper } from "../shared/PathHelper";

let root: string;
let dir: string; // the users folder (the home of the picture folders)
let persons: PersonsService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-persons-"));
  // The picture ids are paths relative to the DATA folder, so the data root has
  // to be the temp folder (otherwise an id of a test would escape it).
  process.env.SILLYTALK_DATA_DIR = root;
  dir = path.join(root, "users");
  persons = new PersonsService(() => dir, () => path.join(root, "catalogs.db"));
});

afterEach(() => {
  persons.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isValidId", () => {
  it("accepts ordinary folder names", () => {
    expect(persons.isValidId("me")).toBe(true);
    expect(persons.isValidId("u1712345678901")).toBe(true);
    // unicode letters are allowed: the id names the folder of the pictures
    expect(persons.isValidId("а-лиса_1.2")).toBe(true);
  });

  it("rejects empty and dangerous values", () => {
    expect(persons.isValidId("")).toBe(false);
    expect(persons.isValidId("a/b")).toBe(false);
    expect(persons.isValidId("a\\b")).toBe(false);
    expect(persons.isValidId("..")).toBe(false);
    expect(persons.isValidId(".hidden")).toBe(false);
    expect(persons.isValidId("a b")).toBe(false);
    expect(persons.isValidId(42)).toBe(false);
    expect(persons.isValidId(undefined)).toBe(false);
  });
});

describe("save / get / list", () => {
  it("saves the person into a row and reads it back", () => {
    persons.save({ id: "me", name: "You", description: "engineer" });
    expect(persons.get("me")).toEqual({
      id: "me",
      name: "You",
      description: "engineer",
    });
    expect(persons.list().map((p) => p.id)).toEqual(["me"]);
  });

  it("sorts the list by name", () => {
    persons.save({ id: "b", name: "Bob", description: "" });
    persons.save({ id: "a", name: "Anna", description: "" });
    expect(persons.list().map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("overwrites the row on a second save", () => {
    persons.save({ id: "me", name: "You", description: "first" });
    persons.save({ id: "me", name: "You", description: "second" });
    expect(persons.list()).toEqual([{ id: "me", name: "You", description: "second" }]);
  });

  it("the table is the catalog: folders are not read, old user.json files are ignored", () => {
    // a leftover folder of the old format — with a card file in it — is no
    // persona: nothing reads those files any more
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    fs.mkdirSync(path.join(dir, "stale"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "stale", "user.json"),
      JSON.stringify({ name: "Stale", description: "not a persona" }),
      "utf-8",
    );
    persons.save({ id: "ok", name: "OK", description: "" });
    expect(persons.list().map((p) => p.id)).toEqual(["ok"]);
    expect(persons.get("stale")).toBeNull();
  });
});

describe("rename", () => {
  it("moves the row and the folder with the avatar in it", () => {
    persons.save({ id: "me", name: "You", description: "engineer" });
    fs.writeFileSync(path.join(dir, "me", "avatar.jpg"), "av");

    expect(persons.rename("me", "karin")).toBe(true);

    expect(fs.existsSync(path.join(dir, "me"))).toBe(false);
    expect(persons.get("karin")).toEqual({ id: "karin", name: "You", description: "engineer" });
    expect(persons.get("me")).toBeNull();
    // the avatar file travelled with the folder (it is one of the persona's
    // pictures now; the designation is a separate id the row keeps)
    expect(fs.existsSync(path.join(dir, "karin", "avatar.jpg"))).toBe(true);
  });

  it("refuses a name that is taken, a missing source and a name that is not a folder name", () => {
    persons.save({ id: "me", name: "You", description: "" });
    persons.save({ id: "dave", name: "Dave", description: "" });
    expect(persons.rename("me", "dave")).toBe(false);
    expect(persons.rename("ghost", "someone")).toBe(false);
    expect(persons.rename("me", "me")).toBe(false);
    for (const bad of ["", "two words", "../elsewhere", ".hidden"]) {
      expect(persons.rename("me", bad)).toBe(false);
    }
    expect(persons.get("me")).toMatchObject({ name: "You" });
    expect(persons.get("dave")).toMatchObject({ name: "Dave" });
  });

  it("refuses a folder standing at the new name", () => {
    persons.save({ id: "me", name: "You", description: "" });
    fs.mkdirSync(path.join(dir, "ghost-folder"));
    expect(persons.rename("me", "ghost-folder")).toBe(false);
    expect(persons.get("me")).toMatchObject({ name: "You" });
    expect(fs.existsSync(path.join(dir, "ghost-folder"))).toBe(true);
  });
});

describe("delete", () => {
  it("deletes the row and the person folder", () => {
    persons.save({ id: "a", name: "A", description: "" });
    fs.writeFileSync(path.join(dir, "a", "avatar.jpg"), "x");
    expect(persons.delete("a")).toBe(true);
    expect(persons.get("a")).toBeNull();
    expect(fs.existsSync(path.join(dir, "a"))).toBe(false);
    expect(persons.delete("a")).toBe(false);
    expect(persons.delete("a/b")).toBe(false);
  });

  // The catalog owns the folder of a persona it knows and nothing else: a folder
  // no row names may be the user's, so a delete never sweeps the folders around it.
  it("leaves a folder no row names alone", () => {
    fs.mkdirSync(path.join(dir, "stranger"), { recursive: true });
    persons.save({ id: "a", name: "A", description: "" });
    persons.delete("a");
    expect(fs.existsSync(path.join(dir, "stranger"))).toBe(true);
  });
});

describe("clone", () => {
  it("copies the row and the folder (the avatar goes along) with the (copy) name", () => {
    persons.save({ id: "me", name: "You", description: "engineer" });
    fs.writeFileSync(path.join(dir, "me", "avatar.jpg"), "av");
    const newId = persons.clone("me");
    expect(newId).toBe("me-copy");
    expect(persons.get("me-copy")).toEqual({
      id: "me-copy",
      name: "You (copy)",
      description: "engineer",
    });
    expect(fs.existsSync(path.join(dir, "me-copy", "avatar.jpg"))).toBe(true);
    // the source is left untouched
    expect(persons.get("me")?.name).toBe("You");
  });

  it("finds a free id when the first candidate is taken", () => {
    persons.save({ id: "a", name: "A", description: "" });
    persons.save({ id: "a-copy", name: "Taken", description: "" });
    expect(persons.clone("a")).toBe("a-copy2");
  });

  it("returns null for a missing or invalid source", () => {
    expect(persons.clone("nope")).toBeNull();
    expect(persons.clone("a b")).toBeNull();
  });
});

// The persona's own pictures: where a 📎 attachment the user shares is kept.
describe("storePicture (the person's own pictures)", () => {
  let meta: ImageMetaService;
  let svc: PersonsService;
  const PNG = "data:image/png;base64,aGVsbG8=";

  beforeEach(() => {
    // with the table, because the de-dup that makes one photo one picture is its
    // whole point and it has nowhere to look without it
    meta = new ImageMetaService(() => root);
    svc = new PersonsService(() => dir, () => path.join(root, "catalogs.db"), meta);
    svc.save({ id: "me", name: "You", description: "" });
  });
  afterEach(() => {
    svc.close();
    meta.close();
  });

  it("writes into the persona's folder under a readable name and returns its id", () => {
    const id = svc.storePicture("me", PNG, "a red boat");
    expect(id).toMatch(/^users\/me\/a-red-boat-[0-9a-f]{6}\.png$/);
    expect(fs.existsSync(path.join(root, "users", "me", id.slice("users/me/".length)))).toBe(true);
    // the row carries the facts of the file, so the next dedup sees this picture
    expect(meta.get(id)?.fileHash).toBeTruthy();
  });

  it("the same bytes twice stay one picture", () => {
    const first = svc.storePicture("me", PNG, "my portrait");
    const again = svc.storePicture("me", PNG, "my portrait again");
    expect(again).toBe(first);
    expect(fs.readdirSync(path.join(dir, "me"))).toHaveLength(1);
  });

  it("a byte-identical picture of another folder is reused, not copied", () => {
    const elsewhere = "chats/room/a-boat-1a2b3c.png";
    const abs = PathHelper.resolveImageId(elsewhere)!;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from("aGVsbG8=", "base64"));
    expect(svc.storePicture("me", PNG)).toBe(elsewhere);
    // nothing was written into the persona's folder (it exists since the card
    // was saved, but it holds no picture of this bytes)
    expect(fs.readdirSync(path.join(dir, "me"))).toEqual([]);
  });

  it("throws on a persona that cannot have a folder and on a payload that is not a picture", () => {
    expect(() => svc.storePicture("a b", PNG)).toThrow(/persona ID/i);
    expect(() => svc.storePicture("me", "not a data URL")).toThrow();
  });
});
