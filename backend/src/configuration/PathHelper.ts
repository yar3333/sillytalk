import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

// The shared data-layout helper: the data root (~/.config/sillytalk,
// overridable by environment variables for e2e tests and relocatable
// installs — SILLYTALK_DATA_DIR the whole root, SILLYTALK_CHATS_DIR /
// SILLYTALK_CHARACTERS_DIR / SILLYTALK_USERS_DIR the individual folders,
// SILLYTALK_LISTEN the listen address on top of config.json), the per-domain
// folder/file paths, and the small fs/id utilities the domains use.
// Everything is stateless, so it is a bunch of statics (there is nothing to
// inject): the accessors read the env on every call (not at module load), so
// tests can point the layout at a temp dir without a process restart.
export class PathHelper {
  static configDir(): string {
    return process.env.SILLYTALK_DATA_DIR || path.join(os.homedir(), ".config", "sillytalk");
  }

  static configFile(): string {
    return path.join(PathHelper.configDir(), "config.json");
  }

  // A character is a ~/.config/sillytalk/characters/<id>/ folder:
  // the folder name is the character ID, character.json holds name and description.
  static charactersDir(): string {
    return process.env.SILLYTALK_CHARACTERS_DIR || path.join(PathHelper.configDir(), "characters");
  }

  static characterDir(id: string, root: string = PathHelper.charactersDir()): string {
    return path.join(root, id);
  }

  static characterFile(id: string, root: string = PathHelper.charactersDir()): string {
    return path.join(PathHelper.characterDir(id, root), "character.json");
  }

  // The path to a character's photo folder is always fixed: ~/.config/sillytalk/characters/<id>/photos
  static characterPhotosDir(id: string, root: string = PathHelper.charactersDir()): string {
    return path.join(PathHelper.characterDir(id, root), "photos");
  }

  // A person (the persona card) is a ~/.config/sillytalk/users/<id>/ folder:
  // the folder name is the person ID, user.json holds name and persona
  // description. The on-disk layout (users/, user.json) and the
  // SILLYTALK_USERS_DIR env var are historical — the domain concept in the code
  // is person/persons.
  static personsDir(): string {
    return process.env.SILLYTALK_USERS_DIR || path.join(PathHelper.configDir(), "users");
  }

  static personDir(id: string, root: string = PathHelper.personsDir()): string {
    return path.join(root, id);
  }

  static personFile(id: string, root: string = PathHelper.personsDir()): string {
    return path.join(PathHelper.personDir(id, root), "user.json");
  }

  static chatsDir(): string {
    return process.env.SILLYTALK_CHATS_DIR || path.join(PathHelper.configDir(), "chats");
  }

  static chatDir(chatId: string, root: string = PathHelper.chatsDir()): string {
    return path.join(root, chatId);
  }

  static chatFile(chatId: string, root: string = PathHelper.chatsDir()): string {
    return path.join(PathHelper.chatDir(chatId, root), "chat.json");
  }

  static chatFilesDir(chatId: string, root: string = PathHelper.chatsDir()): string {
    return path.join(PathHelper.chatDir(chatId, root), "files");
  }

  // Creates the data root and the domain folders (when missing).
  static ensureDirs(): void {
    fs.mkdirSync(PathHelper.configDir(), { recursive: true });
    fs.mkdirSync(PathHelper.chatsDir(), { recursive: true });
    fs.mkdirSync(PathHelper.charactersDir(), { recursive: true });
    fs.mkdirSync(PathHelper.personsDir(), { recursive: true });
  }

  static expandPath(p: string): string {
    if (!p) return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/") || p.startsWith("~\\")) {
      return path.join(os.homedir(), p.slice(2));
    }
    return p;
  }

  // A fresh id for a chat or a message.
  static newId(): string {
    return randomUUID();
  }

  // Dirent.isDirectory() returns false for symlinks and Windows junctions,
  // so a link folder is counted as a directory when stat through the link
  // answers "dir". A broken link is not a directory.
  static isDirEntry(root: string, entry: fs.Dirent): boolean {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(root, entry.name)).isDirectory();
    } catch {
      return false;
    }
  }
}
