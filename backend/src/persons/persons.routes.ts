import express from "express";
import { Person } from "./Person";
import { PersonsService } from "./PersonsService";
import { EntityIdService } from "../entities/EntityIdService";

// The /persons routes (the persona cards). The JSON body field and the
// response keys stay "users", and the picture folders on disk stay users/<id>/.
// The domain logic lives in PersonsService (the catalogs table and the picture
// folders) and in EntityIdService (what a new ID drags along); this file is the
// thin HTTP layer (validation, status codes, streaming).
export function createPersonsRouter(persons: PersonsService, entityIds: EntityIdService): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.json(persons.listWithAvatars());
  });

  // Full sync: creates/updates/deletes persons to match the list.
  router.put("/", (req, res) => {
    const { users } = req.body ?? {};
    if (!Array.isArray(users)) {
      res.status(400).json({ error: "Expected a list of users" });
      return;
    }
    const list: Person[] = [];
    const seen = new Set<string>();
    for (const entry of users) {
      if (!entry || typeof entry !== "object") {
        res.status(400).json({ error: "Invalid user entry" });
        return;
      }
      const u = entry as Partial<Person>;
      if (!persons.isValidId(u.id) || seen.has(u.id)) {
        res.status(400).json({ error: `Invalid or duplicate user ID: ${String(u.id)}` });
        return;
      }
      seen.add(u.id);
      list.push({
        id: u.id,
        name: typeof u.name === "string" ? u.name : u.id,
        description: typeof u.description === "string" ? u.description : "",
      });
    }
    persons.sync(list);
    res.json(persons.listWithAvatars());
  });

  // Clones the person folder (the avatar goes along); the copy is named
  // "<name> (copy)" in a free <id>-copy* folder. The response carries the
  // new id (the UI opens the copy's edit dialog right away).
  router.post("/:id/clone", (req, res) => {
    const newId = persons.clone(req.params.id);
    if (newId === null) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ id: newId, users: persons.listWithAvatars() });
  });

  // Gives the persona a new ID. An ID is the name of its folder, so this is a
  // folder move and not a field edit: the chats that send their messages under
  // this persona, the author of the lines it already said, its avatar as a
  // picture id and the cast of the picture rows follow the new one (the rules
  // and the reason are in EntityIdService). The new ID is a path segment, so it
  // travels in the body.
  router.post("/:id/rename", (req, res) => {
    const newId = typeof req.body?.newId === "string" ? req.body.newId.trim() : "";
    if (!newId) {
      res.status(400).json({ error: "Expected the new ID (newId field)" });
      return;
    }
    try {
      entityIds.renamePerson(String(req.params.id), newId);
      res.json({ id: newId, users: persons.listWithAvatars() });
    } catch (err) {
      // The service says why the name is not usable (taken, malformed) — the
      // banner can show it as it is.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // The avatar is one of the persona's pictures: a normal image file of its
  // folder whose data-root-relative id the row keeps. The preview is served by
  // the /media route, so there is no GET here. Picking it accepts either an
  // existing picture id (`image`, reused) or a disk file (`data`, a data URL).
  // Clearing only drops the designation, the file stays.

  router.post("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!persons.isValidId(id)) {
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
      const avatarId = persons.setAvatarImage(id, { ...(data ? { dataUrl: data } : {}), ...(image ? { imageId: image } : {}) });
      res.json({ id: avatarId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!persons.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    res.json({ deleted: persons.clearAvatar(id) });
  });

  return router;
}
