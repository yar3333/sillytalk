import express from "express";
import fs from "fs";
import path from "path";

// The shared HTTP helpers of the routes layer (not a domain): streaming a
// local file to the client with the right Content-Type. Kept out of the
// services on purpose — they stay persistence- and HTTP-agnostic.
// Stateless, so a bunch of statics (there is nothing to inject).
export class HttpHelper {
  private static readonly IMAGE_CONTENT_TYPE: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
  };

  // Whether the file name ends in a format the app serves as a picture. Every
  // file response goes through sendImage, which refuses anything else: a
  // picture route must not turn into a reader of whatever else sits next to the
  // pictures (a chat.json, a *.png.json sidecar, a character.json).
  static isImage(file: string): boolean {
    return Object.hasOwn(HttpHelper.IMAGE_CONTENT_TYPE, path.extname(file).toLowerCase());
  }

  // Streams the file to the response (404 when it is not a picture format or
  // does not exist). The explicit stream with a fixed Content-Type — not
  // res.sendFile — is deliberate: sendFile threw NotFoundError for these files.
  static sendImage(res: express.Response, file: string): void {
    const contentType = HttpHelper.isImage(file)
      ? HttpHelper.IMAGE_CONTENT_TYPE[path.extname(file).toLowerCase()]
      : undefined;
    if (!contentType || !fs.existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", contentType);
    fs.createReadStream(file).pipe(res);
  }
}
