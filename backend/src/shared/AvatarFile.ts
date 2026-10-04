import fs from "fs";
import path from "path";

// The avatar file of a domain folder (characters/<id>/ and users/<id>/):
// a single avatar.<ext> whose extension follows the actual format of the
// uploaded image (usually .jpg). The file operations are shared by the
// character and the person services — both folders carry the same file.
// Stateless, so a bunch of statics (there is nothing to inject).
export class AvatarFile {
  static readonly EXTS = ["jpg", "jpeg", "png", "webp", "gif"];

  // The avatar file in the folder (the first existing candidate), null when absent.
  static find(dir: string): string | null {
    for (const ext of AvatarFile.EXTS) {
      const file = path.join(dir, `avatar.${ext}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  // Saves the avatar from an image data URL, removing the other extensions
  // (a re-upload in another format leaves exactly one file). Throws when the
  // payload is not an image data URL.
  static save(dir: string, dataUrl: string): void {
    const match = /^data:image\/(jpeg|png|webp|gif);base64,([\w+/=\s]+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected an image data URL (jpeg/png/webp/gif)");
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    fs.mkdirSync(dir, { recursive: true });
    for (const e of AvatarFile.EXTS) {
      if (e === ext) continue;
      const old = path.join(dir, `avatar.${e}`);
      if (fs.existsSync(old)) fs.rmSync(old);
    }
    fs.writeFileSync(path.join(dir, `avatar.${ext}`), Buffer.from(match[2].replace(/\s/g, ""), "base64"));
  }

  // Removes every avatar.<ext> in the folder; returns whether anything was deleted.
  static delete(dir: string): boolean {
    let deleted = false;
    for (const ext of AvatarFile.EXTS) {
      const file = path.join(dir, `avatar.${ext}`);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        deleted = true;
      }
    }
    return deleted;
  }
}
