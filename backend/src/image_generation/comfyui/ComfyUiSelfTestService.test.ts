import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { deflateSync } from "zlib";
import { PathHelper } from "../../shared/PathHelper";
import { ComfyUiSelfTestOptions, ComfyUiSelfTestReport, ComfyUiSelfTestService } from "./ComfyUiSelfTestService";

// Isolate the data root before anything reads the layout: the default output
// folder of the run comes from it.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-selftest-"));
process.env.SILLYTALK_DATA_DIR = dataRoot;

// ---------------------------------------------------------------- the mock server
//
// A ComfyUI server running the comfyui-sillytalk plugin, with a knob for each
// kind of broken server the run has to tell apart: no plugin at all, an empty or
// partly broken catalogue, jobs that fail, a job whose file is not a picture, a
// process that dies mid-run. The picture route answers with a real PNG of the
// size the job asked for, so the run's check of the file it downloaded is really
// exercised.

type MockModel = { code: string; max_refs: number; width?: number; height?: number };

type MockOptions = {
  /** The server has no comfyui-sillytalk: every /sillytalk route answers 404. */
  noPlugin?: boolean;
  /** /system_stats answers without a device list (what a GPU server does before its first job). */
  noDevices?: boolean;
  /** The catalogue the plugin publishes. */
  models?: MockModel[];
  /** Workflows the plugin found but cannot use. */
  brokenWorkflows?: { code: string; file?: string; error: string }[];
  /** Jobs fail on the server instead of drawing. */
  failJobs?: boolean;
  /** The finished job serves something that is not a picture. */
  brokenPicture?: boolean;
  /** The server's process dies after this many jobs were queued (the crash path). */
  diesAfterPrompts?: number;
};

interface MockComfy {
  url: string;
  close(): Promise<void>;
  /** Every job the app submitted, with what it asked for. */
  jobs: Array<{ id: string; model: string; prompt: string; width: string; height: string; refs: number }>;
  /** How often each route was asked for, by name. */
  hits: Record<string, number>;
}

function startMockComfy(options: MockOptions = {}): Promise<MockComfy> {
  const models = options.models ?? [
    { code: "jest-model", max_refs: 2, width: 1024, height: 1024 },
    { code: "plain-model", max_refs: 0, width: 1024, height: 1024 },
  ];
  // The state of a crashed server: no request is answered any more, and `kill`
  // is what brings it down (assigned once the server is listening).
  let dead = false;
  let kill: () => void = () => undefined;
  const mock: MockComfy = { url: "", close: () => Promise.resolve(), jobs: [], hits: {} };
  const jobs = new Map<string, { size: { width: number; height: number }; finishesAt: number }>();
  let nextId = 1;

  const hit = (name: string): void => {
    mock.hits[name] = (mock.hits[name] ?? 0) + 1;
  };
  // The text fields of a multipart request, and how many file parts came with
  // them — enough to know what the app asked the server to draw.
  const fieldOf = (raw: Buffer, name: string): string =>
    new RegExp(`name="${name}"\r\n\r\n([^\r]*)`).exec(raw.toString("utf-8"))?.[1] ?? "";
  const fileCount = (raw: Buffer): number => raw.toString("binary").match(/filename="/g)?.length ?? 0;

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
          hit("stats");
          return send(200, {
            system: {
              os: "posix",
              comfyui_version: "0.44.2",
              python_version: "3.12.7",
              pytorch_version: "2.8.0",
              ram_total: 32 * 1024 * 1024 * 1024,
              // A GPU server that has not loaded a model yet answers without a
              // device list — the run must not call that a problem.
              devices: options.noDevices
                ? undefined
                : [
                    { name: "cuda:0 NVIDIA RTX 4090", type: "cuda", index: 0, vram_total: 24_000 * 1024 * 1024, vram_free: 20_000 * 1024 * 1024 },
                    { name: "cuda:1 NVIDIA RTX 3090", type: "cuda", index: 1, vram_total: 24_000 * 1024 * 1024, vram_free: 21_000 * 1024 * 1024 },
                  ],
            },
          });
        }

        if (url.pathname.startsWith("/sillytalk")) {
          hit(url.pathname === "/sillytalk/models" ? "models" : url.pathname === "/sillytalk/health" ? "health" : "other");
          if (options.noPlugin) return send(404, { error: "Not Found" });

          if (route === "GET /sillytalk/health") {
            return send(200, {
              name: "comfyui-sillytalk",
              version: "1.0.0",
              comfyui_version: "0.44.2",
              workflow_dir: "/opt/comfy/custom_nodes/comfyui-sillytalk/workflows",
              models: models.map((m) => m.code),
              broken_workflows: options.brokenWorkflows ?? [],
              devices: [
                { device: "cuda:0", name: "NVIDIA RTX 4090", vram_total_mb: 24000, vram_free_mb: 20000, vram_reclaimable_mb: 6000 },
                { device: "cuda:1", name: "NVIDIA RTX 3090", vram_total_mb: 24000, vram_free_mb: 21000 },
              ],
              resident_models: [{ model: "vae (ae.safetensors)", device: "cuda:1", mb: 250 }],
            });
          }

          if (route === "GET /sillytalk/models") {
            return send(200, { models });
          }

          if (route === "POST /sillytalk/generate") {
            hit("generate");
            const model = fieldOf(raw, "model");
            const known = models.find((m) => m.code === model);
            const refs = fileCount(raw);
            if (!known) return send(400, { error: `no workflow named '${model}' in this server's catalogue` });
            if (refs > known.max_refs) {
              return send(400, { error: `the '${model}' workflow takes at most ${known.max_refs} reference image(s)` });
            }
            const id = `mock-${nextId++}`;
            const size = {
              width: Number(fieldOf(raw, "width")) || known.width || 1024,
              height: Number(fieldOf(raw, "height")) || known.height || 1024,
            };
            mock.jobs.push({ id, model, prompt: fieldOf(raw, "prompt"), width: fieldOf(raw, "width"), height: fieldOf(raw, "height"), refs });
            jobs.set(id, { size, finishesAt: Date.now() + 60 });
            // The crash: the job is accepted, then the process dies while the
            // client is polling for its picture — exactly what a GPU abort does.
            if (options.diesAfterPrompts !== undefined && jobs.size >= options.diesAfterPrompts) {
              send(202, { job_id: id, model, status: "queued" });
              setImmediate(kill);
              return;
            }
            return send(202, { job_id: id, model, status: "queued" });
          }

          const jobRoute = /^\/sillytalk\/jobs\/([^/]+)(\/image)?$/.exec(url.pathname);
          if (jobRoute) {
            const id = decodeURIComponent(jobRoute[1]);
            const job = jobs.get(id);
            if (!job) return send(404, { error: "no such job on this server" });
            if (jobRoute[2]) {
              if (options.brokenPicture) {
                res.writeHead(200, { "Content-Type": "image/png" });
                res.end("<html><body>502 Bad Gateway</body></html>");
                return;
              }
              res.writeHead(200, { "Content-Type": "image/png" });
              res.end(pngOf(job.size.width, job.size.height));
              return;
            }
            if (options.failJobs) {
              return send(200, { job_id: id, status: "failed", error: "CUDA out of memory. Tried to allocate 2 GiB" });
            }
            if (Date.now() < job.finishesAt) return send(200, { job_id: id, status: "running" });
            return send(200, {
              job_id: id,
              status: "succeeded",
              seconds: 0.1,
              placements: [{ node: "3", class: "UNETLoader", device: "cuda:0", mb: 12000 }],
            });
          }
        }

        return send(404, { error: `the mock server has no ${route} route` });
      } catch (err) {
        return send(500, { error: String(err) });
      }
    });
  });

  return new Promise((resolve) => {
    // The crash of a real ComfyUI takes the listening socket AND the open
    // connections with it: the request in flight gets a reset socket and the
    // next one a refused connection. Closing the server alone would leave the
    // keep-alive sockets of the client alive and answer on them, which is not
    // what a dead process does.
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

let mock: MockComfy;
let outDir: string;

beforeEach(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-selftest-out-"));
  mock = await startMockComfy();
});

afterEach(async () => {
  await mock.close();
});

/** One run of the self-test against the mock, with its log kept. */
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

/** Restarts the mock with other knobs (a broken server is not a healthy one). */
async function replaceMock(options: MockOptions): Promise<void> {
  await mock.close();
  mock = await startMockComfy(options);
}

describe("ComfyUiSelfTestService", () => {
  it("walks a healthy server and draws one picture per reference count", async () => {
    const { report, lines } = await runTest({ width: 512, height: 384 });
    const text = lines.join("\n");

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.comfyui).toBe("0.44.2");
    expect(report.plugin).toBe("1.0.0");
    expect(report.summary).toMatch(/^3 of 3 test picture\(s\) drawn/);
    expect(report.items.map((i) => [i.model, i.refs, i.status])).toEqual([
      ["jest-model", 0, "ok"],
      ["jest-model", 1, "ok"],
      ["jest-model", 2, "ok"],
    ]);
    // what the run said about the machine, before anything was drawn
    expect(text).toMatch(/ComfyUI 0\.44\.2/);
    expect(text).toMatch(/comfyui-sillytalk 1\.0\.0/);
    expect(text).toMatch(/RTX 4090.*20000 MiB free of 24000 MiB/);
    // the plugin's own account of its cards, including the cache it could give up
    expect(text).toMatch(/its own cache/);
    expect(text).toMatch(/resident: vae .*cuda:1/);
    // the catalogue it read, in the words the user picks from afterwards
    expect(text).toMatch(/it draws: jest-model \(≤2 refs\), plain-model \(≤0 refs\)/);

    // the draws really carried the size and the references they claim
    expect(mock.jobs.map((j) => [j.width, j.height, j.refs])).toEqual([
      ["512", "384", 0],
      ["512", "384", 1],
      ["512", "384", 2],
    ]);
    for (const item of report.items) {
      expect(ComfyUiSelfTestService.imageInfoOf(item.file!)).toEqual({ format: "PNG", width: 512, height: 384 });
      // which card did the work, straight from the server's answer
      expect(item.placement).toBe("UNETLoader@cuda:0");
      expect(text).toContain("on UNETLoader@cuda:0");
    }
    // the test references are on disk too, where the run said they would be
    expect(fs.existsSync(path.join(outDir, "reference-1.png"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "reference-2.png"))).toBe(true);
  }, 60_000);

  it("draws every model of the catalogue unless it is told which", async () => {
    const { report } = await runTest({ models: [], withRefs: false });
    expect(report.items.map((i) => [i.model, i.refs])).toEqual([
      ["jest-model", 0],
      ["plain-model", 0],
    ]);
    expect(report.ok).toBe(true);
  }, 60_000);

  it("asks the server for its catalogue once per draw, not once per request", async () => {
    // Each draw builds its own driver for the model's own size, and a driver
    // has to learn the model exists before it uses it. Nothing else on the
    // server is asked for again.
    await runTest({ withRefs: false });
    expect(mock.hits.stats).toBe(1);
    expect(mock.hits.health).toBe(1);
    expect(mock.hits.generate).toBe(1);
  }, 60_000);

  it("stops at a server that is not there and says what to check", async () => {
    const url = mock.url;
    await mock.close();

    const { report, lines } = await runTest({ url });
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/did not answer/);
    expect(report.items).toEqual([]);
    expect(lines.join("\n")).toMatch(/--listen 0\.0\.0\.0/);
    mock = await startMockComfy(); // the afterEach closes it again
  }, 60_000);

  it("names the plugin custom node when the server has none, and draws nothing", async () => {
    await replaceMock({ noPlugin: true });
    const { report, lines } = await runTest();
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/comfyui-sillytalk/);
    expect(report.problems.join("\n")).toMatch(/\/sillytalk\/health/);
    expect(report.items).toEqual([]);
    expect(mock.hits.generate ?? 0).toBe(0);
    expect(lines.join("\n")).toMatch(/✗/);
  }, 60_000);

  it("reports a workflow the plugin itself could not load, and draws the rest", async () => {
    await replaceMock({ brokenWorkflows: [{ code: "half-a-model", file: "half-a-model.json", error: "no UNETLoader node" }] });
    const { report, lines } = await runTest({ withRefs: false });
    expect(report.problems.join("\n")).toMatch(/"half-a-model" of the server is unusable: no UNETLoader node/);
    expect(report.ok).toBe(false);
    // the broken entry did not stop the healthy ones: the picture is the verdict
    expect(report.items.map((i) => i.status)).toEqual(["ok"]);
    expect(lines.join("\n")).toMatch(/half-a-model/);
  }, 60_000);

  it("says so when the catalogue is empty, and where the workflows belong", async () => {
    await replaceMock({ models: [] });
    const { report } = await runTest();
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/no usable workflow in its catalogue/);
    expect(report.problems.join("\n")).toMatch(/custom_nodes\/comfyui-sillytalk\/workflows/);
    expect(report.items).toEqual([]);
  }, 60_000);

  it("says so when a name the user gave matches no model of the server", async () => {
    const { report, lines } = await runTest({ models: ["no-such-model"], draw: false });
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/the server does not offer: no-such-model/);
    // …and what it does offer, so the next try can be typed from the answer
    expect(report.problems.join("\n")).toMatch(/it offers jest-model, plain-model/);
    expect(lines.join("\n")).toMatch(/no-such-model/);
  }, 60_000);

  it("skips the generation on draw: false and is still a clean run", async () => {
    const { report, lines } = await runTest({ draw: false });
    expect(report.items).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatch(/1 model\(s\) ready/);
    expect(mock.hits.generate ?? 0).toBe(0);
    expect(lines.join("\n")).toMatch(/nothing was generated/);
  }, 60_000);

  it("reports a failing job with the reason and what to do about it", async () => {
    await replaceMock({ failJobs: true });
    const { report, lines } = await runTest({ withRefs: false });
    const item = report.items[0];
    expect(item.status).toBe("failed");
    expect(item.error).toMatch(/out of memory/);
    expect(item.advice).toMatch(/card/i);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/0 of 1 test picture\(s\) drawn.*1 failed/);
    expect(lines.join("\n")).toMatch(/→ jest-model \/ 0 references/);
    expect(lines.join("\n")).toMatch(/✗ .*out of memory/);
  }, 60_000);

  it("fails a job whose file is not a picture", async () => {
    // A server behind a proxy can answer 200 with an error page and the job
    // still look finished: the file is the only witness.
    await replaceMock({ brokenPicture: true });
    const { report } = await runTest({ withRefs: false });
    expect(report.items[0].status).toBe("failed");
    expect(report.items[0].error).toMatch(/not a readable picture/);
    expect(report.ok).toBe(false);
  }, 60_000);

  // From a live 0.44/ROCm server: the process aborted (SIGABRT inside
  // load_models_gpu) while a job was running. The run must say that once — the
  // draws it never reached are not evidence against those models.
  it("reports a server that dies during the run as one event, not one failure per draw", async () => {
    await replaceMock({ diesAfterPrompts: 2 });
    const { report, lines } = await runTest();
    expect(report.items.map((i) => [i.refs, i.status])).toEqual([
      [0, "ok"],
      [1, "failed"],
      [2, "skipped"],
    ]);
    expect(report.items[1].error).toMatch(/fetch failed|ECONNREFUSED|ECONNRESET/);
    expect(report.items[2].error).toMatch(/not tried — the server stopped answering/);
    expect(report.summary).toMatch(/died during this run/);
    const text = lines.join("\n");
    expect(text).toMatch(/The server went away in the middle of this run/);
    expect(text).toMatch(/journalctl/);
    // the third job was never sent: nothing new reached the (dead) server
    expect(mock.jobs).toHaveLength(2);
    expect(report.ok).toBe(false);
  }, 60_000);

  it("writes the pictures into the folder it was given, and the default otherwise", async () => {
    const { report } = await runTest({ withRefs: false });
    expect(path.dirname(report.items[0].file!)).toBe(outDir);
    // a run of its own would land under the data root, not the current folder
    expect(path.join(PathHelper.configDir(), "comfyui-test")).toContain("comfyui-test");
  }, 60_000);
});

describe("ComfyUiSelfTestService.urlOf", () => {
  it("normalizes an address and rejects what is not one", () => {
    expect(ComfyUiSelfTestService.urlOf("http://host:8188///")).toBe("http://host:8188");
    expect(ComfyUiSelfTestService.urlOf(" host ")).toBe("http://host");
    expect(ComfyUiSelfTestService.urlOf("")).toBeNull();
    expect(ComfyUiSelfTestService.urlOf("http://")).toBeNull();
    expect(ComfyUiSelfTestService.urlOf("http://a b")).toBeNull();
  });
});

describe("ComfyUiSelfTestService.imageInfoOf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-head-"));

  it("reads the size a PNG says it has", () => {
    const png = path.join(dir, "a.png");
    fs.writeFileSync(png, pngOf(64, 32));
    expect(ComfyUiSelfTestService.imageInfoOf(png)).toEqual({ format: "PNG", width: 64, height: 32 });
  });

  it("reads the size a JPEG says it has", () => {
    // the shortest honest JPEG header: SOI, then an SOF0 with the frame size
    const jpeg = Buffer.alloc(32);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[2] = 0xff;
    jpeg[3] = 0xc0;
    jpeg.writeUInt16BE(17, 4); // segment length
    jpeg[6] = 8; // precision
    jpeg.writeUInt16BE(48, 7); // height
    jpeg.writeUInt16BE(64, 9); // width
    const file = path.join(dir, "a.jpg");
    fs.writeFileSync(file, jpeg);
    expect(ComfyUiSelfTestService.imageInfoOf(file)).toEqual({ format: "JPEG", width: 64, height: 48 });
  });

  it("recognizes a WebP without a size", () => {
    const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(8)]);
    const file = path.join(dir, "a.webp");
    fs.writeFileSync(file, webp);
    expect(ComfyUiSelfTestService.imageInfoOf(file)).toEqual({ format: "WebP" });
  });

  it("is null for something that is not a picture", () => {
    const text = path.join(dir, "not-a-picture");
    fs.writeFileSync(text, "<html><body>502 Bad Gateway</body></html>");
    expect(ComfyUiSelfTestService.imageInfoOf(text)).toBeNull();
    expect(ComfyUiSelfTestService.imageInfoOf(path.join(dir, "missing.png"))).toBeNull();
  });
});
