#!/usr/bin/env node
// Decides which of the re-taken e2e screenshots really changed.
//
// A Playwright run rewrites every screenshot it touches, and the files come out
// different every time even when the screen shows the same thing: Chromium's PNG
// encoder is not reproducible (the same pixels arrive in a different number of
// IDAT chunks with different compressed bytes), and the screen itself carries
// content that changes by itself — a nameless chat is titled by its creation
// date, a message line carries its time. So "git says modified" says nothing,
// and this tool asks the question that matters: are the PIXELS different?
//
//   node scripts/discard-unchanged-screenshots.mjs [options]
//
//   --max-diff <percent>  how much of the picture may differ and still count as
//                         the same screenshot. Default 0.2, the measured noise
//                         floor of this suite: two runs of the SAME build differ
//                         by 0.015% (a caret) up to 0.08% on the text-heavy
//                         screens, while a real UI change here starts at ~2%.
//                         0 demands identical pixels; go above ~1 only to clear
//                         a baseline committed by another Chromium build (its
//                         glyph antialiasing moves every screenshot by ~1%), and
//                         look at the difference pictures before you do.
//                         The report prints the numbers of every file — read
//                         them before raising this.
//   --dry-run             report only, touch nothing.
//   --diffs [dir]         where the pictures of the difference go: every file
//                         that differs at all gets one — the kept ones AND the
//                         restored ones, so a judgement under the limit can be
//                         looked at instead of trusted. Changed pixels are
//                         painted magenta over the dimmed new screenshot.
//                         Default dir: .qwen/tmp/shot-diffs
//   --no-diffs            write none of them
//   --strict              an unreadable picture is an error, not a skip
//
// A file judged unchanged is restored from HEAD, the index with it: the noise is
// often staged by an earlier "add everything", and restoring only the working
// copy would leave it in `git status` all the same. A staged change of the index
// whose pixels differ from HEAD is the user's own work and is never touched.
//
// The pixel reader is a small PNG decoder over node:zlib covering what
// Playwright writes: 8-bit non-interlaced RGB / RGBA. Anything else (a palette,
// 16-bit, an interlaced scanline layout) is reported as not comparable and left
// alone — the tool never restores a file it could not read.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const shotsDir = path.join(repoRoot, "e2e", "screenshots");
const defaultDiffDir = path.join(repoRoot, ".qwen", "tmp", "shot-diffs");

// ---- the command line ----

function readOptions(argv) {
  const options = { maxDiff: 0.2, dryRun: false, strict: false, diffDir: defaultDiffDir };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--no-diffs") options.diffDir = null;
    else if (arg === "--diffs") options.diffDir = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : defaultDiffDir;
    else if (arg === "--max-diff") options.maxDiff = Number(argv[++i]);
    else if (arg.startsWith("--max-diff=")) options.maxDiff = Number(arg.slice("--max-diff=".length));
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.maxDiff) || options.maxDiff < 0 || options.maxDiff > 100) {
    console.error("--max-diff wants a percentage between 0 and 100");
    process.exit(2);
  }
  return options;
}

const options = readOptions(process.argv.slice(2));

function git(gitArgs, gitOptions = {}) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: gitOptions.text ? "utf-8" : "buffer",
    ...gitOptions,
  });
}

// ---- reading the pixels of a PNG ----

// The Paeth predictor of the PNG filter algorithm, straight from the spec.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// The raw pixels of a PNG, or null when this reader cannot decode it.
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let ihdr = null;
  const idat = [];
  let done = false;
  let p = 8;
  while (!done && p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") done = true;
    p += 12 + len;
  }
  if (!ihdr || !done) return null;
  if (ihdr.interlace !== 0 || ihdr.bitDepth !== 8) return null;
  const channels = { 2: 3, 6: 4 }[ihdr.colorType];
  if (!channels) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const { width, height } = ihdr;
  const rowBytes = width * channels;
  if (raw.length < height * (rowBytes + 1)) return null;

  // Un-filter the scanlines: every row is stored as a filter byte plus the
  // differences, and the Sub / Up / Average / Paeth filters rebuild it from the
  // pixel to its left and the row above.
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) return null;
    const from = y * (rowBytes + 1) + 1;
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const above = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[from + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = above ? above[x] : 0;
      const upLeft = above && x >= channels ? above[x - channels] : 0;
      let sum;
      switch (filter) {
        case 0:
          sum = value;
          break;
        case 1:
          sum = value + left;
          break;
        case 2:
          sum = value + up;
          break;
        case 3:
          sum = value + ((left + up) >> 1);
          break;
        default:
          sum = value + paeth(left, up, upLeft);
          break;
      }
      row[x] = sum & 0xff; // the filters work on bytes, wrapping past 255
    }
  }
  return { width, height, channels, data: out };
}

// ---- writing one (only the difference picture needs an encoder) ----

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const byte of body) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}

// A truecolor PNG with no filtering — enough for a picture made to be looked at.
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- comparing two pictures ----

// A pixel counts as different when one of its channels moved more than this.
// Below it the difference is the dithering of a curve that no eye follows.
const DELTA = 8;

function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { pixels: a.width * a.height, changed: a.width * a.height, maxDelta: 255, bbox: null, resized: true };
  }
  let changed = 0;
  let maxDelta = 0;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * a.channels;
      let delta = 0;
      for (let c = 0; c < a.channels; c++) delta = Math.max(delta, Math.abs(a.data[i + c] - b.data[i + c]));
      if (delta <= DELTA) continue;
      changed += 1;
      if (delta > maxDelta) maxDelta = delta;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const pixels = a.width * a.height;
  const bbox = changed > 0 ? { minX, minY, maxX, maxY } : null;
  return { pixels, changed, maxDelta, bbox, resized: false };
}

// The difference as a picture: the new screenshot dimmed, every differing pixel
// painted magenta, so a small but real change is findable in one look.
function differencePicture(committed, current) {
  const { width, height } = current;
  const sameSize = committed.width === width && committed.height === height;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < width * height; i++, o += 3) {
    const src = i * current.channels;
    let differs = !sameSize;
    if (!differs) {
      const ref = i * committed.channels;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(committed.data[ref + c] - current.data[src + c]) > DELTA) differs = true;
      }
    }
    if (differs) {
      rgb[o] = 255;
      rgb[o + 1] = 0;
      rgb[o + 2] = 255;
    } else {
      rgb[o] = current.data[src] >> 1;
      rgb[o + 1] = current.data[src + 1] >> 1;
      rgb[o + 2] = current.data[src + 2] >> 1;
    }
  }
  return encodePng(width, height, rgb);
}

// The pixels of a git object of a file (HEAD or the index), null when it is not
// in that revision.
function pixelsFromGit(revisionPath) {
  let blob;
  try {
    blob = git(["show", revisionPath], { maxBuffer: 1 << 28 });
  } catch {
    return null;
  }
  return decodePng(blob);
}

// ---- which pictures git thinks are modified ----

// Tracked pictures with a changed index entry or a changed working copy. A new
// screenshot (untracked, or staged as added) is a real addition nobody has
// looked at yet, and a deleted one is the user's decision: neither is touched.
function changedPictures() {
  const out = git(["status", "--porcelain=v1", "-z", "--", "e2e/screenshots"], { text: true });
  const fields = out.split("\0").filter((field) => field !== "");
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const status = field.slice(0, 2);
    const file = field.slice(3);
    if (status[0] === "R" || status[0] === "C") i += 1; // a rename carries its target as an extra field
    if (!file.toLowerCase().endsWith(".png")) continue;
    if (status === "??") continue;
    if (status.includes("D") || status[0] === "A") continue;
    if (!status.includes("M")) continue;
    entries.push({ status, file });
  }
  return entries;
}

// ---- the decision ----

function describe(diff) {
  if (diff.resized) return "a different picture size";
  const box = diff.bbox ? ` y ${diff.bbox.minY}–${diff.bbox.maxY} x ${diff.bbox.minX}–${diff.bbox.maxX}` : "";
  return `${diff.changed} of ${diff.pixels} px (${((diff.changed * 100) / diff.pixels).toFixed(3)}%, max Δ${diff.maxDelta})${box}`;
}

function main() {
  const changed = changedPictures();
  if (changed.length === 0) {
    console.log("e2e/screenshots: git sees no modified picture.");
    return;
  }
  if (options.diffDir) fs.mkdirSync(options.diffDir, { recursive: true });
  console.log(`${changed.length} modified picture(s); the limit is ${options.maxDiff}% of differing pixels.\n`);
  let restored = 0;
  let kept = 0;
  let unreadable = 0;
  for (const entry of changed) {
    const onDisk = path.join(repoRoot, entry.file);
    const current = fs.existsSync(onDisk) ? decodePng(fs.readFileSync(onDisk)) : null;
    const committed = pixelsFromGit(`HEAD:${entry.file}`);
    if (!current || !committed) {
      const why = !current ? "the working copy is not a readable PNG" : "no committed PNG to compare with";
      console.log(`kept   ${entry.file} — ${why}`);
      kept += 1;
      unreadable += 1;
      if (options.strict) {
        console.error(`--strict: ${entry.file}: ${why}`);
        process.exitCode = 1;
      }
      continue;
    }
    const diff = compare(committed, current);
    const within = diff.changed <= (diff.pixels * options.maxDiff) / 100;
    // A picture of the difference is written for EVERY file that differs at all
    // — including the ones judged unchanged and restored: a difference under the
    // limit is a decision this tool made, and the user should be able to look at
    // it rather than trust it.
    let where = "";
    if (options.diffDir && diff.changed > 0) {
      const target = path.join(options.diffDir, path.basename(entry.file));
      fs.writeFileSync(target, differencePicture(committed, current));
      where = `, the difference in ${path.relative(repoRoot, target)}`;
    }
    if (!within) {
      console.log(`KEPT   ${entry.file} — ${describe(diff)}${where}`);
      kept += 1;
      continue;
    }
    // The pixels are the committed ones. A staged row whose own pixels differ
    // from HEAD is a change the user made on purpose (they staged a refreshed
    // screenshot) — even if the new run drew the old picture again, that is
    // theirs to keep, not noise to clean.
    const staged = pixelsFromGit(`:${entry.file}`);
    const stagedIsReal =
      staged && compare(committed, staged).changed > (committed.width * committed.height * options.maxDiff) / 100;
    if (stagedIsReal) {
      console.log(`KEPT   ${entry.file} — a real change is STAGED; the run drew the committed picture again`);
      kept += 1;
      continue;
    }
    if (options.dryRun) {
      console.log(`clean  ${entry.file} — ${describe(diff)} ≤ the limit, would be restored`);
    } else {
      git(["checkout", "HEAD", "--", entry.file]);
      console.log(`clean  ${entry.file} — ${describe(diff)}, restored from HEAD`);
    }
    restored += 1;
  }
  console.log(
    `\n${restored} ${options.dryRun ? "would be restored" : "restored"}, ${kept} kept${unreadable ? ` (${unreadable} not readable by this tool)` : ""}.`,
  );
  if (!options.dryRun && restored > 0) {
    console.log("The restored files are back to the committed pixels; `git status` should no longer list them.");
  }
}

// Run when started as a program; stay a plain module when imported.
const startedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (startedDirectly) main();

export { decodePng, encodePng, compare, pixelsFromGit, shotsDir, DELTA };
