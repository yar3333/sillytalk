import fs from "fs";
import path from "path";
import { ImageMeta } from "./ImageMeta";
import { PathHelper } from "./PathHelper";

// The sidecar *.json next to an image file: the description of what is on it
// and the data needed to generate it again (the prompt + the reference images).
// Stateless statics, like AvatarFile — the file belongs to the image, not to a
// chat, so the same helper serves the chat files, an imported character photo
// and anything else the user drops into the data folder.
//
// The canonical name is "<image file>.json" ("a-sunset-3f2a1c.png.json"). On
// read "<image base>.json" ("a-sunset-3f2a1c.json") is accepted too, so a file
// the user saved by hand under the shorter name is still found; writes always
// go to the canonical name (and remove the short one, so the two never
// disagree).
//
// A sidecar is a user-editable file, so it is treated as untrusted input:
// a missing or unparsable one reads as "no metadata" (never an exception that
// would break the whole chat), unknown fields are kept, and the known ones are
// type-checked on the way in.
export class ImageMetaFile {
  // The sidecar path of an image (the canonical one — where writes go).
  static pathFor(imagePath: string): string {
    return `${imagePath}.json`;
  }

  // Reads the sidecar of an image, or null when there is none (or it does not
  // parse). Both candidate names are tried, the canonical one first.
  static read(imagePath: string): ImageMeta | null {
    for (const candidate of ImageMetaFile.candidates(imagePath)) {
      const meta = ImageMetaFile.readOne(candidate);
      if (meta) return meta;
    }
    return null;
  }

  // Merges `patch` into the existing sidecar and writes it back, keeping the
  // fields (including the user's own) that the patch does not touch. An
  // explicit undefined in the patch removes the key. Returns the stored meta.
  //
  // The sidecar is written next to the image, so the image folder is created
  // when missing — a description saved before the file itself exists (a pending
  // generation) would otherwise be lost.
  static write(imagePath: string, patch: ImageMeta): ImageMeta {
    const target = ImageMetaFile.pathFor(imagePath);
    const merged: ImageMeta = { ...(ImageMetaFile.read(imagePath) ?? {}), ...patch };
    const now = new Date().toISOString();
    merged.updatedAt = now;
    if (!merged.createdAt) merged.createdAt = now;
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(merged, null, 2));
    // The short alias, if the user kept one, would shadow nothing but could
    // drift — drop it so there is exactly one source of truth.
    const alias = ImageMetaFile.aliasFor(imagePath);
    if (fs.existsSync(alias)) fs.rmSync(alias, { force: true });
    return merged;
  }

  // Removes the sidecar (with the image itself).
  static delete(imagePath: string): void {
    for (const candidate of ImageMetaFile.candidates(imagePath)) {
      fs.rmSync(candidate, { force: true });
    }
  }

  // Renames a sidecar along with its image: the metadata (the prompt, the
  // references, the description) belongs to the picture, not to the file name.
  // Missing source — nothing to move (a pending image has no sidecar yet).
  static move(fromImage: string, toImage: string): ImageMeta | null {
    const meta = ImageMetaFile.read(fromImage);
    if (!meta) return null;
    ImageMetaFile.write(toImage, meta);
    ImageMetaFile.delete(fromImage);
    return meta;
  }

  // Copies a sidecar onto another image (an imported photo keeping its
  // description). Returns the copied meta, or null when there was nothing to
  // copy.
  static copy(fromImage: string, toImage: string): ImageMeta | null {
    const meta = ImageMetaFile.read(fromImage);
    if (!meta) return null;
    ImageMetaFile.write(toImage, meta);
    return meta;
  }

  // A cheap change-detection key for the sidecar of an image (size + mtime of
  // both candidates). A reader that is called again and again — the chat poll —
  // can skip re-reading and re-parsing the file while the key is unchanged, and
  // still picks up a hand edit the moment it lands.
  static signature(imagePath: string): string {
    return ImageMetaFile.candidates(imagePath)
      .map((file) => {
        try {
          const st = fs.statSync(file);
          return `${st.size}:${Math.round(st.mtimeMs)}`;
        } catch {
          return "-";
        }
      })
      .join("|");
  }

  // ---- internals ----

  private static candidates(imagePath: string): string[] {
    return [ImageMetaFile.pathFor(imagePath), ImageMetaFile.aliasFor(imagePath)];
  }

  // The short alias: "a-cat.png" -> "a-cat.json".
  private static aliasFor(imagePath: string): string {
    return `${imagePath.slice(0, imagePath.length - path.extname(imagePath).length)}.json`;
  }

  private static readOne(file: string): ImageMeta | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return ImageMetaFile.sanitize(parsed);
    } catch {
      // A half-saved or hand-mangled file is not a reason to break the chat.
      return null;
    }
  }

  // Keeps the object as it is (the unknown keys must survive) but drops the
  // known fields whose value has the wrong type — a string where a number
  // belongs would otherwise reach the generator.
  private static sanitize(value: unknown): ImageMeta | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const meta = { ...(value as ImageMeta) };
    for (const key of ["name", "description", "prompt", "negativePrompt", "generator", "model", "createdAt", "updatedAt"] as const) {
      if (meta[key] !== undefined && typeof meta[key] !== "string") delete meta[key];
    }
    for (const key of ["width", "height", "steps"] as const) {
      const n = meta[key];
      if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n))) delete meta[key];
    }
    if (meta.refs !== undefined) {
      if (!Array.isArray(meta.refs)) {
        delete meta.refs;
      } else {
        // Only the ids that resolve inside the data folders; a path pointing
        // elsewhere is dropped rather than passed to the generator.
        const refs = (meta.refs as unknown[])
          .filter((r): r is string => typeof r === "string")
          .filter((r) => PathHelper.resolveImageId(r) !== null);
        if (refs.length > 0) meta.refs = refs;
        else delete meta.refs;
      }
    }
    if (meta.source !== "upload" && meta.source !== "manual" && meta.source !== "auto") delete meta.source;
    return meta;
  }
}
