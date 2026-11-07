import express from "express";
import { PathHelper } from "../shared/PathHelper";
import { PictureLibraryService } from "./PictureLibraryService";

// The /pictures routes: the picture browser — every picture of the data folder
// with what the images table says about it, and the two things the browser lets
// the user do with one: edit its description/prompt/references, and rename it
// (which, an id being a path, is a real file rename with the cards following it).
//
// The picture id is a path, so it never goes into the URL — the id travels in
// the body, which also keeps this free of any encoding rules for a value that
// legitimately contains "/" and ".".
//
// The thin HTTP layer only: parsing, validation, status codes. The rules of what
// a picture may be named and what follows a rename are in the service.
export function createPicturesRouter(library: PictureLibraryService): express.Router {
  const router = express.Router();

  // A list of picture ids from the body, with anything that is not one of them
  // dropped rather than rejected: a half-parsed list is still an edit of the
  // rest of it.
  function idList(v: unknown): string[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }

  router.get("/", (_req, res) => {
    res.json({ pictures: library.browse() });
  });

  router.patch("/", (req, res) => {
    const { id, description, prompt, refs, depicts } = req.body ?? {};
    if (typeof id !== "string" || !PathHelper.resolvePictureId(id)) {
      res.status(400).json({ error: "Unknown picture" });
      return;
    }
    for (const [name, value] of [
      ["description", description],
      ["prompt", prompt],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        res.status(400).json({ error: `Expected ${name} (string)` });
        return;
      }
    }
    const lists: Record<string, string[] | undefined> = { refs: idList(refs), depicts: idList(depicts) };
    if ((refs !== undefined && lists.refs === undefined) || (depicts !== undefined && lists.depicts === undefined)) {
      res.status(400).json({ error: "Expected a list of picture ids" });
      return;
    }
    if (lists.refs) {
      for (const ref of lists.refs) {
        if (!PathHelper.resolveImageId(ref)) {
          res.status(400).json({ error: `Unknown picture "${ref}"` });
          return;
        }
      }
    }
    const picture = library.edit(id, {
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof prompt === "string" ? { prompt } : {}),
      ...(lists.refs ? { refs: lists.refs } : {}),
      ...(lists.depicts ? { depicts: lists.depicts } : {}),
    });
    if (!picture) {
      res.status(404).json({ error: `Unknown picture "${id}"` });
      return;
    }
    res.json({ picture });
  });

  // Renames a picture: the file moves, its row moves with it, and every chat
  // card and reference list that named the old path now names the new one.
  router.post("/rename", (req, res) => {
    const { id, newId } = req.body ?? {};
    if (typeof id !== "string" || typeof newId !== "string" || !newId.trim()) {
      res.status(400).json({ error: "id and newId are required" });
      return;
    }
    if (!PathHelper.resolvePictureId(id)) {
      res.status(400).json({ error: "Unknown picture" });
      return;
    }
    try {
      const picture = library.rename(id, newId.trim());
      if (!picture) {
        res.status(404).json({ error: `Unknown picture "${id}"` });
        return;
      }
      res.json({ picture });
    } catch (err) {
      // The service says why the name is not usable (already taken, not a
      // picture path) — the banner can show it as it is.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
