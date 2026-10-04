import express from "express";
import path from "path";
import { PathHelper } from "../shared/PathHelper";
import { HttpHelper } from "../shared/HttpHelper";
import { Character } from "./Character";
import { CharactersService } from "./CharactersService";

// The /characters routes: the catalog CRUD (the full-list sync), the clone,
// the photo serving and the avatar. The domain logic lives in
// CharactersService; this file is the thin HTTP layer (validation, status
// codes, streaming).
export function createCharactersRouter(characters: CharactersService): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.json(characters.listWithPhotos());
  });

  // Full sync: creates/updates/deletes characters to match the list.
  router.put("/", (req, res) => {
    const { characters: chars } = req.body ?? {};
    if (!Array.isArray(chars)) {
      res.status(400).json({ error: "Expected a list of characters" });
      return;
    }
    const list: Character[] = [];
    const seen = new Set<string>();
    for (const entry of chars) {
      if (!entry || typeof entry !== "object") {
        res.status(400).json({ error: "Invalid character entry" });
        return;
      }
      const c = entry as Partial<Character>;
      if (!characters.isValidId(c.id) || seen.has(c.id)) {
        res.status(400).json({ error: `Invalid or duplicate character ID: ${String(c.id)}` });
        return;
      }
      seen.add(c.id);
      list.push({
        id: c.id,
        name: typeof c.name === "string" ? c.name : c.id,
        description: typeof c.description === "string" ? c.description : "",
      });
    }
    characters.sync(list);
    res.json(characters.listWithPhotos());
  });

  // Clones the character folder (the photos and the avatar go along); the
  // copy is named "<name> (copy)" in a free <id>-copy* folder. The response
  // carries the new id (the UI opens the copy's edit dialog right away).
  router.post("/:id/clone", (req, res) => {
    const newId = characters.clone(req.params.id);
    if (newId === null) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    res.json({ id: newId, characters: characters.listWithPhotos() });
  });

  router.get("/:id/photos/:name", (req, res) => {
    const character = characters.get(req.params.id);
    if (!character) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    HttpHelper.sendImage(res, path.join(PathHelper.characterPhotosDir(character.id), path.basename(req.params.name)));
  });

  // ---- avatar ----
  // The avatar is stored in the folder as avatar.<ext> (usually avatar.jpg);
  // the extension follows the actual format of the uploaded image.

  router.get("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!characters.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    const file = characters.findAvatar(id);
    if (!file) {
      res.status(404).end();
      return;
    }
    // Avatars change from settings — the browser must not cache them.
    res.setHeader("Cache-Control", "no-store");
    HttpHelper.sendImage(res, file);
  });

  router.post("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!characters.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    const data = req.body?.data;
    if (typeof data !== "string" || !data) {
      res.status(400).json({ error: "Expected an image data URL (data field)" });
      return;
    }
    try {
      characters.saveAvatar(id, data);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!characters.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    res.json({ deleted: characters.deleteAvatar(id) });
  });

  return router;
}
