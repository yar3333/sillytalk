import fs from "fs";
import os from "os";
import path from "path";
import { CharactersService } from "./CharactersService";

let root: string;
let characters: CharactersService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-chars-"));
  characters = new CharactersService(() => root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isValidId", () => {
  it("accepts ordinary folder names", () => {
    expect(characters.isValidId("assistant")).toBe(true);
    expect(characters.isValidId("alisa")).toBe(true);
    expect(characters.isValidId("c1712345678901")).toBe(true);
    // unicode letters are allowed in folder names
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
  it("saves the character into a folder and reads it back", () => {
    characters.save({ id: "alisa", name: "Alice", description: "a kind fairy" });
    expect(characters.get("alisa")).toEqual({
      id: "alisa",
      name: "Alice",
      description: "a kind fairy",
    });
    expect(characters.list().map((c) => c.id)).toEqual(["alisa"]);
  });

  it("creates the photos folder", () => {
    characters.save({ id: "a", name: "A", description: "" });
    expect(fs.existsSync(path.join(root, "a", "photos"))).toBe(true);
  });

  it("list ignores folders without character.json and broken files", () => {
    fs.mkdirSync(path.join(root, "empty"));
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "character.json"), "{oops", "utf-8");
    characters.save({ id: "ok", name: "OK", description: "" });
    expect(characters.list().map((c) => c.id)).toEqual(["ok"]);
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
    fs.writeFileSync(path.join(root, "one", "photos", "a.png"), "x");
    characters.sync([]);
    expect(fs.existsSync(path.join(root, "one"))).toBe(false);
  });
});

describe("migrate", () => {
  it("moves entries from the old config into folders", () => {
    characters.migrate([
      { id: "alisa", name: "Alice", description: "kind" },
      { id: "bad id", name: "X", description: "" },
      "not an object",
      null,
    ]);
    expect(characters.list().map((c) => c.id)).toEqual(["alisa"]);
    expect(characters.get("alisa")?.description).toBe("kind");
  });

  it("does not overwrite existing character.json", () => {
    characters.save({ id: "alisa", name: "New", description: "" });
    characters.migrate([{ id: "alisa", name: "Old", description: "" }]);
    expect(characters.get("alisa")?.name).toBe("New");
  });
});

describe("symlink folders", () => {
  it("list sees a character behind a symlink/junction", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-real-"));
    try {
      fs.mkdirSync(path.join(real, "carol"));
      fs.writeFileSync(
        path.join(real, "carol", "character.json"),
        JSON.stringify({ name: "Carol", description: "" }),
        "utf-8",
      );
      let linked = false;
      try {
        fs.symlinkSync(
          path.join(real, "carol"),
          path.join(root, "carol"),
          process.platform === "win32" ? "junction" : "dir",
        );
        linked = true;
      } catch {
        // no permission to create links — the check is unavailable
      }
      if (linked) {
        expect(characters.list().map((c) => c.id)).toContain("carol");
        expect(characters.get("carol")?.name).toBe("Carol");
      }
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("a broken link is not counted as a character", () => {
    let linked = false;
    try {
      fs.symlinkSync(
        path.join(root, "no-such-folder"),
        path.join(root, "ghost"),
        process.platform === "win32" ? "junction" : "dir",
      );
      linked = true;
    } catch {
      // no permission to create links — the check is unavailable
    }
    if (linked) {
      expect(characters.list()).toEqual([]);
    }
  });
});

describe("delete", () => {
  it("deletes the character folder", () => {
    characters.save({ id: "a", name: "A", description: "" });
    expect(characters.delete("a")).toBe(true);
    expect(characters.get("a")).toBeNull();
    expect(characters.delete("a")).toBe(false);
    expect(characters.delete("a/b")).toBe(false);
  });
});

describe("clone", () => {
  it("copies the folder (photos and avatar go along) with the (copy) name", () => {
    characters.save({ id: "alice", name: "Alice", description: "a friend" });
    fs.writeFileSync(path.join(root, "alice", "photos", "p1.png"), "img");
    fs.writeFileSync(path.join(root, "alice", "avatar.jpg"), "av");
    const newId = characters.clone("alice");
    expect(newId).toBe("alice-copy");
    expect(characters.get("alice-copy")).toEqual({
      id: "alice-copy",
      name: "Alice (copy)",
      description: "a friend",
    });
    expect(fs.existsSync(path.join(root, "alice-copy", "photos", "p1.png"))).toBe(true);
    expect(fs.existsSync(path.join(root, "alice-copy", "avatar.jpg"))).toBe(true);
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
