import fs from "fs";
import os from "os";
import path from "path";
import { PersonsService } from "./PersonsService";

let root: string;
let dir: string; // the users folder (the home of the picture folders)
let persons: PersonsService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-persons-"));
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
