import express from "express";
import { HttpHelper } from "../shared/HttpHelper";
import { Person } from "./Person";
import { PersonsService } from "./PersonsService";
import { ReplyService } from "../reply/ReplyService";

// The /persons routes (the persona cards). The JSON body field and the
// response keys stay "users", and the on-disk layout stays users/<id>/
// user.json. The domain logic lives in PersonsService; this file is the
// thin HTTP layer (validation, status codes, streaming). The reply service
// is here for one route: writing an appearance note is a model call.
export function createPersonsRouter(persons: PersonsService, reply: ReplyService): express.Router {
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
        ...(typeof u.look === "string" && u.look.trim() ? { look: u.look.trim() } : {}),
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

  // Writes the appearance note of a persona from their avatar (or, with no
  // avatar to look at, from the persona description). The answer is the text —
  // the dialog shows it and the user saves it.
  router.post("/:id/look", async (req, res) => {
    const id = String(req.params.id);
    if (!persons.isValidId(id)) {
      res.status(400).json({ error: "Invalid ID" });
      return;
    }
    try {
      res.json({ look: await reply.fillLook("person", id) });
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
