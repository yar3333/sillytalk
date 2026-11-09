import { createHash } from "crypto";

// Decodes an image data URL once, for the places that write a picked file to
// disk (the avatar of an entity, the picture a card is pointed at). The bytes
// and their sha256 come back together, because a disk pick is de-duplicated by
// content: the caller hashes what the user chose and reuses the picture that is
// already in a data folder instead of writing a second copy of it.
// Stateless, so a static (there is nothing to inject).
export class DataUrl {
  // `data:image/<fmt>;base64,<b64>` -> the bytes, the file extension (with the
  // dot, ".jpg" for jpeg) and the sha256 hex of the content. Throws when the
  // payload is not an image data URL.
  static image(dataUrl: string): { buffer: Buffer; ext: string; hash: string } {
    const match = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([\w+/=\s]+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected an image data URL (jpeg/png/webp/gif)");
    const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    const fmt = match[1];
    const ext = fmt === "jpeg" ? ".jpg" : `.${fmt}`;
    const hash = createHash("sha256").update(buffer).digest("hex");
    return { buffer, ext, hash };
  }
}
