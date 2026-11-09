import express from "express";
import { Character } from "./Character";
import { CharactersService } from "./CharactersService";
import { EntityIdService } from "../entities/EntityIdService";

// The /characters routes: the catalog CRUD (the full-list sync), the clone, the
// ID rename and the avatar. A character's pictures are ordinary files of its
// folder (served by the /media route), so there is no photo route here. The
// domain logic lives in
// CharactersService (the catalogs table and the picture folders) and in
// EntityIdService (what a new ID drags along); this file is the thin HTTP layer
// (validation, status codes, streaming).
export function createCharactersRouter(
  characters: CharactersService,
  entityIds: EntityIdService,
): express.Router {
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

  // Clones the character — its row and its folder (the photos and the avatar
  // go along); the copy is named "<name> (copy)" under a free <id>-copy* id.
  // The response carries the new id (the UI opens the copy's edit dialog right
  // away).
  router.post("/:id/clone", (req, res) => {
    const newId = characters.clone(req.params.id);
    if (newId === null) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    res.json({ id: newId, characters: characters.listWithPhotos() });
  });

  // Gives the character a new ID. An ID is the primary key of the catalogs row
  // and the name of the folder of its pictures at once, so this is a move and
  // not a field edit: the chats that name this character, its photos and avatar
  // as picture ids and the cast of the picture rows follow the new one (the
  // rules and the reason are in EntityIdService). The new ID is a path segment,
  // so it travels in the body.
  router.post("/:id/rename", (req, res) => {
    const newId = typeof req.body?.newId === "string" ? req.body.newId.trim() : "";
    if (!newId) {
      res.status(400).json({ error: "Expected the new ID (newId field)" });
      return;
    }
    try {
      entityIds.renameCharacter(String(req.params.id), newId);
      res.json({ id: newId, characters: characters.listWithPhotos() });
    } catch (err) {
      // The service says why the name is not usable (taken, malformed) — the
      // banner can show it as it is.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // The avatar is one of the character's pictures: a normal image file of its
  // folder whose data-root-relative id the row keeps. The preview is served by
  // the /media route, so there is no GET here. Picking it accepts either an
  // existing picture id (`image`, reused) or a disk file the user chose (`data`,
  // a data URL — the server reuses a byte-identical picture or copies it into
  // the folder). Clearing only drops the designation, the file stays.

  router.post("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!characters.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    const data = typeof req.body?.data === "string" ? req.body.data : undefined;
    const image = typeof req.body?.image === "string" ? req.body.image : undefined;
    if (!data && !image) {
      res.status(400).json({ error: "Expected a picked picture (data or image field)" });
      return;
    }
    try {
      const avatarId = characters.setAvatarImage(id, { ...(data ? { dataUrl: data } : {}), ...(image ? { imageId: image } : {}) });
      res.json({ id: avatarId });
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
    res.json({ deleted: characters.clearAvatar(id) });
  });

  return router;
}
