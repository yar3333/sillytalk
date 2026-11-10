import fs from "fs";
import { createHash } from "crypto";

// The facts of a picture file — its size, its modification time (ms) and the
// sha256 hex of its bytes. They are how the images table recognises a file the
// user moved OUTSIDE the app (a file nobody's row points at whose extension,
// size and hash match a row whose file is gone is that same picture at a new
// path) and what a disk pick is de-duplicated by.
//
// Two writers need them: the disk sync (which also learns them for files the
// user dropped into a folder) and every place that WRITES a picture of its own
// — a save, an import, a generated picture. The app records them at write time
// for the same reason: a row without them can never be matched to a file and is
// invisible to the de-dup until someone opens the picture browser.
export type PictureFileFacts = {
  fileSize: number;
  fileModifiedAt: number;
  fileHash: string;
};

export class FileFacts {
  // The facts of a file on disk, or null when it cannot be read (gone between
  // the listing and this call, or not readable) — a caller then writes no facts
  // rather than a guess.
  static of(file: string): PictureFileFacts | null {
    try {
      const stat = fs.statSync(file);
      const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return {
        fileSize: stat.size,
        fileModifiedAt: Math.floor(stat.mtimeMs),
        fileHash: hash,
      };
    } catch {
      return null;
    }
  }
}
