import fs from "fs";
import os from "os";
import path from "path";
import { Writable } from "stream";
import express from "express";
import { HttpHelper } from "./HttpHelper";
import { PathHelper } from "./PathHelper";

// Same isolation as everywhere else: the data root of this suite is a temp
// folder, not the real ~/.config/sillytalk.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-http-"));
process.env.SILLYTALK_DATA_DIR = dataRoot;

// The response stand-in: a real writable stream (sendImage pipes into it) that
// also records the status code and the headers a route would set.
class FakeResponse extends Writable {
  code: number | undefined;
  readonly headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];

  status(code: number): this {
    this.code = code;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  override _write(chunk: Buffer, _enc: unknown, done: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function send(file: string): Promise<FakeResponse> {
  const res = new FakeResponse();
  HttpHelper.sendImage(res as unknown as express.Response, file);
  return new Promise((resolve) => res.on("close", () => resolve(res)));
}

function writePicture(rel: string, bytes: number[] = [1, 2, 3]): string {
  const file = path.join(dataRoot, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

describe("HttpHelper.isImage", () => {
  it("knows the formats the app serves as pictures", () => {
    for (const name of ["a.png", "a.jpg", "a.JPEG", "a.webp", "a.gif", "a.bmp", "a.avif"]) {
      expect(HttpHelper.isImage(name)).toBe(true);
    }
  });

  it("is not an image for any other name", () => {
    for (const name of ["config.json", "a.png.json", "a.svg", "chat.json.migrated", "chats.db", "noext"]) {
      expect(HttpHelper.isImage(name)).toBe(false);
    }
  });
});

describe("HttpHelper.sendImage", () => {
  it("streams a picture with its content type", async () => {
    const file = writePicture("chats/c1/files/a-boat-1a2b3c.png", [9, 8, 7, 6]);
    const res = await send(file);
    expect(res.code).toBeUndefined();
    expect(res.headers["Content-Type"]).toBe("image/png");
    expect(Buffer.concat(res.chunks)).toEqual(Buffer.from([9, 8, 7, 6]));
  });

  it("refuses a name that is not a picture format, even when the file exists", async () => {
    // A leftover sidecar of the old format sits next to the picture and the chat
    // files hold the whole dialogue — a picture route must not hand them out.
    const sidecar = writePicture("chats/c1/files/a-boat-1a2b3c.png.json", [123]);
    const res = await send(sidecar);
    expect(res.code).toBe(404);
    expect(res.chunks).toHaveLength(0);
  });

  it("404s a picture that is not there", async () => {
    const res = await send(path.join(PathHelper.chatDir("c1"), "gone.png"));
    expect(res.code).toBe(404);
    expect(res.chunks).toHaveLength(0);
  });
});
