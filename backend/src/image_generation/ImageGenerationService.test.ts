import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { PathHelper } from "../shared/PathHelper";
import { ImageMetaService } from "../images/ImageMetaService";
import { ImageGenerationRecord } from "../shared/ImageMeta";
import { TextGenerationService } from "../text_generation/TextGenerationService";
import { ImageGenerationService } from "./ImageGenerationService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { ComfyUiSettings } from "../configuration/ComfyUiSettings";
import { Config } from "../configuration/Config";
import { ImageJobResult } from "./ImageJobResult";

// Isolate the data root: an image id is a path relative to it and only the ids
// inside it are accepted, so the folders used below must not be the real
// ~/.config/sillytalk (the accessors read the env on every call).
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-images-"));
process.env.SILLYTALK_DATA_DIR = dataRoot;

// The config is stubbed: a job whose driver cache is empty re-probes it, and
// the tests must not depend on the real config.json contents.
class EmptyConfigurationService extends ConfigurationService {
  loadConfig(): Config {
    return { listen: "127.0.0.1:3210", llmModels: {}, imageGenerators: [] };
  }
}

// One service instance for the whole suite — the state (the availability
// cache and the job registry) lives on the instance, and the tests recompute
// the availability via refreshAvailableGenerators as needed. The service is
// chat-agnostic: a job is given an image id and settles a result.
const configuration = new EmptyConfigurationService();
// The images table the finished job writes its story to — the one place a
// picture's prompt and description are kept.
const imageMeta = new ImageMetaService(() => dataRoot);
const images = new ImageGenerationService(new TextGenerationService(configuration), configuration, imageMeta);

// The id of a picture of a chat — the way a message and the API address it: a
// path relative to the data folder, with "/" separators.
function imageId(chatId: string, name: string): string {
  return PathHelper.imageIdOf(path.join(PathHelper.chatDir(chatId), name));
}
// The absolute path an id addresses (the file the generator has to write).
function imageFile(chatId: string, name: string): string {
  return path.join(PathHelper.chatDir(chatId), name);
}

// ------------------------------------------------------------------ mock server
// The bytes the mock server hands out for a finished picture. The driver only
// writes what it downloaded, so the test compares the bytes instead of asking
// a real PNG decoder.
const PICTURE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("a picture from the mock server")]);

// One model of the mock plugin's catalogue. `max_refs` is what the app is told
// a model takes, and the only place the app learns it — the app ships no
// workflow files of its own any more.
type MockModel = {
  code: string;
  max_refs: number;
  orientation?: string;
  sizes?: Record<string, [number, number]>;
  model_file?: string | null;
  model_files?: { folder: string; options: { name: string; mb?: number }[] };
  loras?: { max: number; options: { name: string; mb?: number }[] };
  steps?: { min: number; max: number; default?: number };
};

// The two folders a client may pick from, as one of these mock servers has them.
const MOCK_FILES = [
  { name: "qwen_image_2.1_int8_convrot.safetensors", mb: 6919 },
  { name: "my_qwen_derivative.safetensors", mb: 20000 },
];
const MOCK_LORAS = [
  { name: "style-a.safetensors", mb: 200 },
  { name: "style-b.safetensors", mb: 400 },
];
const MOCK_SIZES: Record<string, [number, number]> = {
  square: [1328, 1328],
  portrait: [1140, 1472],
  landscape: [1472, 1140],
};

// The fields and the picture parts of a multipart request, read the crude way:
// split on the boundary the client announced and look at each part's header.
function readMultipart(headers: Record<string, unknown>, raw: Buffer): { fields: Record<string, string>; files: { filename: string; bytes: number }[] } {
  const declared = String(headers["content-type"] ?? "");
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(declared)?.[1] ?? /boundary=([^;]+)/i.exec(declared)?.[1];
  const fields: Record<string, string> = {};
  const files: { filename: string; bytes: number }[] = [];
  if (!boundary) return { fields, files };
  for (const part of raw.toString("binary").split(`--${boundary}`)) {
    const cut = part.indexOf("\r\n\r\n");
    if (cut < 0) continue;
    const head = part.slice(0, cut);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const body = part.slice(cut + 4).replace(/\r\n$/, "");
    if (filename === undefined) fields[name] = body;
    else files.push({ filename, bytes: Buffer.byteLength(body, "binary") });
  }
  return { fields, files };
}

// What one submitted job looked like on the server.
interface MockJob {
  id: string;
  // what the app sent for this run
  model: string;
  prompt: string;
  orientation: unknown;
  // every text field of the request, so a test can see what the app sent — and
  // what it no longer sends (a workflow, a device, a seed, a pixel size)
  fields: Record<string, string>;
  // the file names the reference parts arrived under, and how big each was
  refs: string[];
  refBytes: number[];
  finishesAt: number;
  fails: boolean;
  cancelled: boolean;
}

// A stand-in for a ComfyUI server running the comfyui-sillytalk plugin: the
// built-in system_stats probe plus the plugin's own routes — the catalogue, the
// job, its picture and its cancellation. What a job does is decided by the
// prompt text the app sent: "fail" — the server fails it, "hang" — it never
// finishes.
// Everything the app sent is recorded, so a test can read the run back.
interface MockComfy {
  url: string;
  close(): Promise<void>;
  reset(): void;
  jobs: MockJob[];
  /** The catalogue this server offers (a test narrows it to what it needs). */
  models: MockModel[];
  /** The server has no comfyui-sillytalk installed: every /sillytalk route 404s. */
  noPlugin: boolean;
  /** How often the catalogue was asked for — the probes, not the draws. */
  probes: number;
  // the job ids the client asked the server to drop (the cancel path)
  cancelled: string[];
  // "start <id>" when a job was queued, "finish <id>" when its picture was
  // downloaded — the order of these lines is how a queue test sees the runs
  // serialize one behind the other and a parallel test sees them overlap
  log: string[];
}

function startMockComfy(): Promise<MockComfy> {
  const mock: MockComfy = {
    url: "",
    close: () => Promise.resolve(),
    reset: () => undefined,
    jobs: [],
    models: [
      {
        code: "qwen-image-2.1",
        max_refs: 2,
        orientation: "square",
        sizes: MOCK_SIZES,
        model_file: MOCK_FILES[0].name,
        model_files: { folder: "diffusion_models", options: MOCK_FILES },
        loras: { max: 5, options: MOCK_LORAS },
        steps: { min: 4, max: 50, default: 25 },
      },
      { code: "qwen-image-2512", max_refs: 2, orientation: "square", sizes: MOCK_SIZES, model_file: null },
      { code: "text-only-model", max_refs: 0, orientation: "square", sizes: { square: [1024, 1024] }, model_file: null },
    ],
    noPlugin: false,
    probes: 0,
    cancelled: [],
    log: [],
  };
  let nextId = 1;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://comfy.test");
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const route = `${req.method} ${url.pathname}`;
      try {
        if (route === "GET /system_stats") return send(200, { system: { comfyui_version: "0.0.0-mock" } });

        // Everything below is the plugin. Without it the server is a plain
        // ComfyUI, and this app has nothing to say to a plain ComfyUI.
        if (url.pathname.startsWith("/sillytalk")) {
          // A probe that was refused is still a probe — the app asked the
          // server what it offers, which is what the count is for.
          if (url.pathname === "/sillytalk/models") mock.probes++;
          if (mock.noPlugin) return send(404, { error: "Not Found" });

          if (route === "GET /sillytalk/models") {
            return send(200, { models: mock.models });
          }

          if (route === "GET /sillytalk/health") {
            return send(200, {
              name: "comfyui-sillytalk",
              version: "1.0.0-mock",
              comfyui_version: "0.0.0-mock",
              workflow_dir: "/mock/workflows",
              models: mock.models.map((m) => m.code),
              broken_workflows: [],
              devices: [{ device: "cuda:0", name: "Mock Card", vram_total_mb: 24560, vram_free_mb: 24000 }],
              resident_models: [],
            });
          }

          if (route === "POST /sillytalk/generate") {
            const { fields, files } = readMultipart(req.headers, raw);
            if (!fields.model || !fields.prompt) {
              return send(400, { error: "the 'model' and 'prompt' fields are required" });
            }
            const known = mock.models.find((m) => m.code === fields.model);
            if (!known) return send(400, { error: `no workflow named '${fields.model}' in this server's catalogue` });
            if (files.length > known.max_refs) {
              return send(400, {
                error: `the '${fields.model}' workflow takes at most ${known.max_refs} reference image(s), ${files.length} were sent`,
              });
            }
            const id = `mock-${nextId++}`;
            mock.jobs.push({
              id,
              model: fields.model,
              prompt: fields.prompt,
              orientation: fields.orientation,
              fields,
              refs: files.map((f) => f.filename),
              refBytes: files.map((f) => f.bytes),
              // A job that "hangs" is never finished — the client gives up or
              // cancels it; anything else is drawn almost at once.
              finishesAt: Date.now() + (/hang/i.test(fields.prompt) ? 3_600_000 : 150),
              fails: /fail/i.test(fields.prompt),
              cancelled: false,
            });
            mock.log.push(`start ${id}`);
            return send(202, { job_id: id, model: fields.model, status: "queued", placements: [] });
          }

          // The user stopped waiting: the job goes, and with it the picture the
          // server may already have written.
          if (req.method === "DELETE" && /^\/sillytalk\/jobs\/[^/]+$/.test(url.pathname)) {
            const id = decodeURIComponent(url.pathname.slice("/sillytalk/jobs/".length));
            const job = mock.jobs.find((j) => j.id === id);
            if (job) job.cancelled = true;
            mock.cancelled.push(id);
            return send(200, { job_id: id, status: "cancelled" });
          }

          const jobRoute = /^\/sillytalk\/jobs\/([^/]+)(\/image)?$/.exec(url.pathname);
          if (jobRoute) {
            const id = decodeURIComponent(jobRoute[1]);
            const job = mock.jobs.find((j) => j.id === id);
            if (!job) return send(404, { error: "no such job on this server" });
            if (jobRoute[2]) {
              if (job.fails || job.cancelled) return send(410, { error: "the job has no picture to send" });
              if (Date.now() < job.finishesAt) return send(409, { error: "the job is still running" });
              mock.log.push(`finish ${job.id}`);
              res.writeHead(200, { "Content-Type": "image/png" });
              res.end(PICTURE);
              return;
            }
            if (job.cancelled) return send(200, { job_id: id, status: "cancelled" });
            if (job.fails) return send(200, { job_id: id, status: "failed", error: "the mock server ran out of patience" });
            if (Date.now() < job.finishesAt) return send(200, { job_id: id, status: "running" });
            // The size behind the orientation is the server's answer, not the
            // app's — which is what the job's own width/height are for.
            const size = MOCK_SIZES[job.fields.orientation ?? "square"] ?? MOCK_SIZES.square;
            return send(200, {
              job_id: id,
              status: "succeeded",
              seconds: 0.2,
              orientation: job.fields.orientation,
              width: size[0],
              height: size[1],
              model_file: job.fields.model_file || MOCK_FILES[0].name,
              loras: job.fields.loras ? JSON.parse(job.fields.loras) : [],
              placements: [{ node: "1", class: "UNETLoaderMultiGPU", device: "cuda:0", mb: 12000 }],
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
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      mock.url = `http://127.0.0.1:${port}`;
      mock.close = () => new Promise<void>((done) => server.close(() => done()));
      mock.reset = () => {
        mock.jobs = [];
        mock.probes = 0;
        mock.cancelled = [];
        mock.log = [];
        mock.noPlugin = false;
      };
      resolve(mock);
    });
  });
}

// A ComfyUI generator pointed at one of the mock servers.
function comfyGen(comfy: MockComfy, over: Partial<ComfyUiSettings> = {}): ComfyUiSettings {
  return {
    kind: "comfyui",
    url: comfy.url,
    model: "qwen-image-2.1",
    orientation: "landscape",
    enabled: true,
    ...over,
  };
}

const chatIdDefault = "jest-comfy-test";

// One generation through the production path: the service is told about one
// generator and asked for one picture (the reserved id is given by the test).
async function oneShot(
  gen: ComfyUiSettings,
  prompt: string,
  refs: string[],
  name: string,
  chatId = chatIdDefault,
): Promise<ImageJobResult> {
  await images.refreshAvailableGenerators([gen]);
  return images.startImageJob({ id: imageId(chatId, name), prompt, refs }).result;
}

let comfy: MockComfy;
let comfy2: MockComfy;

beforeAll(async () => {
  comfy = await startMockComfy();
  comfy2 = await startMockComfy();
  // start each test run from an empty picture folder of the default chat
  fs.rmSync(PathHelper.chatDir(chatIdDefault), { recursive: true, force: true });
});

afterAll(async () => {
  await images.refreshAvailableGenerators([]);
  await comfy.close();
  await comfy2.close();
  // The database file must be closed before its folder goes (Windows keeps an
  // open file locked and the delete would fail).
  imageMeta.close();
  fs.rmSync(PathHelper.chatDir(chatIdDefault), { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  comfy.reset();
  comfy2.reset();
});

// ------------------------------------------------------------------ the driver
describe("ComfyUI generator", () => {
  it("sends the prompt and the orientation, and writes the picture back", async () => {
    const r = await oneShot(comfyGen(comfy), "a red boat at dusk", [], "substituted.png");
    expect(r.status).toBe("ok");
    const job = comfy.jobs[0];
    expect(job.model).toBe("qwen-image-2.1");
    expect(job.prompt).toBe("a red boat at dusk");
    expect(job.orientation).toBe("landscape");
    // …and that is the whole request. No graph (the plugin owns the workflows),
    // no device (the plugin picks the cards from the VRAM free when the job
    // arrives), no seed (the plugin draws one and reports it with the job) and
    // no pixel size (the server answers an orientation with its own numbers).
    expect(Object.keys(job.fields).sort()).toEqual(["model", "orientation", "prompt"]);
    // the bytes the server served are the bytes the chat shows
    expect(fs.readFileSync(imageFile(chatIdDefault, "substituted.png"))).toEqual(PICTURE);
  }, 30000);

  it("sends the model file and the LoRAs the generator was configured with", async () => {
    const gen = comfyGen(comfy, {
      modelFile: "my_qwen_derivative.safetensors",
      loras: [{ name: "style-a.safetensors" }, { name: "style-b.safetensors", strength: 0.6 }],
    });
    const r = await oneShot(gen, "a red boat at dusk", [], "with-loras.png");
    expect(r.status).toBe("ok");
    const job = comfy.jobs[0];
    expect(job.fields.model_file).toBe("my_qwen_derivative.safetensors");
    expect(JSON.parse(job.fields.loras)).toEqual([
      { name: "style-a.safetensors" },
      { name: "style-b.safetensors", strength: 0.6 },
    ]);
  }, 30000);

  it("sends the step count the generator was configured with", async () => {
    const gen = comfyGen(comfy, { steps: 8 });
    const r = await oneShot(gen, "a red boat at dusk", [], "with-steps.png");
    expect(r.status).toBe("ok");
    expect(comfy.jobs[0].fields.steps).toBe("8");
  }, 30000);

  it("sends neither a file, LoRAs nor steps when the generator named none", async () => {
    const r = await oneShot(comfyGen(comfy), "a red boat at dusk", [], "plain-defaults.png");
    expect(r.status).toBe("ok");
    const fields = comfy.jobs[0].fields;
    expect(fields.model_file).toBeUndefined();
    expect(fields.loras).toBeUndefined();
    expect(fields.steps).toBeUndefined();
  }, 30000);

  it("sends the reference pictures with the job, in the order they were given", async () => {
    fs.mkdirSync(PathHelper.chatDir(chatIdDefault), { recursive: true });
    const refs: string[] = [];
    for (const name of ["first-ref.png", "second-ref.png"]) {
      fs.writeFileSync(imageFile(chatIdDefault, name), `the bytes of ${name}`);
      refs.push(imageId(chatIdDefault, name));
    }

    const gen = comfyGen(comfy);
    expect((await oneShot(gen, "no reference", [], "wf-text.png")).status).toBe("ok");
    expect(comfy.jobs[0].refs).toEqual([]);

    expect((await oneShot(gen, "one reference", [refs[0]], "wf-one.png")).status).toBe("ok");
    expect(comfy.jobs[1].refs).toEqual(["first-ref.png"]);
    expect(comfy.jobs[1].refBytes).toEqual([Buffer.byteLength("the bytes of first-ref.png")]);

    expect((await oneShot(gen, "two references", refs, "wf-two.png")).status).toBe("ok");
    expect(comfy.jobs[2].refs).toEqual(["first-ref.png", "second-ref.png"]);
  }, 60000);

  it("asks the server for its catalogue once per refresh, not once per picture", async () => {
    // One refresh means one driver instance, and what it learned about the
    // server — the model, how many references it takes — belongs to it.
    const gen = comfyGen(comfy);
    await images.refreshAvailableGenerators([gen]);
    expect(comfy.probes).toBe(1);
    await images.startImageJob({ id: imageId(chatIdDefault, "probe-1.png"), prompt: "p", refs: [] })
      .result;
    await images.startImageJob({ id: imageId(chatIdDefault, "probe-2.png"), prompt: "p", refs: [] })
      .result;
    expect(comfy.jobs).toHaveLength(2);
    expect(comfy.probes).toBe(1);
  }, 60000);

  it("drops the references the model has no room for, instead of failing", async () => {
    // The plan is made for the strongest generator the user configured; the job
    // can still land on one that takes fewer. Dropping the extra reference keeps
    // the picture (with the faces that did fit) instead of leaving a broken card.
    fs.mkdirSync(PathHelper.chatDir(chatIdDefault), { recursive: true });
    const refs: string[] = [];
    for (const name of ["a.png", "b.png", "c.png"]) {
      fs.writeFileSync(imageFile(chatIdDefault, name), "x");
      refs.push(imageId(chatIdDefault, name));
    }
    // the server says this model takes two, and that is the number the app may
    // promise the user — it comes from the server, not from a template
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    expect(images.maxReferenceCount()).toBe(2);
    const r = await oneShot(comfyGen(comfy), "three of them", refs, "too-many-refs.png");
    expect(r.status).toBe("ok");
    // the first two of them are what the server's workflow could load
    expect(comfy.jobs).toHaveLength(1);
    expect(comfy.jobs[0].refs).toEqual(["a.png", "b.png"]);
  });

  it("is not available for a model the server does not offer", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy, { model: "flux-dev" })]);
    expect(images.hasAvailableGenerator()).toBe(false);
    const job = images.startImageJob({ id: imageId(chatIdDefault, "no-model.png"), prompt: "p", refs: [] });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/not configured/);
  });

  it("is not available while the server does not answer", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy, { url: "http://127.0.0.1:1/" })]);
    expect(images.hasAvailableGenerator()).toBe(false);
  });

  it("names the plugin custom node when the server has none", async () => {
    // A plain ComfyUI is not a generator this app can use, and the reason has
    // to say what to install — otherwise the user is left guessing why a server
    // that is clearly up does not appear.
    comfy.noPlugin = true;
    const logged: string[] = [];
    const spy = jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    try {
      const r = await oneShot(comfyGen(comfy), "p", [], "no-plugin.png");
      expect(r.status).toBe("failed");
      expect(comfy.probes).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const lines = logged.join("\n");
    expect(lines).toContain("/sillytalk/models");
    expect(lines).toContain("comfyui-sillytalk");
    // nothing was ever queued, because nothing could be
    expect(comfy.jobs).toEqual([]);
  });

  it("carries the message of a job the server failed", async () => {
    const r = await oneShot(comfyGen(comfy), "please fail here", [], "server-fail.png");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error).toContain("is failed");
      expect(r.error).toContain("ran out of patience");
    }
    expect(fs.existsSync(imageFile(chatIdDefault, "server-fail.png"))).toBe(false);
  }, 30000);

  it("tells the server to drop a picture the user cancelled", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const id = imageId(chatIdDefault, "cancel-server.png");
    const job = images.startImageJob({ id, prompt: "a picture that hangs forever", refs: [] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    job.cancel();
    const r = await job.result;
    expect(r.status).toBe("cancelled");
    // the job is deleted on the server, so the GPU is free for the next one
    await new Promise((resolve) => setTimeout(resolve, 300));
    const jobId = comfy.jobs[0]?.id;
    expect(jobId).toBeTruthy();
    expect(comfy.cancelled).toEqual([jobId]);
    expect(fs.existsSync(imageFile(chatIdDefault, "cancel-server.png"))).toBe(false);
  }, 30000);
});

// ------------------------------------------------------------------ the service
describe("background image jobs", () => {
  const jobChatId = "jest-image-job-test";

  async function runJob(
    name: string,
    opts: { prompt?: string; refs?: string[]; meta?: ImageGenerationRecord } = {},
  ): Promise<ImageJobResult> {
    const job = images.startImageJob({
      id: imageId(jobChatId, name),
      prompt: opts.prompt ?? "p",
      refs: opts.refs ?? [],
      meta: opts.meta,
    });
    return job.result;
  }

  beforeAll(() => {
    fs.rmSync(PathHelper.chatDir(jobChatId), { recursive: true, force: true });
  });

  afterAll(async () => {
    await images.refreshAvailableGenerators([]);
    fs.rmSync(PathHelper.chatDir(jobChatId), { recursive: true, force: true });
  });

  it("writes the picture to the reserved name and records its story in its row", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const id = imageId(jobChatId, "job-ready.png");
    const job = images.startImageJob({
      id,
      prompt: "a red boat at dusk",
      refs: [],
      meta: { prompt: "a red boat at dusk", source: "auto", model: "m1", width: 512, height: 512, steps: 20 },
    });
    const r = await job.result;
    expect(r.status).toBe("ok");
    const file = imageFile(jobChatId, "job-ready.png");
    // the bytes the server sent, and nothing else
    expect(fs.readFileSync(file)).toEqual(PICTURE);
    // the row of the picture in the images table carries its generation data —
    // keyed by exactly the id a card and the API use
    const stored = imageMeta.get(id);
    expect(stored).toMatchObject({
      prompt: "a red boat at dusk",
      source: "auto",
      model: "m1",
      width: 512,
      height: 512,
      steps: 20,
    });
    // which generator made it — the server and the model of it
    expect(stored?.generator).toBe(`comfyui:${comfy.url}#qwen-image-2.1`);
    // the job is off the registry once it settled
    expect(images.getCurrentJob(id)).toBeUndefined();
  }, 30000);

  it("a description written while the job ran survives the row write", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const id = imageId(jobChatId, "job-caption.png");
    const file = imageFile(jobChatId, "job-caption.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    imageMeta.set(id, { description: "what the user says it shows" });
    const r = await runJob("job-caption.png", { prompt: "a red boat", meta: { prompt: "a red boat", source: "manual" } });
    expect(r.status).toBe("ok");
    // the job merges: it adds how the picture was made, it does not replace what
    // the picture is
    expect(imageMeta.get(id)).toMatchObject({
      description: "what the user says it shows",
      prompt: "a red boat",
    });
  }, 30000);

  it("only the references that are really pictures of the data folder reach the server", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    fs.mkdirSync(PathHelper.chatDir(jobChatId), { recursive: true });
    const real = imageFile(jobChatId, "a-real-reference.png");
    fs.writeFileSync(real, "x");
    const r = await runJob("job-refs.png", {
      prompt: "from one reference",
      refs: [imageId(jobChatId, "a-real-reference.png"), "/etc/passwd", `${jobChatId}/files/gone.png`, "../out.png"],
    });
    expect(r.status).toBe("ok");
    // the three paths that are not a picture of the data folder never left the
    // app: the server saw one part, of the one real file
    expect(comfy.jobs[0].refs).toEqual(["a-real-reference.png"]);
    expect(comfy.jobs[0].refBytes).toEqual([1]);
  }, 30000);

  it("refuses an id that points outside the data folders", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const job = images.startImageJob({ id: "../../escaped.png", prompt: "p", refs: [] });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/Unknown image id/);
    expect(fs.existsSync(path.join(PathHelper.configDir(), "..", "escaped.png"))).toBe(false);
  });

  it("a failed generation leaves the row of the old picture alone", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const name = "job-fail-old-picture.png";
    const id = imageId(jobChatId, name);
    const file = imageFile(jobChatId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old image");
    imageMeta.set(id, { description: "the old scene", prompt: "the old prompt" });
    const r = await runJob(name, { prompt: "this one will fail" });
    expect(r.status).toBe("failed");
    expect(fs.readFileSync(file, "utf-8")).toBe("old image");
    expect(imageMeta.get(id)).toMatchObject({ description: "the old scene", prompt: "the old prompt" });
  }, 30000);

  it("a failed regeneration keeps the older image (hadOld)", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const name = "job-keepold.png";
    const file = imageFile(jobChatId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old image");
    const r = await runJob(name, { prompt: "fail again" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.hadOld).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("old image");
  }, 30000);

  it('a cancel stops the run and resolves to "cancelled", no file left', async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const name = "job-cancel.png";
    const id = imageId(jobChatId, name);
    const job = images.startImageJob({
      id,
      prompt: "hang until cancelled",
      refs: [],
    });
    expect(images.getCurrentJob(id)).toBe(job);
    setTimeout(() => job.cancel(), 500);
    const r = await job.result;
    expect(r.status).toBe("cancelled");
    if (r.status === "cancelled") expect(r.hadOld).toBe(false);
    expect(fs.existsSync(imageFile(jobChatId, name))).toBe(false);
  }, 30000);

  it("cancelJob stops the job of an image by its id", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const id = imageId(jobChatId, "job-cancel-by-id.png");
    images.startImageJob({ id, prompt: "hang forever", refs: [] });
    setTimeout(() => images.cancelJob(id), 500);
    // the same job is found again by the id alone — the registry is keyed by it
    expect(images.getCurrentJob(id)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(images.getCurrentJob(id)).toBeUndefined();
    expect(images.cancelJob(id)).toBe(false);
  }, 30000);

  it("cancelAllJobs cancels a running job (the server-shutdown path)", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const name = "job-shutdown.png";
    const job = images.startImageJob({ id: imageId(jobChatId, name), prompt: "hang on shutdown", refs: [] });
    setTimeout(() => images.cancelAllJobs(), 500);
    const r = await job.result;
    expect(r.status).toBe("cancelled");
    expect(fs.existsSync(imageFile(jobChatId, name))).toBe(false);
  }, 30000);

  it("a job whose owner was deleted while it waited does not write anything", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy)]);
    const goneChat = "jest-image-gone-chat";
    const id = imageId(goneChat, "orphan.png");
    // the guard is consulted when the job STARTS, not when it is queued: the
    // deletion happens in the window between the two, exactly as a chat deleted
    // while the job waited in the queue would
    let deleted = false;
    const job = images.startImageJob({ id, prompt: "p", refs: [], gone: () => deleted });
    deleted = true;
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/chat was deleted/);
    // nothing was recreated: not the chat's folder, not the picture
    expect(fs.existsSync(PathHelper.chatDir(goneChat))).toBe(false);
    expect(fs.existsSync(imageFile(goneChat, "orphan.png"))).toBe(false);
  }, 30000);

  it("enabled defaults to true: a generator without the field is available", async () => {
    const gen = comfyGen(comfy);
    delete gen.enabled;
    await images.refreshAvailableGenerators([gen]);
    expect(images.hasAvailableGenerator()).toBe(true);
  });

  it("skips a disabled generator (enabled: false)", async () => {
    const disabled = comfyGen(comfy, { enabled: false });
    await images.refreshAvailableGenerators([disabled]);
    expect(images.hasAvailableGenerator()).toBe(false);
    const r = await images.startImageJob({
      id: imageId(jobChatId, "job-disabled.png"),
      prompt: "p",
      refs: [],
    }).result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/not configured/);
  });

  it("does not generate without an available generator", async () => {
    await images.refreshAvailableGenerators([]);
    const job = images.startImageJob({ id: imageId(jobChatId, "nogen.png"), prompt: "p", refs: [] });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/not configured/);
  });

  it("runs the jobs in parallel on different generators", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy), comfyGen(comfy2)]);
    const t0 = Date.now();
    const p1 = images.startImageJob({ id: imageId(jobChatId, "par-1.png"), prompt: "one", refs: [] })
      .result;
    const p2 = images.startImageJob({ id: imageId(jobChatId, "par-2.png"), prompt: "two", refs: [] })
      .result;
    const r1 = await p1;
    const r2 = await p2;
    const totalMs = Date.now() - t0;
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    // Each server got one job and carried it through to the download…
    expect(comfy.log.map((line) => line.split(" ")[0])).toEqual(["start", "finish"]);
    expect(comfy2.log.map((line) => line.split(" ")[0])).toEqual(["start", "finish"]);
    // …and they did it side by side: one run takes ~2s (the history is polled
    // every 2s), so two of them one behind the other would take ~4s.
    expect(totalMs).toBeLessThan(4000);
  }, 60000);

  it("queues the jobs of one generator (one run at a time, in order)", async () => {
    const gen = comfyGen(comfy);
    await images.refreshAvailableGenerators([gen]);
    const [r1, r2] = await Promise.all([
      images.startImageJob({ id: imageId(jobChatId, "q-1.png"), prompt: "first", refs: [] }).result,
      images.startImageJob({ id: imageId(jobChatId, "q-2.png"), prompt: "second", refs: [] }).result,
    ]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    // One run at a time: the first picture was downloaded before the second job
    // was even submitted.
    expect(comfy.log.map((line) => line.split(" ")[0])).toEqual(["start", "finish", "start", "finish"]);
  }, 60000);

  it("queues the generators of one server together and gives them the jobs in turn", async () => {
    // Two entries, the same URL, different models: they are different
    // generators but they share one GPU, so one queue.
    await images.refreshAvailableGenerators([
      comfyGen(comfy, { model: "qwen-image-2.1" }),
      comfyGen(comfy, { model: "qwen-image-2512" }),
    ]);
    const [r1, r2] = await Promise.all([
      images.startImageJob({ id: imageId(jobChatId, "same-1.png"), prompt: "first", refs: [] }).result,
      images.startImageJob({ id: imageId(jobChatId, "same-2.png"), prompt: "second", refs: [] }).result,
    ]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(comfy.log.map((line) => line.split(" ")[0])).toEqual(["start", "finish", "start", "finish"]);
    // …and each of them asked the server for its own model.
    expect(comfy.jobs.map((j) => j.model).sort()).toEqual(["qwen-image-2.1", "qwen-image-2512"]);
  }, 60000);
});
