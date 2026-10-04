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
  };

  // Streams the file to the response (404 when it does not exist). The
  // explicit stream with a fixed Content-Type — not res.sendFile — is
  // deliberate: sendFile threw NotFoundError for these files.
  static sendImage(res: express.Response, file: string): void {
    if (!fs.existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      HttpHelper.IMAGE_CONTENT_TYPE[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    fs.createReadStream(file).pipe(res);
  }
}
