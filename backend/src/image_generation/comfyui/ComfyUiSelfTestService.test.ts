import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { deflateSync } from "zlib";
import { PathHelper } from "../../shared/PathHelper";
import { ComfyUiSelfTestOptions, ComfyUiSelfTestReport, ComfyUiSelfTestService } from "./ComfyUiSelfTestService";

// Isolate the data root before anything reads the layout: the workflow catalogue
// and the default output folder of the run both come from it.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-selftest-"));
process.env.SILLYTALK_DATA_DIR = dataRoot;

// ---------------------------------------------------------------- the mock server
//
// The part of the ComfyUI API the self-test walks, with the knobs that let a
// test stand in for each kind of broken server: no converter node, a node class
// missing from the listing, a model file the server does not have, a job that
// fails. /view answers with a real PNG of the size the job asked for, so the
// check of "is the picture the size the app asked for" is really exercised.

type MockOptions = {
  /** The server has no POST /workflow/convert (the custom node is not installed). */
  noConverter?: boolean;
  /** GET /object_info does not answer. */
  noObjectInfo?: boolean;
  /** /system_stats answers without a device list (what a GPU server does before its first job). */
  noDevices?: boolean;
  /** The server's process dies after this many jobs were queued (the crash path). */
  diesAfterPrompts?: number;
  /** The names this server offers for a checkpoint loader. */
  checkpoints?: string[];
  /** A node class the workflow asks for that the server does not have. */
  extraClass?: string;
  /** A class hidden from the listing but answered when asked about on its own. */
  hiddenClass?: string;
  /** Jobs fail on the server instead of drawing. */
  failJobs?: boolean;
};

interface MockComfy {
  url: string;
  close(): Promise<void>;
  uploads: string[];
  prompts: string[];
  requestedSizes: Array<{ width: unknown; height: unknown }>;
}

function startMockComfy(options: MockOptions = {}): Promise<MockComfy> {
  const checkpoints = options.checkpoints ?? ["flux_dev.safetensors"];
  // The state of a crashed server: no request is answered any more, and `kill`
  // is what brings it down (assigned once the server is listening).
  let dead = false;
  let kill: () => void = () => undefined;
  const mock: MockComfy = {
    url: "",
    close: () => Promise.resolve(),
    uploads: [],
    prompts: [],
    requestedSizes: [],
  };
  const jobs = new Map<string, { size: { width: unknown; height: unknown }; finishesAt: number; fails: boolean }>();
  let nextId = 1;

  // The API-format workflow the converter answers with: the nodes of a small
  // text-to-image graph, plus the LoadImage node of the reference templates, and
  // — when the test asks for one — a class the server does not have.
  function apiWorkflowOf(variant: string): Record<string, unknown> {
    const nodes: Record<string, unknown> = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux_dev.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT", clip: ["1", 1] } },
      "3": {
        class_type: "EmptyLatentImage",
        inputs: { width: "PARAM_INT_OUTPUT_IMAGE_WIDTH", height: "PARAM_INT_OUTPUT_IMAGE_HEIGHT", batch_size: 1 },
      },
      "4": { class_type: "KSampler", inputs: { sampler_name: "euler", seed: "PARAM_SEED", model: ["1", 0] } },
      "5": { class_type: "SaveImage", inputs: { filename_prefix: "PARAM_STRING_OUTPUT_IMAGE_FILENAME", images: ["4", 0] } },
    };
    if (variant === "oneImage") {
      nodes["6"] = { class_type: "LoadImage", inputs: { image: "PARAM_STRING_INPUT_IMAGE_FILENAME" } };
    }
    if (variant === "twoImages") {
      nodes["6"] = { class_type: "LoadImage", inputs: { image: "PARAM_STRING_INPUT_IMAGE_FILENAME_1" } };
      nodes["7"] = { class_type: "LoadImage", inputs: { image: "PARAM_STRING_INPUT_IMAGE_FILENAME_2" } };
    }
    if (options.extraClass) nodes["9"] = { class_type: options.extraClass, inputs: { thing: "whatever" } };
    if (options.hiddenClass) nodes["10"] = { class_type: options.hiddenClass, inputs: {} };
    return nodes;
  }

  function objectInfo(): Record<string, unknown> {
    const info: Record<string, unknown> = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints, {}] } } },
      CLIPTextEncode: { input: { required: { text: ["STRING"], clip: ["CLIP"] } } },
      EmptyLatentImage: { input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } } },
      KSampler: { input: { required: { sampler_name: [["euler", "dpmpp_2m"], {}], seed: ["INT"] } } },
      SaveImage: { input: { required: { filename_prefix: ["STRING"], images: ["IMAGE"] } } },
      // A combo of the server's own files: the app's placeholder for it must not
      // be compared with this list at all.
      LoadImage: { input: { required: { image: [["some_upload.png"], {}] } } },
    };
    // options.hiddenClass is deliberately NOT in this listing — it is the node
    // the server only admits to when asked about it by name (a lazy import),
    // which is exactly the case a "missing custom node" warning must not claim.
    return info;
  }

  const server = http.createServer((req, res) => {
    if (dead) return; // the process is gone; nothing answers any more
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (dead) return;
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://comfy.test");
      const route = `${req.method} ${url.pathname}`;
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        if (route === "GET /system_stats") {
          return send(200, {
            system: {
              os: "posix",
              comfyui_version: "0.44.0",
              python_version: "3.11.5",
              pytorch_version: "2.4.1",
              ram_total: 32 * 1024 * 1024 * 1024,
              // A GPU server that has not loaded a model yet answers without a
              // device list — the run must not call that a problem (see below).
              devices: options.noDevices
                ? undefined
                : [
                    { name: "cuda:0 NVIDIA RTX 4090", type: "cuda", index: 0, vram_total: 24_000 * 1024 * 1024, vram_free: 20_000 * 1024 * 1024 },
                    { name: "cuda:1 NVIDIA RTX 3090", type: "cuda", index: 1, vram_total: 24_000 * 1024 * 1024, vram_free: 21_000 * 1024 * 1024 },
                  ],
            },
          });
        }
        if (route === "POST /workflow/convert") {
          if (options.noConverter) return send(404, { error: "Not Found" });
          const ui = raw.toString("utf-8");
          const variant = ui.includes("PARAM_STRING_INPUT_IMAGE_FILENAME_1")
            ? "twoImages"
            : ui.includes("PARAM_STRING_INPUT_IMAGE_FILENAME")
              ? "oneImage"
              : "text";
          return send(200, apiWorkflowOf(variant));
        }
        if (route === "GET /object_info") {
          if (options.noObjectInfo) return send(404, { error: "Not Found" });
          return send(200, objectInfo());
        }
        if (route.startsWith("GET /object_info/")) {
          const name = decodeURIComponent(url.pathname.slice("/object_info/".length));
          // A node the listing hides but the server does know (it loads lazily)
          // must not be reported as missing.
          if (name === options.hiddenClass) return send(200, { [name]: { input: { required: {} } } });
          const info = objectInfo();
          return info[name] ? send(200, { [name]: info[name] }) : send(404, { error: "Not Found" });
        }
        if (route === "POST /upload/image") {
          const name = /filename="([^"]+)"/.exec(raw.toString("binary"))?.[1] ?? "unnamed.png";
          mock.uploads.push(name);
          return send(200, { name, subfolder: "", type: "input" });
        }
        if (route === "POST /prompt") {
          const submitted = JSON.parse(raw.toString("utf-8")) as {
            prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
          };
          const nodes = Object.values(submitted.prompt);
          const inputsOf = (classType: string): Record<string, unknown> =>
            nodes.find((n) => n?.class_type === classType)?.inputs ?? {};
          const id = `mock-${nextId++}`;
          const latent = inputsOf("EmptyLatentImage");
          mock.prompts.push(String(inputsOf("CLIPTextEncode").text ?? ""));
          mock.requestedSizes.push({ width: latent.width, height: latent.height });
          jobs.set(id, {
            size: { width: latent.width, height: latent.height },
            finishesAt: Date.now() + 100,
            fails: !!options.failJobs,
          });
          // The crash: the job is accepted, then the process dies while the
          // client is polling for its picture — exactly what a GPU abort does.
          if (options.diesAfterPrompts !== undefined && jobs.size >= options.diesAfterPrompts) {
            send(200, { prompt_id: id, node_errors: {} });
            setImmediate(kill);
            return;
          }
          return send(200, { prompt_id: id, node_errors: {} });
        }
        if (url.pathname.startsWith("/history/")) {
          const id = decodeURIComponent(url.pathname.slice("/history/".length));
          const job = jobs.get(id);
          if (!job) return send(200, {});
          if (job.fails) {
            return send(200, {
              [id]: {
                status: {
                  status_str: "error",
                  completed: false,
                  messages: [["execution_error", { exception_message: "CUDA out of memory. Tried to allocate 2 GiB" }]],
                },
              },
            });
          }
          if (Date.now() < job.finishesAt) {
            return send(200, { [id]: { status: { status_str: "running", completed: false, messages: [] } } });
          }
          return send(200, {
            [id]: {
              status: { status_str: "success", completed: true, messages: [] },
              outputs: { "5": { images: [{ filename: `mock_${id}.png`, subfolder: "", type: "output" }] } },
            },
          });
        }
        if (route === "GET /view") {
          const id = (url.searchParams.get("filename") ?? "").replace(/^mock_/, "").replace(/\.png$/, "");
          const size = jobs.get(id)?.size ?? { width: 8, height: 8 };
          const png = pngOf(Number(size.width) || 8, Number(size.height) || 8);
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(png);
          return;
        }
        if (route === "POST /queue" || route === "POST /interrupt") return send(200, {});
        return send(404, { error: `the mock server has no ${route} route` });
      } catch (err) {
        return send(500, { error: String(err) });
      }
    });
  });

  return new Promise((resolve) => {
    // The crash of a real ComfyUI takes the listening socket AND the open
    // connections with it: the request that is in flight gets a reset socket and
    // the next one a refused connection. Closing the server alone would leave
    // the keep-alive sockets of the client alive and answer on them, which is
    // not what a dead process does.
    const sockets = new Set<import("net").Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const die = (): void => {
      if (dead) return;
      dead = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    };

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      mock.url = `http://127.0.0.1:${port}`;
      mock.close = () => new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      });
      resolve(mock);
    });
    kill = die;
  });
}

// A real PNG of the wanted size, so the run's check of the file it downloaded
// has something true to read.
function pngOf(width: number, height: number): Buffer {
  const rows = Buffer.alloc((1 + width * 3) * height);
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buf: Buffer): number => {
    let value = -1;
    for (const byte of buf) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 4 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ the fixtures

// The workflows of the run come from the user's folder of the temp data root, so
// a test knows exactly which templates exist (the app's own shipped workflows
// are still in the catalogue and are filtered out with `models`).
function writeWorkflow(model: string, variants: Record<string, unknown>): string {
  const dir = PathHelper.comfyWorkflowsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${model}.json`);
  fs.writeFileSync(file, JSON.stringify(variants));
  return file;
}

/** A template whose text carries the placeholder the mock converter recognizes. */
function template(refPlaceholders: string[] = []): Record<string, unknown> {
  const nodes: Record<string, unknown> = { "5": { inputs: { text: "PARAM_PROMPT" } } };
  for (const name of refPlaceholders) nodes[`7_${name}`] = { inputs: { image: name } };
  return nodes;
}

let mock: MockComfy;
let outDir: string;

beforeEach(async () => {
  fs.rmSync(path.join(dataRoot, "comfyui"), { recursive: true, force: true });
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-selftest-out-"));
  mock = await startMockComfy();
});

afterEach(async () => {
  await mock.close();
});

async function runTest(
  options: Partial<ComfyUiSelfTestOptions> = {},
): Promise<{ report: ComfyUiSelfTestReport; lines: string[] }> {
  const lines: string[] = [];
  const service = new ComfyUiSelfTestService();
  const report = await service.run(
    { url: mock.url, outDir, models: ["jest-model"], ...options } as ComfyUiSelfTestOptions,
    (line) => lines.push(line),
  );
  return { report, lines };
}

describe("ComfyUiSelfTestService", () => {
  it("walks every template of a healthy server and keeps the pictures", async () => {
    writeWorkflow("jest-model", {
      text: template(),
      oneImage: template(["PARAM_STRING_INPUT_IMAGE_FILENAME"]),
      twoImages: template(["PARAM_STRING_INPUT_IMAGE_FILENAME_1", "PARAM_STRING_INPUT_IMAGE_FILENAME_2"]),
    });

    const { report, lines } = await runTest({ width: 512, height: 384 });
    const text = lines.join("\n");

    expect(report.ok).toBe(true);
    expect(report.verdict).toMatch(/nothing to fix/);
    expect(report.problems).toEqual([]);
    expect(report.items.map((i) => [i.variant, i.status, i.refs])).toEqual([
      ["text", "ok", 0],
      ["oneImage", "ok", 1],
      ["twoImages", "ok", 2],
    ]);
    // what the run said about the machine, before anything was drawn
    expect(text).toMatch(/ComfyUI 0\.44\.0/);
    expect(text).toMatch(/RTX 4090/);
    expect(text).toMatch(/\[2\/5\][\s\S]*jest-model \[user\] text, oneImage, twoImages \(at most 2 references\)/);
    // the reference pictures really went through the upload endpoint
    expect(mock.uploads.length).toBe(3);
    // the size the run asked for is the size the workflow got and the file has
    expect(mock.requestedSizes).toEqual([
      { width: 512, height: 384 },
      { width: 512, height: 384 },
      { width: 512, height: 384 },
    ]);
    for (const item of report.items) {
      expect(ComfyUiSelfTestService.imageInfoOf(item.outPath!)).toEqual({ format: "PNG", width: 512, height: 384 });
    }
    // the test references are on disk too, where the run said they would be
    expect(fs.existsSync(path.join(outDir, "reference-a.png"))).toBe(true);
  }, 60_000);

  it("stops at a server that is not there and says what to check", async () => {
    const url = mock.url;
    await mock.close();

    const { report, lines } = await runTest({ url });
    expect(report.fatal).toMatch(/nothing listens/);
    expect(report.items).toEqual([]);
    expect(report.ok).toBe(false);
    expect(lines.join("\n")).toMatch(/--listen 0\.0\.0\.0/);
    mock = await startMockComfy(); // the afterEach closes it again
  }, 60_000);

  it("names the converter custom node when the server has none, and draws nothing", async () => {
    writeWorkflow("jest-model", { text: template() });
    await mock.close();
    mock = await startMockComfy({ noConverter: true });

    const { report, lines } = await runTest();
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/comfyui-workflow-to-api-converter-endpoint/);
    expect(report.items.every((i) => i.status === "skipped")).toBe(true);
    expect(lines.join("\n")).toMatch(/BROKEN|\[3\/5\][\s\S]*comfyui-workflow-to-api-converter-endpoint/);
  }, 60_000);

  it("warns about a node class and a model file the server lacks, then draws anyway", async () => {
    writeWorkflow("jest-model", { text: template() });
    await mock.close();
    mock = await startMockComfy({
      extraClass: "SomeMissingNode",
      hiddenClass: "LazyNode",
      checkpoints: ["somewhere_else.safetensors", "sdxl.safetensors"],
    });

    const { report, lines } = await runTest({ withRefs: false });
    const problems = report.problems.join("\n");
    expect(problems).toMatch(/no node class "SomeMissingNode"/);
    expect(problems).toMatch(/CheckpointLoaderSimple\.ckpt_name loads "flux_dev\.safetensors"/);
    // a lazy node the listing hides is not missing, and a placeholder value is
    // never compared with the server's list of files
    expect(problems).not.toMatch(/LazyNode/);
    expect(problems).not.toMatch(/LoadImage\.image/);
    // the warnings did not stop the run: the picture is the verdict
    expect(report.items.map((i) => i.status)).toEqual(["ok"]);
    expect(report.verdict).toMatch(/every picture was drawn/);
    expect(lines.join("\n")).toMatch(/WARNING jest-model/);
  }, 60_000);

  it("goes on and draws when the server does not answer /object_info", async () => {
    writeWorkflow("jest-model", { text: template() });
    await mock.close();
    mock = await startMockComfy({ noObjectInfo: true });

    const { report, lines } = await runTest({ withRefs: false });
    expect(lines.join("\n")).toMatch(/node and model-file checks are skipped/);
    // the step that could not be read invented no problems of its own
    expect(report.problems).toEqual([]);
    expect(report.items.map((i) => i.status)).toEqual(["ok"]);
    expect(report.ok).toBe(true);
  }, 60_000);

  // Found on a live 0.44/ROCm server: /system_stats answered without a device
  // list before its first job and drew three pictures on its GPU right after —
  // so the empty list is not a fault, and the field is worth reading again once
  // the server has loaded a model.
  it("does not call an empty device list a problem and reads it again after drawing", async () => {
    writeWorkflow("jest-model", { text: template() });
    await mock.close();
    mock = await startMockComfy({ noDevices: true });

    const { report, lines } = await runTest({ withRefs: false });
    const text = lines.join("\n");
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(text).toMatch(/no compute device in the answer/);
    expect(text).toMatch(/The server again, now that it has drawn/);
  }, 60_000);

  // Also from a live run: the server's process aborted (core dumped) inside a
  // sampler. The run must say that once — the templates it never reached are not
  // evidence against those workflows.
  it("reports a server that dies during the run as one event, not one failure per template", async () => {
    writeWorkflow("jest-model", {
      text: template(),
      oneImage: template(["PARAM_STRING_INPUT_IMAGE_FILENAME"]),
      twoImages: template(["PARAM_STRING_INPUT_IMAGE_FILENAME_1", "PARAM_STRING_INPUT_IMAGE_FILENAME_2"]),
    });
    await mock.close();
    mock = await startMockComfy({ diesAfterPrompts: 2 });

    const { report, lines } = await runTest();
    expect(report.items.map((i) => i.status)).toEqual(["ok", "failed", "skipped"]);
    expect(report.items[1].error).toMatch(/the server stopped answering while this job was running/);
    expect(report.items[2].error).toMatch(/not tried — the server stopped answering during this run/);
    expect(report.verdict).toMatch(/died during this run/);
    expect(report.problems.join("\n")).toMatch(/journalctl/);
    // the third job was never sent: nothing new reached the (dead) server
    expect(lines.join("\n")).toMatch(/The server went away in the middle of this run/);
    expect(lines.join("\n")).toMatch(/skip    jest-model\/twoImages — the server stopped answering/);
    expect(report.ok).toBe(false);
  }, 60_000);

  it("reports a failing job with the reason and what to do about it", async () => {
    writeWorkflow("jest-model", { text: template() });
    await mock.close();
    mock = await startMockComfy({ failJobs: true });

    const { report, lines } = await runTest({ withRefs: false });
    const item = report.items[0];
    expect(item.status).toBe("failed");
    expect(item.error).toMatch(/out of memory/);
    expect(item.hints.join("\n")).toMatch(/out of memory/);
    expect(report.ok).toBe(false);
    expect(report.verdict).toMatch(/could not be drawn/);
    expect(lines.join("\n")).toMatch(/FAILED\s+jest-model\/text/);
  }, 60_000);

  it("skips the generation on --no-draw and is still a clean run", async () => {
    writeWorkflow("jest-model", { text: template() });
    const { report } = await runTest({ draw: false });
    expect(report.items).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.verdict).toMatch(/the generation was skipped/);
  }, 60_000);

  it("reads a broken workflow file and names the shipped one it replaces", async () => {
    const file = writeWorkflow("jest-model", { notAWorkflow: {} });
    const { report, lines } = await runTest({ draw: false });
    const text = lines.join("\n");
    expect(report.workflows[0].error).toMatch(/holds none of "text, oneImage, twoImages"/);
    expect(text).toMatch(/BROKEN  jest-model/);
    expect(report.problems.join("\n")).toMatch(/cannot be used/);
    expect(fs.existsSync(file)).toBe(true);
  }, 60_000);

  it("says so when a name matches no workflow", async () => {
    const { report, lines } = await runTest({ models: ["no-such-model"], draw: false });
    expect(report.fatal).toBeUndefined();
    expect(report.problems.join("\n")).toMatch(/No workflow of the app is named "no-such-model"/);
    expect(lines.join("\n")).toMatch(/qwen-image-2\.1/);
    expect(report.ok).toBe(false);
  }, 60_000);

  it("lists the workflows the app ships, with the user's own file winning", async () => {
    const shipped = "qwen-image-2.1";
    writeWorkflow(shipped, { text: template() });
    const { report } = await runTest({ models: [shipped], draw: false });
    const entry = report.workflows.find((w) => w.model === shipped);
    expect(entry?.source).toBe("user");
    expect(entry?.file).toBe(path.join(PathHelper.comfyWorkflowsDir(), `${shipped}.json`));
  }, 60_000);
});

describe("ComfyUiSelfTestService.imageInfoOf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-head-"));

  it("reads the size a file says it has", () => {
    const png = path.join(dir, "a.png");
    fs.writeFileSync(png, pngOf(64, 32));
    expect(ComfyUiSelfTestService.imageInfoOf(png)).toEqual({ format: "PNG", width: 64, height: 32 });

    const gif = path.join(dir, "a.gif");
    const gifBytes = Buffer.alloc(13);
    gifBytes.write("GIF89a", 0, "ascii");
    gifBytes.writeUInt16LE(11, 6);
    gifBytes.writeUInt16LE(22, 8);
    fs.writeFileSync(gif, gifBytes);
    expect(ComfyUiSelfTestService.imageInfoOf(gif)).toEqual({ format: "GIF", width: 11, height: 22 });
  });

  it("is null for something that is not a picture", () => {
    const text = path.join(dir, "not-a-picture");
    fs.writeFileSync(text, "<html><body>502 Bad Gateway</body></html>");
    expect(ComfyUiSelfTestService.imageInfoOf(text)).toBeNull();
    expect(ComfyUiSelfTestService.imageInfoOf(path.join(dir, "missing.png"))).toBeNull();
  });
});
