import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { HttpHelper } from "./HttpHelper";

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

  // A character's pictures live in a ~/.config/sillytalk/characters/<id>/
  // folder: the folder name is the character ID (the primary key of its row in
  // the catalogs database, which holds the card itself).
  static charactersDir(): string {
    return process.env.SILLYTALK_CHARACTERS_DIR || path.join(PathHelper.configDir(), "characters");
  }

  // The character's pictures (the starter set and the avatar) lie directly in
  // this folder — there is no photos/ subfolder any more. The folder is the
  // picture; a picture in it is addressed by its id (characters/<id>/<name>).
  static characterDir(id: string, root: string = PathHelper.charactersDir()): string {
    return path.join(root, id);
  }

  // A person's pictures (its avatar, and any picture the user drops in) live
  // directly in a ~/.config/sillytalk/users/<id>/ folder: the folder name is
  // the person ID (the primary key of its row in the catalogs database, which
  // holds the card itself). There is no subfolder — a picture is addressed by
  // its id (users/<id>/<name>). The on-disk layout (users/) and the
  // SILLYTALK_USERS_DIR env var are historical — the domain concept in the
  // code is person/persons.
  static personsDir(): string {
    return process.env.SILLYTALK_USERS_DIR || path.join(PathHelper.configDir(), "users");
  }

  static personDir(id: string, root: string = PathHelper.personsDir()): string {
    return path.join(root, id);
  }

  // The user's own ComfyUI workflows: a <model>.json here replaces the workflow
  // the app ships for that model, or adds a model the app does not know. The
  // app reads this folder next to its own workflows folder — see
  // image_generation/comfyui/ComfyUiWorkflows.ts.
  static comfyWorkflowsDir(): string {
    return path.join(PathHelper.configDir(), "comfyui");
  }

  static chatsDir(): string {
    return process.env.SILLYTALK_CHATS_DIR || path.join(PathHelper.configDir(), "chats");
  }

  // A chat's pictures lie directly in this folder (chats/<id>/<name>) — there
  // is no files/ subfolder any more. The chat's own database row lives in the
  // shared chats.db, not here; the folder holds only the picture files.
  static chatDir(chatId: string, root: string = PathHelper.chatsDir()): string {
    return path.join(root, chatId);
  }

  // Legacy: the per-chat chat.json file (the old storage format). The
  // service imports these once at database open and renames them to
  // chat.json.migrated — see ChatsService.
  static chatFile(chatId: string, root: string = PathHelper.chatsDir()): string {
    return path.join(PathHelper.chatDir(chatId, root), "chat.json");
  }

  // The chats database (node:sqlite): the chat fields and the messages live
  // here since the move away from the per-chat chat.json files. The
  // chats/<id>/ folders survive as the homes of the chat picture files
  // (chats/<id>/<name>, no subfolder).
  static chatsDatabaseFile(root: string = PathHelper.chatsDir()): string {
    return path.join(root, "chats.db");
  }

  // The image metadata database (node:sqlite): one global table keyed by the
  // image id (the path relative to the data root). The description and the
  // generation prompt of a picture live here, never in a sidecar file.
  static imagesDatabaseFile(root: string = PathHelper.configDir()): string {
    return path.join(root, "images.db");
  }

  // The catalogs database (node:sqlite): the character and the persona cards —
  // one `characters` and one `persons` table, each keyed by the id that is
  // also the name of the folder where that entity's pictures lie (directly in
  // it, the avatar included). The card is the row: character.json / user.json
  // are not read and not written.
  static catalogsDatabaseFile(root: string = PathHelper.configDir()): string {
    return path.join(root, "catalogs.db");
  }

  // ---- image identifiers ----
  //
  // An image is identified by its path RELATIVE TO THE DATA ROOT, with "/" as
  // the separator — "chats/<chatId>/a-sunset-over-the-sea-3f2a1c.png".
  // The id is what the chat messages store, what the API carries and what an
  // images-table row lists as a generation reference, so a chat folder stays
  // portable and a hand-edited row can point at any image of the data
  // folder. A domain folder that was moved out of the root
  // (SILLYTALK_CHATS_DIR pointing elsewhere) still works: its id simply
  // starts with "..", and resolveImageId accepts anything that resolves back
  // inside one of the known roots.

  // Absolute path -> id.
  static imageIdOf(absPath: string): string {
    return path.relative(PathHelper.configDir(), absPath).split(path.sep).join("/");
  }

  // Id -> absolute path, or null when it escapes every data folder (a
  // hand-edited chat or row must not turn the image route into an
  // arbitrary file reader).
  //
  // This is the STORAGE-side rule — what an id stored by the app or written by
  // hand in a row may point at. Serving a file over HTTP is stricter, see
  // resolvePictureId.
  static resolveImageId(id: string): string | null {
    if (!id || id.includes("\0")) return null;
    const abs = path.resolve(PathHelper.configDir(), id.split("/").join(path.sep));
    return PathHelper.dataRoots().some((root) => PathHelper.isInside(abs, root)) ? abs : null;
  }

  // The HTTP-side rule: id -> absolute path, but only for a file inside one of
  // the folders pictures live in. The data root itself is NOT one of them, so
  // the media route cannot be pointed at config.json (which can hold a literal
  // API key), at the chats database, or at the user's ComfyUI workflow files —
  // all of which sit in the data root next to the picture folders.
  static resolvePictureId(id: string): string | null {
    if (!id || id.includes("\0")) return null;
    const abs = path.resolve(PathHelper.configDir(), id.split("/").join(path.sep));
    return PathHelper.pictureRoots().some((root) => PathHelper.isInside(abs, root)) ? abs : null;
  }

  // The folders an image is allowed to live in: the data root plus the
  // per-domain overrides (which may point outside it).
  private static dataRoots(): string[] {
    return [
      ...new Set([
        PathHelper.configDir(),
        PathHelper.chatsDir(),
        PathHelper.charactersDir(),
        PathHelper.personsDir(),
      ]),
    ].map((p) => path.resolve(p));
  }

  // The folders pictures live in: the chat files, the character folders (their
  // photos and avatars), the persona folders (their avatars).
  private static pictureRoots(): string[] {
    return [...new Set([PathHelper.chatsDir(), PathHelper.charactersDir(), PathHelper.personsDir()])].map(
      (p) => path.resolve(p),
    );
  }

  private static isInside(target: string, root: string): boolean {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return target === root || target.startsWith(prefix);
  }

  // Every picture of the data catalog as an image id, newest first — the list
  // the picture editor offers when the user points a card at a file of the data
  // folder instead of a generated picture.
  //
  // It walks ONLY the folders pictures live in and keeps only the names
  // HttpHelper.isImage accepts, so every id it hands out can be loaded through
  // the media route — the catalog never offers a file the browser would get a
  // 400/404 for. A leftover sidecar (*.png.json) of the old format, the chats
  // database and the workflow files are not pictures and stay out. `limit`
  // caps the walk of an unusually large data folder.
  static listPictureIds(limit = 1000): string[] {
    const found: Array<{ id: string; mtime: number }> = [];
    const walk = (dir: string, depth: number): void => {
      if (found.length >= limit || depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= limit) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (PathHelper.isDirEntry(dir, entry)) {
          walk(full, depth + 1);
          continue;
        }
        if (!HttpHelper.isImage(full)) continue;
        try {
          found.push({ id: PathHelper.imageIdOf(full), mtime: fs.statSync(full).mtimeMs });
        } catch {
          // removed while walking — not a picture of the catalog any more
        }
      }
    };
    for (const root of PathHelper.pictureRoots()) walk(root, 0);
    // Newest first: the picture the user just worked with is at the top.
    found.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
    return found.map((f) => f.id);
  }

  // Creates the data root and the domain folders (when missing).
  static ensureDirs(): void {
    fs.mkdirSync(PathHelper.configDir(), { recursive: true });
    fs.mkdirSync(PathHelper.chatsDir(), { recursive: true });
    fs.mkdirSync(PathHelper.charactersDir(), { recursive: true });
    fs.mkdirSync(PathHelper.personsDir(), { recursive: true });
    // Empty by design: it is where the user puts their own ComfyUI workflows.
    fs.mkdirSync(PathHelper.comfyWorkflowsDir(), { recursive: true });
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
