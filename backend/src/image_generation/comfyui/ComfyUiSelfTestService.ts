import fs from "fs";
import path from "path";
import { deflateSync } from "zlib";
import { ComfyUiLora, ComfyUiOrientation, ComfyUiSettings } from "../../configuration/ComfyUiSettings";
import { PathHelper } from "../../shared/PathHelper";
import { ComfyUiDriver, ComfyUiPluginHealth, ComfyUiPluginModel } from "../drivers/ComfyUiDriver";

// The ComfyUI self-test: `sillytalk test-comfyui <url>`.
//
// It answers one question in the order the answers get expensive: can this
// server draw pictures for this app, and what exactly stops it if it cannot.
// The order is the diagnosis — a server that is not there makes the plugin
// question meaningless, and a server without the plugin makes the draws
// meaningless, so each step only runs when the one before it passed.
//
//   1. GET /system_stats      — the server is up, and here is its hardware
//   2. GET /sillytalk/health  — the plugin is on it, and here is what it sees
//   3. GET /sillytalk/models  — here is what it can draw and what each takes
//   4. POST /sillytalk/generate — one real picture per model and per reference
//                                 count, each checked on disk afterwards
//
// What is NOT checked any more used to be the point of this file: the app's own
// workflow files, the converter endpoint, the PARAM_* placeholders, the node
// classes and model file names of a graph. All of that moved into the plugin,
// which validates the graph before it queues it and says in the job's error what
// is missing. Re-deriving it here would mean keeping a second copy of the
// knowledge the inversion was meant to remove.

export type ComfyUiSelfTestStatus = "ok" | "failed" | "skipped";

export interface ComfyUiSelfTestOptions {
  /** The ComfyUI server — a bare host:port is taken as http://. */
  url: string;
  /** Only these model codes (default: everything the server offers). */
  models?: string[];
  /** Which way the test pictures stand (default: each model's own). */
  orientation?: ComfyUiOrientation;
  /** The diffusion file to draw with, instead of the workflow's default. */
  modelFile?: string;
  /** The LoRAs to merge, in order. */
  loras?: ComfyUiLora[];
  /** The prompt of the test pictures. */
  prompt?: string;
  /** Where the test pictures go (default `<data root>/comfyui-test`). */
  outDir?: string;
  /** Draw the reference variants too (false = the plain text prompt only). */
  withRefs?: boolean;
  /** Draw at all (false = the checks only). */
  draw?: boolean;
}

/** One draw of the run: what was asked for, and what came back. */
export interface ComfyUiSelfTestItem {
  model: string;
  refs: number;
  status: ComfyUiSelfTestStatus;
  /** The picture on disk (only when there was one to write). */
  file?: string;
  /** The size the file itself says it has, when it is a readable picture. */
  image?: { format: string; width?: number; height?: number };
  /** The orientation that was sent, and the file and LoRAs the server used. */
  orientation?: ComfyUiOrientation;
  modelFile?: string;
  loras?: string[];
  seconds?: number;
  /** Where the model loaders of this draw landed, as the server reported it. */
  placement?: string;
  /** What the user can do about this one. */
  advice?: string;
  error?: string;
}

export interface ComfyUiSelfTestReport {
  /** True when nothing failed. */
  ok: boolean;
  url: string;
  /** The ComfyUI version, when the server answered. */
  comfyui?: string;
  /** The plugin version, when the plugin answered. */
  plugin?: string;
  /** One sentence the run ends on. */
  summary: string;
  /** What the server says it can draw (unusable workflows included, as problems). */
  models: ComfyUiPluginModel[];
  /** Every problem found, in the order the run met them. */
  problems: string[];
  items: ComfyUiSelfTestItem[];
}

export type ComfyUiSelfTestLog = (line: string) => void;

const DEFAULT_PROMPT = "a red apple on a wooden table, studio light, sharp focus";
const STATS_TIMEOUT_MS = 15_000;
// A picture of the size the user asked for, on a server that may be loading a
// model for the first time: the driver's own timeout decides when a job is
// given up, this one only bounds the probes.
const HEALTH_TIMEOUT_MS = 20_000;
// The two reference pictures are made here rather than shipped with the app:
// any recognizable content will do, and 512 px keeps the reference variants of a
// draw from costing more than the plain one.
const REFERENCE_SIZE = 512;

export class ComfyUiSelfTestService {
  private ctrl: AbortController | null = null;

  // Set once a request failed at the connection level rather than over a job:
  // the server's process is gone, and every draw after it would fail the same
  // way — on a ROCm box, pushing another prompt into a dying server is often
  // what finishes it off. The run says so once and stops trying.
  private serverGone = false;

  /** Stops the run in flight: the current job is cancelled on the server too. */
  cancel(): void {
    this.ctrl?.abort();
  }

  async run(options: ComfyUiSelfTestOptions, log: ComfyUiSelfTestLog = (line) => console.log(line)): Promise<ComfyUiSelfTestReport> {
    const started = Date.now();
    const report: ComfyUiSelfTestReport = { ok: true, url: options.url, summary: "", models: [], problems: [], items: [] };
    const driver = this.driverFor({ url: options.url, model: options.models?.[0] ?? "" });

    log(`ComfyUI self-test against ${options.url}`);

    // ---- 1. the server ----
    let stats;
    try {
      stats = await driver.systemStats(STATS_TIMEOUT_MS);
    } catch (err) {
      const why = (err as Error).message;
      report.ok = false;
      report.summary = `The ComfyUI server at ${options.url} did not answer.`;
      report.problems.push(`${report.summary} ${why}`);
      log(`  ✗ ${report.summary}`);
      log(`    ${why}`);
      log("    Start ComfyUI on that address, or point the test at the one that runs:");
      log("    python main.py --listen 0.0.0.0 --port 8188");
      return report;
    }
    report.comfyui = stats?.system?.comfyui_version ?? "";
    log(`  ✓ ComfyUI ${report.comfyui || "(version unknown)"}`);
    ComfyUiSelfTestService.logDevices(log, stats);

    // ---- 2. the plugin ----
    let health: ComfyUiPluginHealth;
    try {
      health = await driver.pluginHealth(HEALTH_TIMEOUT_MS);
    } catch (err) {
      const why = (err as Error).message;
      report.ok = false;
      report.summary = why;
      report.problems.push(why);
      log(`  ✗ ${why}`);
      return report;
    }
    report.plugin = health.version ?? "";
    log(`  ✓ comfyui-sillytalk ${report.plugin || "(version unknown)"} on ComfyUI ${health.comfyui_version ?? "?"}`);
    for (const broken of health.broken_workflows ?? []) {
      report.ok = false;
      const line = `the workflow "${broken.code}" of the server is unusable: ${broken.error}`;
      report.problems.push(line);
      log(`  ✗ ${line}`);
    }
    if (health.devices?.length) {
      log("    what the plugin can place models on:");
      for (const d of health.devices) {
        log(
          `      ${d.device} (${d.name ?? "?"}): ${d.vram_free_mb ?? "?"} MiB free of ${d.vram_total_mb ?? "?"} MiB` +
            `${d.vram_reclaimable_mb ? `, ${d.vram_reclaimable_mb} MiB of it its own cache` : ""}`,
        );
      }
    }
    for (const resident of health.resident_models ?? []) {
      log(`      resident: ${resident.model} on ${resident.device} (${resident.mb} MiB)`);
    }

    // ---- 3. the catalogue ----
    const models = await driver.pluginModels(HEALTH_TIMEOUT_MS);
    report.models = models;
    if (!models.length) {
      report.ok = false;
      report.summary = `The plugin on ${options.url} has no usable workflow in its catalogue.`;
      report.problems.push(`${report.summary} Its folder is ${health.workflow_dir ?? "the plugin's workflows/"} — ` +
        `put a <model-code>.json there (see the plugin's README).`);
      log(`  ✗ ${report.summary}`);
      return report;
    }
    log(`  ✓ it draws:`);
    for (const m of models) {
      const sizes = Object.entries(m.sizes ?? {})
        .map(([name, wh]) => `${name} ${wh?.[0]}×${wh?.[1]}`)
        .join(", ");
      log(`      ${m.code}: ≤${m.max_refs} refs${sizes ? `, ${sizes}` : ""}`);
      const files = m.model_files?.options.length ?? 0;
      log(
        `        model file: ${m.model_file ? `${path.basename(m.model_file)} (${files} in the server's folder to choose from)` : "fixed by the workflow"}`,
      );
      const slots = m.loras?.max ?? 0;
      log(
        `        loras: ${slots ? `${slots} slot(s), ${m.loras?.options.length ?? 0} file(s) in models/loras/` : "this workflow has no LoRA slots"}`,
      );
    }

    // ---- 4. the draws ----
    const draw = options.draw !== false;
    const wanted = options.models?.length ? models.filter((m) => options.models!.includes(m.code)) : models;
    if (!wanted.length) {
      const unknown = options.models!.filter((name) => !models.some((m) => m.code === name));
      report.ok = false;
      const line = `the server does not offer: ${unknown.join(", ")} (it offers ${models.map((m) => m.code).join(", ")})`;
      report.problems.push(line);
      log(`  ✗ ${line}`);
      return report;
    }

    // A file the server has not got is answered precisely by the server — but
    // six identical failures are a poor way to learn a name was mistyped, so it
    // is said once here, against the catalogue the server just published.
    const missing = ComfyUiSelfTestService.missingFiles(wanted, options);
    if (missing.length) {
      report.ok = false;
      for (const line of missing) {
        report.problems.push(line);
        log(`  ✗ ${line}`);
      }
      // Not every problem here is a missing file — asking a workflow with no
      // slots for a LoRA is one too — so the line says what was refused instead
      // of sending the reader to a folder that does contain the file.
      report.summary =
        `The run was not started: ${missing.length} of what was asked for is not in what this server offers.`;
      return report;
    }

    if (!draw) {
      log("");
      log("--draw was off, so nothing was generated. The server, the plugin and its catalogue answered.");
      report.summary = `ComfyUI ${report.comfyui} with comfyui-sillytalk ${report.plugin} at ${options.url}: ${wanted.length} model(s) ready.`;
      return report;
    }

    const outDir = options.outDir ?? path.join(PathHelper.configDir(), "comfyui-test");
    fs.mkdirSync(outDir, { recursive: true });
    const refs = ComfyUiSelfTestService.referencePictures(outDir, log);
    this.serverGone = false;
    log("");
    log(`Drawing one picture per model and reference count into ${outDir}`);

    for (const model of wanted) {
      const counts = options.withRefs === false ? [0] : [...Array(model.max_refs + 1).keys()];
      for (const refCount of counts) {
        if (this.serverGone) {
          log(`  – ${model.code} with ${refCount} references skipped — the server stopped answering`);
          report.items.push({
            model: model.code,
            refs: refCount,
            status: "skipped",
            error: "not tried — the server stopped answering during this run",
          });
          continue;
        }
        if (refCount > 0 && refs.length < refCount) {
          log(`  – ${model.code} with ${refCount} references skipped (only ${refs.length} test pictures could be made)`);
          report.items.push({ model: model.code, refs: refCount, status: "skipped" });
          continue;
        }
        report.items.push(await this.drawOne(options, model, refCount, refs, outDir, log));
      }
    }

    report.ok = report.items.every((item) => item.status !== "failed") && report.ok;
    const drawn = report.items.filter((i) => i.status === "ok").length;
    const failed = report.items.filter((i) => i.status === "failed").length;
    report.summary =
      `${drawn} of ${report.items.length} test picture(s) drawn in ${((Date.now() - started) / 1000).toFixed(0)}s` +
      (failed ? `, ${failed} failed` : "") +
      (this.serverGone ? " — the server died during this run, see its own log." : "") +
      ".";
    return report;
  }

  // One real generation, timed, and the picture checked after it arrived: a
  // server can answer 200 with something that is not a PNG, and a card that is
  // half the size it was asked for is a bug worth catching here rather than in
  // a chat.
  private async drawOne(
    options: ComfyUiSelfTestOptions,
    model: ComfyUiPluginModel,
    refCount: number,
    refs: string[],
    outDir: string,
    log: ComfyUiSelfTestLog,
  ): Promise<ComfyUiSelfTestItem> {
    const label = `${model.code} / ${refCount} reference${refCount === 1 ? "" : "s"}`;
    const file = path.join(outDir, `${model.code.replace(/[^\w.+-]/g, "_")}_${refCount}refs.png`);
    // The server owns the pixel numbers, so the test asks for an orientation and
    // checks the size that came back against the one the server itself published.
    const orientation = options.orientation ?? model.orientation ?? "square";
    const expected = model.sizes?.[orientation];
    const driver = this.driverFor({
      url: options.url,
      model: model.code,
      orientation,
      modelFile: options.modelFile,
      loras: options.loras,
    });
    this.ctrl = new AbortController();
    const began = Date.now();
    log(`  → ${label}`);
    try {
      if (!(await driver.available())) {
        return { model: model.code, refs: refCount, status: "failed", error: driver.unavailableBecause ?? "unavailable" };
      }
      await driver.run(options.prompt ?? DEFAULT_PROMPT, refs.slice(0, refCount), file, (ctrl) => {
        ctrl.signal.addEventListener("abort", () => this.ctrl?.abort());
        this.ctrl?.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
      });
      const seconds = (Date.now() - began) / 1000;
      const image = ComfyUiSelfTestService.imageInfoOf(file);
      if (!image) {
        return {
          model: model.code,
          refs: refCount,
          status: "failed",
          file,
          seconds,
          error: "the server reported the job finished but the file it wrote is not a readable picture",
          advice: "Look at what the server put there — `file` and the first bytes of it usually say.",
        };
      }
      const wrongSize =
        !!expected && !!image.width && !!image.height && (image.width !== expected[0] || image.height !== expected[1]);
      // Which card did the work is the whole point of the plugin, so it belongs
      // in the line the user reads.
      const placement = driver.placements.map((p) => `${p.class}@${p.device}`).join(", ");
      const used = ComfyUiSelfTestService.usedOf(driver);
      log(
        `    ✓ ${seconds.toFixed(1)}s → ${file} (${image.width ?? "?"}×${image.height ?? "?"} ${image.format}, ${orientation})` +
          `${wrongSize && expected ? ` — asked for ${expected[0]}×${expected[1]}` : ""}` +
          `${used ? ` with ${used}` : ""}` +
          `${placement ? ` on ${placement}` : ""}`,
      );
      return {
        model: model.code,
        refs: refCount,
        status: "ok",
        file,
        image,
        seconds,
        orientation,
        placement: placement || undefined,
      };
    } catch (err) {
      const why = (err as Error).message;
      log(`    ✗ ${why}`);
      // A job that failed is the server answering; a request that could not be
      // made at all is a server that is no longer there. The difference decides
      // whether the rest of the run is worth trying.
      if (/ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|aborted/.test(why) && !this.ctrl?.signal.aborted) {
        this.serverGone = true;
        log("    The server went away in the middle of this run — the draws after it are not tried.");
        log("    Its own console (or `journalctl -u <its service> -n 100`) has the reason it died.");
      }
      return { model: model.code, refs: refCount, status: "failed", file: fs.existsSync(file) ? file : undefined, seconds: (Date.now() - began) / 1000, error: why, advice: ComfyUiSelfTestService.adviceOf(why) };
    } finally {
      this.ctrl = null;
    }
  }

  private driverFor(cfg: {
    url: string;
    model: string;
    orientation?: ComfyUiOrientation;
    modelFile?: string;
    loras?: ComfyUiLora[];
  }): ComfyUiDriver {
    const settings: ComfyUiSettings = {
      kind: "comfyui",
      url: cfg.url,
      model: cfg.model,
      orientation: cfg.orientation ?? "square",
      ...(cfg.modelFile ? { modelFile: cfg.modelFile } : {}),
      ...(cfg.loras?.length ? { loras: cfg.loras } : {}),
    };
    return new ComfyUiDriver(settings);
  }

  // What the run asks for that the server's own catalogue says it has not got.
  private static missingFiles(models: ComfyUiPluginModel[], options: ComfyUiSelfTestOptions): string[] {
    const out: string[] = [];
    for (const model of models) {
      const files = model.model_files?.options;
      if (options.modelFile && !files) {
        out.push(`${model.code}: its workflow loads a model file of its own — nothing here to swap for '${options.modelFile}'`);
      } else if (options.modelFile && !files!.some((f) => f.name === options.modelFile)) {
        out.push(`${model.code}: '${options.modelFile}' is not among its ${files!.length} model file(s)`);
      }
      const loras = model.loras?.options ?? [];
      const slots = model.loras?.max ?? 0;
      const loaded = options.modelFile ?? model.model_file ?? "";
      for (const lora of options.loras ?? []) {
        const option = loras.find((f) => f.name === lora.name);
        if (!option) {
          out.push(`${model.code}: '${lora.name}' is not in its models/loras/ (${loras.length} file(s) there)`);
          continue;
        }
        // The server reads the two headers and says so in the catalogue: a LoRA
        // marked "no" would be loaded and skipped tensor by tensor, drawing the
        // picture this file makes without it. Better said here than after a run
        // that reported itself a success.
        const fit = option.fits?.[loaded];
        if (fit?.fits === "no") {
          out.push(`${model.code}: '${lora.name}' would not merge into '${loaded}' — ${fit.reason ?? "the server says it does not fit"}`);
        }
      }
      if ((options.loras?.length ?? 0) > slots) {
        out.push(`${model.code}: it wired ${slots} LoRA slot(s), ${options.loras?.length} were asked for`);
      }
    }
    return out;
  }

  // What the server says it drew with — the file it loaded and the LoRAs it
  // merged. The test asked for them; reading them back off the job is what
  // proves the request was understood rather than ignored.
  private static usedOf(driver: ComfyUiDriver): string {
    const parts: string[] = [];
    if (driver.lastModelFile) parts.push(path.basename(driver.lastModelFile));
    for (const lora of driver.lastLoras) {
      parts.push(`${path.basename(lora.name)}@${lora.strength}`);
    }
    return parts.join(" + ");
  }

  // The GPU lines of /system_stats — the numbers a placement problem is read
  // from, in the same words the plugin uses.
  private static logDevices(log: ComfyUiSelfTestLog, stats: { system?: { os?: string }; devices?: Array<{ name?: string; type?: string; vram_total?: number; vram_free?: number }> }): void {
    if (stats?.system?.os) log(`    ${stats.system.os}`);
    for (const d of stats?.devices ?? []) {
      if (!d?.vram_total) continue;
      const gib = (n: number): string => `${Math.round(n / 1024 / 1024 / 1024)} GiB`;
      log(`    ${d.name ?? d.type ?? "device"}: ${gib(d.vram_total)}${d.vram_free ? `, ${gib(d.vram_free)} free` : ""}`);
    }
  }

  // Two plain pictures to be a reference: a gradient with a square in it, so a
  // model has something to look at and a human can tell which file went where.
  private static referencePictures(outDir: string, log: ComfyUiSelfTestLog): string[] {
    const made: string[] = [];
    for (const [name, hue] of [
      ["reference-1.png", 200],
      ["reference-2.png", 20],
    ] as const) {
      const file = path.join(outDir, name);
      try {
        fs.writeFileSync(file, ComfyUiSelfTestService.syntheticPng(REFERENCE_SIZE, hue));
        made.push(file);
      } catch (err) {
        log(`    could not write ${file}: ${(err as Error).message}`);
      }
    }
    return made;
  }

  // A PNG built here rather than carried in the package: 8 bytes of signature,
  // three chunks, and zlib for the pixels — nothing new to depend on.
  private static syntheticPng(size: number, hue: number): Buffer {
    const rows: Buffer[] = [];
    for (let y = 0; y < size; y++) {
      const row = Buffer.alloc(1 + size * 3); // one filter byte, then RGB
      for (let x = 0; x < size; x++) {
        const inside = x > size / 4 && x < (size * 3) / 4 && y > size / 4 && y < (size * 3) / 4;
        const o = 1 + x * 3;
        row[o] = inside ? hue : Math.round((x / size) * 255);
        row[o + 1] = inside ? 255 - hue : Math.round((y / size) * 255);
        row[o + 2] = inside ? 128 : 160;
      }
      rows.push(row);
    }
    const pixels = deflateSync(Buffer.concat(rows));
    const chunk = (type: string, data: Buffer): Buffer => {
      const out = Buffer.alloc(8 + data.length + 4);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, "ascii");
      data.copy(out, 8);
      out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", pixels),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  /** What a failed draw usually means, in the order the causes are worth checking. */
  private static adviceOf(message: string): string {
    const text = message.toLowerCase();
    if (text.includes("/sillytalk")) {
      return "The plugin is what this app talks to — install comfyui-sillytalk into the server's custom_nodes/ and restart it.";
    }
    if (text.includes("no card has that much") || text.includes("vram") || text.includes("out of memory")) {
      return (
        "The card ran out of room. Free one (stop the other job or the server that holds a model), ask for a " +
        "smaller size, or spread the workflow over more cards with the plugin's SILLYTALK_DEVICES."
      );
    }
    if (text.includes("econnrefused") || text.includes("fetch failed")) {
      return "The server went away mid-run. Check that it is still up and that it did not crash — its console has the answer.";
    }
    if (text.includes("timed out")) {
      return "The job is still on the server. Look at its queue; a first draw also loads the model from disk, which is slow on a spinning one.";
    }
    if (text.includes("does not offer the model")) {
      return "Use a model code the server listed above, or add that workflow to the plugin's catalogue.";
    }
    return "The server's own console says more — a missing custom node or model file shows up there with its name.";
  }

  /** The run's own address, normalized the same way the CLI validated it. */
  static urlOf(raw: string): string | null {
    const value = (raw ?? "").trim();
    if (!value) return null;
    const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;
    try {
      const url = new URL(withScheme);
      if (!url.hostname) return null;
      return url.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  /** What a file on disk actually is, from its own header — not from its name. */
  static imageInfoOf(file: string): { format: string; width?: number; height?: number } | null {
    let head: Buffer;
    try {
      const fd = fs.openSync(file, "r");
      try {
        head = Buffer.alloc(64);
        const read = fs.readSync(fd, head, 0, 64, 0);
        head = head.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    if (head.length >= 24 && head.readUInt32BE(0) === 0x8950_4e47 && head.toString("ascii", 12, 16) === "IHDR") {
      return { format: "PNG", width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
      const size = ComfyUiSelfTestService.jpegSize(head);
      return size ? { format: "JPEG", ...size } : { format: "JPEG" };
    }
    if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
      return { format: "WebP" };
    }
    return null;
  }

  /** The frame size of a JPEG, from its first start-of-frame marker. */
  private static jpegSize(head: Buffer): { width: number; height: number } | null {
    for (let i = 2; i + 9 < head.length; i++) {
      if (head[i] !== 0xff) continue;
      const marker = head[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      i += head.readUInt16BE(i + 2) + 1;
    }
    return null;
  }
}

// The PNG chunk checksum, done the slow obvious way — it runs over three small
// buffers per test picture.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
