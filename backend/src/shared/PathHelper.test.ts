import fs from "fs";
import os from "os";
import path from "path";
import { PathHelper } from "./PathHelper";

// The accessors read the environment on every call, so the suite works on a
// temp data root instead of the real ~/.config/sillytalk.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-paths-"));
process.env.SILLYTALK_DATA_DIR = dataRoot;

describe("PathHelper.resolveImageId (the storage rule: what a stored id may point at)", () => {
  it("accepts a picture of a chat", () => {
    const id = "chats/c1/files/a-boat-1a2b3c.png";
    expect(PathHelper.resolveImageId(id)).toBe(path.join(dataRoot, "chats", "c1", "files", "a-boat-1a2b3c.png"));
  });

  it("accepts a file of the data root itself (a hand-edited row may point at any image of the data folder)", () => {
    expect(PathHelper.resolveImageId("config.json")).toBe(path.join(dataRoot, "config.json"));
  });

  it("refuses a path that leaves the data folders", () => {
    expect(PathHelper.resolveImageId("../../windows/win.ini")).toBeNull();
    expect(PathHelper.resolveImageId("../sillytalk-paths-x/config.json")).toBeNull();
  });

  it("refuses an empty id and an id carrying a NUL", () => {
    expect(PathHelper.resolveImageId("")).toBeNull();
    expect(PathHelper.resolveImageId("chats/c1/files/a.png\0.json")).toBeNull();
  });
});

describe("PathHelper.resolvePictureId (the HTTP rule: what the media route may serve)", () => {
  it("accepts a picture of a chat", () => {
    const id = "chats/c1/files/a-boat-1a2b3c.png";
    expect(PathHelper.resolvePictureId(id)).toBe(path.join(dataRoot, "chats", "c1", "files", "a-boat-1a2b3c.png"));
  });

  it("accepts the photo and the avatar of a character, and the avatar of a persona", () => {
    expect(PathHelper.resolvePictureId("characters/alice/photos/photo1.jpg")).toBe(
      path.join(dataRoot, "characters", "alice", "photos", "photo1.jpg"),
    );
    expect(PathHelper.resolvePictureId("characters/alice/avatar.jpg")).toBe(
      path.join(dataRoot, "characters", "alice", "avatar.jpg"),
    );
    expect(PathHelper.resolvePictureId("users/default/avatar.png")).toBe(
      path.join(dataRoot, "users", "default", "avatar.png"),
    );
  });

  it("refuses the files of the data root: the config and the workflows", () => {
    // config.json can hold a literal API key and comfyui/*.json is the user's
    // own data — neither is a picture, and neither sits in a picture folder.
    expect(PathHelper.resolvePictureId("config.json")).toBeNull();
    expect(PathHelper.resolvePictureId("comfyui/qwen-image-2.1.json")).toBeNull();
    // …while the same folder stays open to the storage rule.
    expect(PathHelper.resolveImageId("config.json")).not.toBeNull();
  });

  it("does not exclude the files that share a folder with the pictures (the format rule does)", () => {
    // The chats database sits next to the chats' files folders, so the folder
    // rule cannot name it; HttpHelper.sendImage refuses it by its name instead
    // — see HttpHelper.test.ts and the e2e check of the media route.
    expect(PathHelper.resolvePictureId("chats/chats.db")).not.toBeNull();
  });

  it("refuses a path that leaves the data folders", () => {
    expect(PathHelper.resolvePictureId("../../windows/win.ini")).toBeNull();
    expect(PathHelper.resolvePictureId("chats/c1/../../../windows/win.ini")).toBeNull();
  });

  it("follows a domain folder moved out of the data root", () => {
    const movedChats = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-paths-chats-"));
    process.env.SILLYTALK_CHATS_DIR = movedChats;
    try {
      const file = path.join(movedChats, "c1", "files", "a-boat-1a2b3c.png");
      const id = PathHelper.imageIdOf(file);
      expect(PathHelper.resolvePictureId(id)).toBe(path.resolve(file));
      // The default chats location of the data root is no longer a picture
      // folder once the chats live elsewhere — an id pointing there is refused.
      expect(PathHelper.resolvePictureId("chats/c1/files/a-boat-1a2b3c.png")).toBeNull();
    } finally {
      delete process.env.SILLYTALK_CHATS_DIR;
      fs.rmSync(movedChats, { recursive: true, force: true });
    }
  });
});

describe("PathHelper.comfyWorkflowsDir", () => {
  it("is the comfyui folder of the data root", () => {
    expect(PathHelper.comfyWorkflowsDir()).toBe(path.join(dataRoot, "comfyui"));
  });
});

describe("PathHelper.listPictureIds (the catalog the picture editor offers)", () => {
  it("lists the pictures of the chats, the characters and the personas — and nothing else", () => {
    const write = (rel: string, content = "x"): void => {
      const file = path.join(dataRoot, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    write("chats/c1/files/a-red-boat.png");
    write("chats/c1/files/a-red-boat.png.json", "{}"); // a leftover sidecar, not a picture
    write("chats/c1/files/notes.txt");
    write("chats/chats.db");
    write("characters/alice/photos/photo1.jpg");
    write("characters/alice/character.json", "{}");
    write("users/default/avatar.webp");
    write("comfyui/qwen-image-2.1.json", "{}");

    const ids = PathHelper.listPictureIds();
    expect(ids).toContain("chats/c1/files/a-red-boat.png");
    expect(ids).toContain("characters/alice/photos/photo1.jpg");
    expect(ids).toContain("users/default/avatar.webp");
    expect(ids.some((id) => id.endsWith(".json"))).toBe(false);
    expect(ids).not.toContain("chats/c1/files/notes.txt");
    expect(ids).not.toContain("chats/chats.db");
    expect(ids).not.toContain("comfyui/qwen-image-2.1.json");
    // every id it offers is one the media route can serve
    for (const id of ids) expect(PathHelper.resolvePictureId(id)).not.toBeNull();
  });

  it("caps the list and puts the most recently touched picture first", () => {
    const write = (rel: string): void => {
      const file = path.join(dataRoot, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    };
    write("chats/c2/files/old.png");
    write("chats/c2/files/new.png");
    const old = path.join(dataRoot, "chats/c2/files/old.png");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);

    const ids = PathHelper.listPictureIds();
    const fresh = ids.indexOf("chats/c2/files/new.png");
    expect(fresh).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeLessThan(ids.indexOf("chats/c2/files/old.png"));
    expect(PathHelper.listPictureIds(1)).toHaveLength(1);
  });
});
