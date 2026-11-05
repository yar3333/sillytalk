import express from "express";
import path from "path";
import { PathHelper } from "../shared/PathHelper";
import { HttpHelper } from "../shared/HttpHelper";
import { Character } from "./Character";
import { CharactersService } from "./CharactersService";
import { ReplyService } from "../reply/ReplyService";

// The /characters routes: the catalog CRUD (the full-list sync), the clone,
// the photo serving and the avatar. The domain logic lives in
// CharactersService; this file is the thin HTTP layer (validation, status
// codes, streaming). The reply service is here for one route: the appearance
// note of a card is a model call, and the model calls live above the domain
// services, not inside the catalog.
export function createCharactersRouter(characters: CharactersService, reply: ReplyService): express.Router {
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
        ...(typeof c.look === "string" && c.look.trim() ? { look: c.look.trim() } : {}),
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

  // ---- the look of the character ----

  // Writes the appearance note from the character's photos (or, with no photos
  // to look at, from their description). The answer is the text only: the
  // dialog shows it in the field and the user saves it themselves — a face the
  // model invented should not be written into a card behind their back.
  router.post("/:id/look", async (req, res) => {
    const id = String(req.params.id);
    if (!characters.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    try {
      res.json({ look: await reply.fillLook("character", id) });
    } catch (err) {
      const message = (err as Error).message;
      const status = /not found/i.test(message) ? 404 : /model/i.test(message) ? 400 : 500;
      res.status(status).json({ error: message });
    }
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
