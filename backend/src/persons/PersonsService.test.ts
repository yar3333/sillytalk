import fs from "fs";
import os from "os";
import path from "path";
import { PersonsService } from "./PersonsService";

let root: string;
let persons: PersonsService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-persons-"));
  persons = new PersonsService(() => root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isValidId", () => {
  it("accepts ordinary folder names", () => {
    expect(persons.isValidId("me")).toBe(true);
    expect(persons.isValidId("u1712345678901")).toBe(true);
    // unicode letters are allowed in folder names
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
  it("saves the person into a folder and reads it back", () => {
    persons.save({ id: "me", name: "You", description: "engineer" });
    expect(persons.get("me")).toEqual({
      id: "me",
      name: "You",
      description: "engineer",
    });
    expect(persons.list().map((p) => p.id)).toEqual(["me"]);
  });

  it("list ignores folders without user.json and broken files", () => {
    fs.mkdirSync(path.join(root, "empty"));
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "user.json"), "{oops", "utf-8");
    persons.save({ id: "ok", name: "OK", description: "" });
    expect(persons.list().map((p) => p.id)).toEqual(["ok"]);
  });

  it("sorts the list by name", () => {
    persons.save({ id: "b", name: "Bob", description: "" });
    persons.save({ id: "a", name: "Anna", description: "" });
    expect(persons.list().map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("sync", () => {
  it("creates new ones, updates changed ones, deletes the extras", () => {
    persons.save({ id: "one", name: "One", description: "old" });
    persons.save({ id: "two", name: "Two", description: "" });
    persons.sync([
      { id: "one", name: "One", description: "new" },
      { id: "three", name: "Three", description: "" },
    ]);
    expect(
      persons
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["one", "three"]);
    expect(persons.get("one")?.description).toBe("new");
  });

  it("deletes the person together with the avatar", () => {
    persons.save({ id: "one", name: "One", description: "" });
    fs.writeFileSync(path.join(root, "one", "avatar.jpg"), "x");
    persons.sync([]);
    expect(fs.existsSync(path.join(root, "one"))).toBe(false);
  });
});

describe("symlink folders", () => {
  it("list sees a person behind a symlink/junction", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-real-"));
    try {
      fs.mkdirSync(path.join(real, "friend"));
      fs.writeFileSync(
        path.join(real, "friend", "user.json"),
        JSON.stringify({ name: "Friend", description: "" }),
        "utf-8",
      );
      let linked = false;
      try {
        fs.symlinkSync(
          path.join(real, "friend"),
          path.join(root, "friend"),
          process.platform === "win32" ? "junction" : "dir",
        );
        linked = true;
      } catch {
        // no permission to create links — the check is unavailable
      }
      if (linked) {
        expect(persons.list().map((p) => p.id)).toContain("friend");
        expect(persons.get("friend")?.name).toBe("Friend");
      }
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("delete", () => {
  it("deletes the person folder", () => {
    persons.save({ id: "a", name: "A", description: "" });
    expect(persons.delete("a")).toBe(true);
    expect(persons.get("a")).toBeNull();
    expect(persons.delete("a")).toBe(false);
    expect(persons.delete("a/b")).toBe(false);
  });
});

describe("clone", () => {
  it("copies the folder (the avatar goes along) with the (copy) name", () => {
    persons.save({ id: "me", name: "You", description: "engineer" });
    fs.writeFileSync(path.join(root, "me", "avatar.jpg"), "av");
    const newId = persons.clone("me");
    expect(newId).toBe("me-copy");
    expect(persons.get("me-copy")).toEqual({
      id: "me-copy",
      name: "You (copy)",
      description: "engineer",
    });
    expect(fs.existsSync(path.join(root, "me-copy", "avatar.jpg"))).toBe(true);
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
