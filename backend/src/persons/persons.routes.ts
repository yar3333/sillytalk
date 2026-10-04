import express from "express";
import { HttpHelper } from "../shared/HttpHelper";
import { Person } from "./Person";
import { PersonsService } from "./PersonsService";

// The /users routes (the persona cards). The domain concept in the code is
// person/persons — the REST paths, the JSON body field and the response keys
// stay "users" (the external contract). The domain logic lives in
// PersonsService; this file is the thin HTTP layer (validation, status
// codes, streaming).
export function createUsersRouter(persons: PersonsService): express.Router {
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

  // ---- avatar ----
  // The avatar is stored in the folder as avatar.<ext> (usually avatar.jpg);
  // the extension follows the actual format of the uploaded image.

  router.get("/:id/avatar", (req, res) => {
    const id = String(req.params.id);
    if (!persons.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    const file = persons.findAvatar(id);
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
    if (!persons.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    const data = req.body?.data;
    if (typeof data !== "string" || !data) {
      res.status(400).json({ error: "Expected an image data URL (data field)" });
      return;
    }
    try {
      persons.saveAvatar(id, data);
      res.json({ ok: true });
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
    res.json({ deleted: persons.deleteAvatar(id) });
  });

  return router;
}
