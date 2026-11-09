import fs from "fs";
import os from "os";
import path from "path";
import { CharactersService } from "../characters/CharactersService";
import { ChatsService } from "../chats/ChatsService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Config } from "../configuration/Config";
import { Model } from "../configuration/Model";
import { ImageMetaService } from "../images/ImageMetaService";
import { PersonsService } from "../persons/PersonsService";
import { EntityIdService } from "./EntityIdService";
import { PathHelper } from "../shared/PathHelper";

// The ID of a character or a persona is the name of its folder, and through that
// folder it is written into the chats (the participants, the persona of the
// chat, the author of every line), into the picture ids (the photos, the avatar)
// and into the picture rows (their references and their cast). Renaming it is
// therefore a move with a trail, and these tests are about the trail: what has
// to be found under the new ID afterwards.

const PNG = "data:image/png;base64,aGVsbG8=";

let root: string;
let meta: ImageMetaService;
let chats: ChatsService;
let characters: CharactersService;
let persons: PersonsService;
let entityIds: EntityIdService;
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

// A picture file inside a character's starter set, written by hand (an app user
// uploads it as a file; a test writes the bytes).
function characterPhoto(charId: string, name: string): string {
  const file = path.join(PathHelper.charactersDir(), charId, "photos", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "img");
  return PathHelper.imageIdOf(file);
}

// A message of a character, stored the way the reply pipeline stores one.
function assistantLine(chatId: string, characterId: string, text: string): void {
  const chat = chats.get(chatId)!;
  chat.messages.push({
    id: `line-${chat.messages.length}`,
    role: "assistant",
    characterId,
    text,
    images: [],
    timestamp: 1,
  });
  chats.save(chat);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-entityid-"));
  process.env.SILLYTALK_DATA_DIR = root;
  meta = track(new ImageMetaService(() => root));
  chats = track(new ChatsService(() => PathHelper.chatsDir(), new StubConfigurationService(), meta));
  characters = track(new CharactersService(() => PathHelper.charactersDir(), () => PathHelper.catalogsDatabaseFile()));
  persons = track(new PersonsService(() => PathHelper.personsDir(), () => PathHelper.catalogsDatabaseFile()));
  entityIds = new EntityIdService(characters, persons, chats, meta);
});

afterEach(() => {
  for (const service of open) service.close();
  open.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.SILLYTALK_DATA_DIR;
});

describe("renaming a character", () => {
  it("moves the folder with its card, its photos and its avatar", () => {
    characters.save({ id: "alice", name: "Alice", description: "a tall woman in a green coat" });
    characterPhoto("alice", "photo1.jpg");
    fs.writeFileSync(path.join(PathHelper.characterDir("alice"), "avatar.jpg"), "img");

    entityIds.renameCharacter("alice", "green-coat");

    expect(fs.existsSync(path.join(PathHelper.characterDir("alice")))).toBe(false);
    expect(characters.get("green-coat")).toEqual({
      id: "green-coat",
      name: "Alice",
      description: "a tall woman in a green coat",
    });
    expect(characters.get("alice")).toBeNull();
    // the photo is the same file at a new path, and the avatar moved along
    expect(fs.existsSync(fileOf("characters/green-coat/photos/photo1.jpg"))).toBe(true);
    expect(fs.existsSync(fileOf("characters/green-coat/avatar.jpg"))).toBe(true);
    expect(characters.findAvatar("green-coat")).toBeTruthy();
  });

  it("carries the chat along: the participant list, the author of every line, the card of her photo", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    persons.save({ id: "carol", name: "Carol", description: "" });
    const photo = characterPhoto("alice", "photo1.jpg");
    const chat = chats.create(["alice"], "m1", "carol");
    chats.addUserMessage(chat, "hello");
    assistantLine(chat.id, "alice", "Hi there.");
    chats.addImageMessage(chats.get(chat.id)!, photo, {
      description: "alice at the window",
      depicts: ["char:alice"],
    });

    entityIds.renameCharacter("alice", "lisa");

    const after = chats.get(chat.id)!;
    expect(after.characterIds).toEqual(["lisa"]);
    // a persona of the same chat is not a character and keeps its own id
    expect(after.userId).toBe("carol");
    expect(after.messages[1].characterId).toBe("lisa");
    // the card of her photo shows the photo at its new path, with its caption
    const card = after.messages[2];
    expect(card.images).toEqual(["characters/lisa/photos/photo1.jpg"]);
    expect(card.text).toBe("alice at the window");
    expect(card.depicts).toEqual(["char:lisa"]);
  });

  it("follows the picture rows: the cast of her own pictures and the reference set of the ones drawn from them", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    const photo = characterPhoto("alice", "photo1.jpg");
    const chat = chats.create(["alice"], "m1", "me");
    const drawn = chats.saveImage(chat.id, PNG, { nameHint: "alice-in-the-garden" });
    meta.set(photo, { description: "alice in a green coat", depicts: ["char:alice"] });
    meta.set(drawn, {
      prompt: "the first reference image shows the woman in the green coat",
      refs: [photo],
      depicts: ["char:alice"],
    });

    entityIds.renameCharacter("alice", "heroine");

    const moved = "characters/heroine/photos/photo1.jpg";
    expect(meta.get(photo)).toBeNull();
    expect(meta.get(moved)).toMatchObject({ description: "alice in a green coat", depicts: ["char:heroine"] });
    // the drawn picture keeps its own id (it lives in the chat) and follows the
    // reference and the cast; its prompt text is the user's wording and stays
    expect(meta.get(drawn)).toMatchObject({
      prompt: "the first reference image shows the woman in the green coat",
      refs: [moved],
      depicts: ["char:heroine"],
    });
  });

  it("takes a row whose file is already gone, so it does not stay behind naming a path that never existed", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    // a photo the user deleted by hand: the row of its description is all that
    // is left, and it names the folder that is about to be renamed
    meta.set("characters/alice/photos/gone-1a2b3c.jpg", { description: "alice at the sea" });

    entityIds.renameCharacter("alice", "alice2");

    expect(meta.get("characters/alice/photos/gone-1a2b3c.jpg")).toBeNull();
    expect(meta.get("characters/alice2/photos/gone-1a2b3c.jpg")).toMatchObject({
      description: "alice at the sea",
    });
  });

  it("renaming to the same ID does nothing and breaks nothing", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    const photo = characterPhoto("alice", "photo1.jpg");
    meta.set(photo, { description: "alice", depicts: ["char:alice"] });

    entityIds.renameCharacter("alice", "alice");

    expect(characters.get("alice")).toMatchObject({ name: "Alice" });
    expect(meta.get(photo)?.description).toBe("alice");
  });

  it("refuses an ID that another character already has, and changes nothing", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    characters.save({ id: "bob", name: "Bob", description: "a tall man" });
    const chat = chats.create(["alice", "bob"], "m1", "me");
    assistantLine(chat.id, "alice", "Hi.");

    expect(() => entityIds.renameCharacter("alice", "bob")).toThrow(/already a character/);
    expect(characters.get("alice")).toMatchObject({ name: "Alice" });
    expect(characters.get("bob")).toMatchObject({ name: "Bob" });
    expect(chats.get(chat.id)!.characterIds).toEqual(["alice", "bob"]);
    expect(chats.get(chat.id)!.messages[0].characterId).toBe("alice");
  });

  it("refuses an ID that is not a folder name and a character that does not exist", () => {
    characters.save({ id: "alice", name: "Alice", description: "" });
    expect(() => entityIds.renameCharacter("alice", "two words")).toThrow(/not a valid ID/);
    expect(() => entityIds.renameCharacter("alice", "../elsewhere")).toThrow(/not a valid ID/);
    expect(() => entityIds.renameCharacter("alice", ".hidden")).toThrow(/not a valid ID/);
    expect(() => entityIds.renameCharacter("nobody", "someone")).toThrow(/no character/);
    expect(characters.get("alice")).toMatchObject({ name: "Alice" });
  });

  it("leaves a persona of the same ID alone", () => {
    // the two catalogs are separate folders and a chat names them by different
    // fields, so "sam" as a character and "sam" as a persona are two entities
    characters.save({ id: "sam", name: "Sam (character)", description: "" });
    persons.save({ id: "sam", name: "Sam (persona)", description: "" });
    const chat = chats.create(["sam"], "m1", "sam");
    chats.addUserMessage(chat, "hello");
    assistantLine(chat.id, "sam", "Hi.");

    entityIds.renameCharacter("sam", "samuel");

    const after = chats.get(chat.id)!;
    expect(after.characterIds).toEqual(["samuel"]);
    expect(after.userId).toBe("sam");
    expect(after.messages[0].userId).toBe("sam");
    expect(after.messages[1].characterId).toBe("samuel");
    expect(persons.get("sam")).toMatchObject({ name: "Sam (persona)" });
  });
});

describe("renaming a persona", () => {
  it("carries the chat along: the active persona, the author of the user's lines, the avatar card", () => {
    persons.save({ id: "carol", name: "Carol", description: "a woman with short red hair" });
    const avatarFile = path.join(PathHelper.personDir("carol"), "avatar.jpg");
    fs.mkdirSync(path.dirname(avatarFile), { recursive: true });
    fs.writeFileSync(avatarFile, "img");
    const avatar = PathHelper.imageIdOf(avatarFile);
    const chat = chats.create(["alice"], "m1", "carol");
    chats.addUserMessage(chat, "this is me");
    chats.addImageMessage(chats.get(chat.id)!, avatar, {
      userId: "carol",
      description: "carol at the door",
      depicts: ["user:carol"],
    });

    entityIds.renamePerson("carol", "karin");

    const after = chats.get(chat.id)!;
    expect(after.userId).toBe("karin");
    expect(after.messages[0].userId).toBe("karin");
    const card = after.messages[1];
    expect(card.images).toEqual(["users/karin/avatar.jpg"]);
    expect(card.text).toBe("carol at the door");
    expect(card.depicts).toEqual(["user:karin"]);
    // the card's own author: a line keeps the persona it was said under, and
    // that persona is the one that was renamed
    expect(card.userId).toBe("karin");
    expect(persons.get("karin")).toMatchObject({ name: "Carol" });
    expect(persons.get("carol")).toBeNull();
  });

  it("rewrites the cast of the pictures that name her, and not the characters of the same ID", () => {
    characters.save({ id: "sam", name: "Sam", description: "" });
    persons.save({ id: "carol", name: "Carol", description: "" });
    const photo = characterPhoto("sam", "photo1.jpg");
    meta.set(photo, { description: "the two of them", depicts: ["char:sam", "user:carol"] });

    entityIds.renamePerson("carol", "katrin");

    expect(meta.get("characters/sam/photos/photo1.jpg")).toMatchObject({
      depicts: ["char:sam", "user:katrin"],
    });
    expect(characters.get("sam")).toMatchObject({ name: "Sam" });
  });

  it("refuses an ID that another persona already has", () => {
    persons.save({ id: "carol", name: "Carol", description: "" });
    persons.save({ id: "dave", name: "Dave", description: "" });
    expect(() => entityIds.renamePerson("carol", "dave")).toThrow(/already a persona/);
    expect(persons.get("carol")).toMatchObject({ name: "Carol" });
    expect(persons.get("dave")).toMatchObject({ name: "Dave" });
  });

  it("refuses a persona that does not exist", () => {
    expect(() => entityIds.renamePerson("ghost", "someone")).toThrow(/no persona/);
  });
});
