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
import { comfyUiModelNames } from "./comfyui/ComfyUiWorkflows";

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
  return PathHelper.imageIdOf(path.join(PathHelper.chatFilesDir(chatId), name));
}
// The absolute path an id addresses (the file the generator has to write).
function imageFile(chatId: string, name: string): string {
  return path.join(PathHelper.chatFilesDir(chatId), name);
}

// ------------------------------------------------------------------ mock server
// The bytes the mock server hands out for a finished picture. The driver only
// writes what it downloaded, so the test compares the bytes instead of asking
// a real PNG decoder.
const PICTURE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("a picture from the mock server")]);

// The API-format workflow the mock converter answers with: the placeholders of
// the variant the driver asked about, in nodes the test can pick by class_type.
function apiWorkflowOf(variant: "text" | "oneImage" | "twoImages"): Record<string, unknown> {
  const nodes: Record<string, unknown> = {
    "1": { class_type: "UNETLoaderMultiGPU", inputs: { unet_name: "model.safetensors", device: "PARAM_DEVICE" } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT", clip: ["4", 0] } },
    "9": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: "PARAM_INT_OUTPUT_IMAGE_WIDTH", height: "PARAM_INT_OUTPUT_IMAGE_HEIGHT", batch_size: 1 },
    },
    "10": { class_type: "KSampler", inputs: { seed: "PARAM_SEED", steps: 4, model: ["3", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "PARAM_STRING_OUTPUT_IMAGE_FILENAME" } },
  };
  if (variant === "oneImage") {
    nodes["20"] = { class_type: "LoadImage", inputs: { image: "PARAM_STRING_INPUT_IMAGE_FILENAME" } };
  }
  if (variant === "twoImages") {
    nodes["20"] = { class_type: "LoadImage", inputs: { image: "PARAM_STRING_INPUT_IMAGE_FILENAME_1" } };
    nodes["21"] = { class_type: "LoadImage", inputs: { image: "PARAM_STRING_INPUT_IMAGE_FILENAME_2" } };
  }
  return nodes;
}

// What one submitted job looked like on the server.
interface MockJob {
  id: string;
  // the values the driver substituted into the workflow
  prompt: string;
  width: unknown;
  height: unknown;
  seed: unknown;
  device: unknown;
  prefix: unknown;
  refs: unknown[];
  // the whole workflow, so a test can look for anything left unsubstituted
  workflow: string;
  finishesAt: number;
  fails: boolean;
}

// A stand-in for a ComfyUI server, carrying the part of the API the driver
// uses: the built-in system_stats probe, the workflow converter (the custom
// node), POST /upload/image, the /prompt queue, GET /history and GET /view.
// What a job does is decided by the prompt text the driver put into the
// workflow: "fail" — the server fails it, "hang" — it never finishes.
// Everything the driver sent is recorded, so a test can read the workflow back.
interface MockComfy {
  url: string;
  close(): Promise<void>;
  reset(): void;
  jobs: MockJob[];
  uploads: string[];
  // the template variants the converter was asked about (once per driver run)
  converted: string[];
  // the prompt ids the client asked the server to drop (the cancel path)
  cancelled: string[];
  // "start <id>" when a job was queued, "finish <id>" when its picture was
  // downloaded — the order of these lines is how a queue test sees the runs
  // serialize one behind the other and a parallel test sees them overlap
  log: string[];
  // the server has no converter custom node installed
  noConverter: boolean;
}

function startMockComfy(): Promise<MockComfy> {
  const mock: MockComfy = {
    url: "",
    close: () => Promise.resolve(),
    reset: () => undefined,
    jobs: [],
    uploads: [],
    converted: [],
    cancelled: [],
    log: [],
    noConverter: false,
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
        if (route === "GET /system_stats") return send(200, { system: "mock" });

        if (route === "POST /workflow/convert") {
          if (mock.noConverter) return send(404, { error: "Not Found" });
          const ui = raw.toString("utf-8");
          const variant = ui.includes("PARAM_STRING_INPUT_IMAGE_FILENAME_1")
            ? "twoImages"
            : ui.includes("PARAM_STRING_INPUT_IMAGE_FILENAME")
              ? "oneImage"
              : "text";
          mock.converted.push(variant);
          return send(200, apiWorkflowOf(variant));
        }

        if (route === "POST /upload/image") {
          const name = /filename="([^"]+)"/.exec(raw.toString("binary"))?.[1] ?? "unnamed.png";
          mock.uploads.push(name);
          return send(200, { name, subfolder: "", type: "input" });
        }

        if (route === "POST /prompt") {
          const submitted = (JSON.parse(raw.toString("utf-8")) as { prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> }).prompt;
          const nodes = Object.values(submitted);
          const inputsOf = (classType: string): Record<string, unknown> =>
            nodes.find((n) => n?.class_type === classType)?.inputs ?? {};
          const text = String(inputsOf("CLIPTextEncode").text ?? "");
          const id = `mock-${nextId++}`;
          const prefix = String(inputsOf("SaveImage").filename_prefix ?? "");
          mock.jobs.push({
            id,
            prompt: text,
            width: inputsOf("EmptySD3LatentImage").width,
            height: inputsOf("EmptySD3LatentImage").height,
            seed: inputsOf("KSampler").seed,
            device: inputsOf("UNETLoaderMultiGPU").device,
            prefix,
            refs: nodes.filter((n) => n?.class_type === "LoadImage").map((n) => n?.inputs?.image),
            workflow: JSON.stringify(submitted),
            // A job that "hangs" is never finished — the client gives up or
            // cancels it; anything else is drawn almost at once.
            finishesAt: Date.now() + (/hang/i.test(text) ? 3_600_000 : 150),
            fails: /fail/i.test(text),
          });
          mock.log.push(`start ${id}`);
          return send(200, { prompt_id: id, node_errors: {} });
        }

        if (url.pathname.startsWith("/history/")) {
          const id = decodeURIComponent(url.pathname.slice("/history/".length));
          const job = mock.jobs.find((j) => j.id === id);
          if (!job) return send(200, {}); // the server forgot it (removed from the queue)
          if (job.fails) {
            return send(200, {
              [id]: {
                status: {
                  status_str: "error",
                  completed: false,
                  messages: [["execution_error", { exception_message: "the mock server ran out of patience" }]],
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
              outputs: { "13": { images: [{ filename: `${job.prefix}_00001_.png`, subfolder: "", type: "output" }] } },
            },
          });
        }

        if (route === "GET /view") {
          const filename = url.searchParams.get("filename") ?? "";
          const job = mock.jobs.find((j) => filename.startsWith(String(j.prefix)));
          if (job) mock.log.push(`finish ${job.id}`);
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(PICTURE);
          return;
        }

        if (route === "POST /queue" || route === "POST /interrupt") {
          const body = JSON.parse(raw.toString("utf-8") || "{}") as { remove?: string[]; prompt_id?: string };
          for (const id of body.remove ?? []) mock.cancelled.push(`queue:${id}`);
          if (body.prompt_id) mock.cancelled.push(`interrupt:${body.prompt_id}`);
          return send(200, {});
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
        mock.uploads = [];
        mock.converted = [];
        mock.cancelled = [];
        mock.log = [];
        mock.noConverter = false;
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
    device: "cuda:2",
    width: 1664,
    height: 928,
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
  it("substitutes the prompt, the size, the seed and the GPU into the workflow of the model", async () => {
    const r = await oneShot(comfyGen(comfy), "a red boat at dusk", [], "substituted.png");
    expect(r.status).toBe("ok");
    const job = comfy.jobs[0];
    expect(job.prompt).toBe("a red boat at dusk");
    expect(job.width).toBe(1664);
    expect(job.height).toBe(928);
    expect(job.device).toBe("cuda:2");
    expect(typeof job.seed).toBe("number");
    // the file name SaveImage gets is unique per run and says which app made it
    expect(String(job.prefix)).toMatch(/^sillytalk_qwenimage21_\d{8}_\d{6}_\d+$/);
    // nothing of the template is left for the server to guess
    expect(job.workflow).not.toMatch(/PARAM_/);
  }, 30000);

  it("takes the template of the model that matches the number of references and uploads them into input/", async () => {
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    const refs: string[] = [];
    for (const name of ["first-ref.png", "second-ref.png"]) {
      fs.writeFileSync(imageFile(chatIdDefault, name), "x");
      refs.push(imageId(chatIdDefault, name));
    }

    const gen = comfyGen(comfy);
    expect((await oneShot(gen, "no reference", [], "wf-text.png")).status).toBe("ok");
    expect(comfy.converted).toEqual(["text"]);
    expect(comfy.uploads).toEqual([]);
    expect(comfy.jobs[0].refs).toEqual([]);

    expect((await oneShot(gen, "one reference", [refs[0]], "wf-one.png")).status).toBe("ok");
    expect(comfy.converted).toEqual(["text", "oneImage"]);
    expect(comfy.uploads).toHaveLength(1);
    expect(comfy.jobs[1].refs).toEqual([comfy.uploads[0]]);
    expect(comfy.uploads[0]).toMatch(/^ref_\d+_first-ref\.png$/);

    expect((await oneShot(gen, "two references", refs, "wf-two.png")).status).toBe("ok");
    expect(comfy.converted).toEqual(["text", "oneImage", "twoImages"]);
    expect(comfy.uploads).toHaveLength(3);
    expect(comfy.jobs[2].refs).toEqual([comfy.uploads[1], comfy.uploads[2]]);
  }, 60000);

  it("asks the server to convert a workflow once, not once per picture", async () => {
    // One refresh means one driver instance, and the conversion belongs to the
    // template, not to a run.
    const gen = comfyGen(comfy);
    await images.refreshAvailableGenerators([gen]);
    await images.startImageJob({ id: imageId(chatIdDefault, "conv-1.png"), prompt: "p", refs: [] })
      .result;
    await images.startImageJob({ id: imageId(chatIdDefault, "conv-2.png"), prompt: "p", refs: [] })
      .result;
    expect(comfy.jobs).toHaveLength(2);
    expect(comfy.converted).toEqual(["text"]);
  }, 60000);

  it("drops the references the model has no template for, instead of failing", async () => {
    // The plan is made for the strongest generator the user configured; the job
    // can still land on one that takes fewer. Dropping the extra reference keeps
    // the picture (with the faces that did fit) instead of leaving a broken card.
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    const refs: string[] = [];
    for (const name of ["a.png", "b.png", "c.png"]) {
      fs.writeFileSync(imageFile(chatIdDefault, name), "x");
      refs.push(imageId(chatIdDefault, name));
    }
    const r = await oneShot(comfyGen(comfy), "three of them", refs, "too-many-refs.png");
    expect(r.status).toBe("ok");
    // the first two of them are what the workflow could load
    expect(comfy.jobs).toHaveLength(1);
    expect(comfy.jobs[0].refs).toEqual([comfy.uploads[0], comfy.uploads[1]]);
  });

  it("is not available for a model the app has no workflow for", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy, { model: "flux-dev" })]);
    expect(images.hasAvailableGenerator()).toBe(false);
    const job = images.startImageJob({ id: imageId(chatIdDefault, "no-wf.png"), prompt: "p", refs: [] });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/not configured/);
  });

  it("is not available while the server does not answer", async () => {
    await images.refreshAvailableGenerators([comfyGen(comfy, { url: "http://127.0.0.1:1/" })]);
    expect(images.hasAvailableGenerator()).toBe(false);
  });

  it("names the converter custom node when the server has none", async () => {
    comfy.noConverter = true;
    const r = await oneShot(comfyGen(comfy), "p", [], "no-converter.png");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error).toContain("/workflow/convert");
      expect(r.error).toContain("comfyui-workflow-to-api-converter-endpoint");
    }
  });

  it("carries the message of a job the server failed", async () => {
    const r = await oneShot(comfyGen(comfy), "please fail here", [], "server-fail.png");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error).toContain("failed on the server");
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
    // it is taken out of the queue and interrupted, so the GPU is free again
    await new Promise((resolve) => setTimeout(resolve, 300));
    const promptId = comfy.jobs[0]?.id;
    expect(promptId).toBeTruthy();
    expect(comfy.cancelled).toEqual([`queue:${promptId}`, `interrupt:${promptId}`]);
    expect(fs.existsSync(imageFile(chatIdDefault, "cancel-server.png"))).toBe(false);
  }, 30000);
});

// --------------------------------------------------- the workflow files of the app
// A workflow is a JSON file, not compiled code: the app ships its own and the
// user can replace them or add models in <data root>/comfyui/. The files are
// read again for every job, so these tests write a file, run a job, and see the
// server get exactly what the file said.
describe("the ComfyUI workflow files", () => {
  // One-node template the tests recognise; the PARAM_* names are the ones the
  // app substitutes, the mock converter picks the variant by them.
  function templateOf(marker: string): Record<string, unknown> {
    return {
      last_node_id: 5,
      nodes: [{ id: 5, type: "CLIPTextEncode", widgets_values: [`PARAM_PROMPT ${marker}`, marker] }],
    };
  }

  function writeWorkflow(model: string, set: unknown): void {
    fs.mkdirSync(PathHelper.comfyWorkflowsDir(), { recursive: true });
    fs.writeFileSync(path.join(PathHelper.comfyWorkflowsDir(), `${model}.json`), JSON.stringify(set, null, 2));
  }

  afterEach(() => {
    fs.rmSync(PathHelper.comfyWorkflowsDir(), { recursive: true, force: true });
  });

  it("adds a model whose workflow file the user wrote", async () => {
    writeWorkflow("my-flux", { text: templateOf("text-only"), oneImage: templateOf("PARAM_STRING_INPUT_IMAGE_FILENAME") });
    expect(comfyUiModelNames()).toContain("my-flux");
    // the shipped ones are still there
    expect(comfyUiModelNames()).toContain("qwen-image-2.1");

    const gen = comfyGen(comfy, { model: "my-flux" });
    expect((await oneShot(gen, "a picture of mine", [], "own-model.png")).status).toBe("ok");
    expect(comfy.converted).toEqual(["text"]);

    // the same file's oneImage template is what a reference runs on
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    fs.writeFileSync(imageFile(chatIdDefault, "own-ref.png"), "x");
    expect(
      (await oneShot(gen, "with my reference", [imageId(chatIdDefault, "own-ref.png")], "own-model-ref.png")).status,
    ).toBe("ok");
    expect(comfy.converted).toEqual(["text", "oneImage"]);
  }, 60000);

  it("replaces the workflow of a shipped model with the user's file", async () => {
    // The marker below is a placeholder of the ONE-reference workflow, put into
    // the text variant on purpose: had the app used its own file, the server
    // would have been told this is a text workflow.
    writeWorkflow("qwen-image-2.1", { text: templateOf("PARAM_STRING_INPUT_IMAGE_FILENAME") });
    const r = await oneShot(comfyGen(comfy), "the shipped model, my graph", [], "overridden.png");
    expect(r.status).toBe("ok");
    expect(comfy.converted).toEqual(["oneImage"]);
  }, 60000);

  it("reads an edited workflow file on the next picture, and converts it again", async () => {
    writeWorkflow("qwen-image-2.1", { text: templateOf("first") });
    const gen = comfyGen(comfy);
    // one refresh — so one driver instance and one convert cache
    await images.refreshAvailableGenerators([gen]);
    await images.startImageJob({ id: imageId(chatIdDefault, "edit-1.png"), prompt: "p", refs: [] })
      .result;
    expect(comfy.converted).toEqual(["text"]);

    // the same file, unchanged: the cached API copy is still the right one
    await images.startImageJob({ id: imageId(chatIdDefault, "edit-2.png"), prompt: "p", refs: [] })
      .result;
    expect(comfy.converted).toEqual(["text"]);

    writeWorkflow("qwen-image-2.1", { text: templateOf("second") });
    await images.startImageJob({ id: imageId(chatIdDefault, "edit-3.png"), prompt: "p", refs: [] })
      .result;
    // the new template went through the converter again — the picture was not
    // drawn from the API copy of the graph that was there before
    expect(comfy.converted).toEqual(["text", "text"]);
  }, 60000);

  it("leaves a model whose workflow file is broken out of the app", async () => {
    const logged: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    try {
      // an unreadable file of its own: no model, no generator
      fs.mkdirSync(PathHelper.comfyWorkflowsDir(), { recursive: true });
      fs.writeFileSync(path.join(PathHelper.comfyWorkflowsDir(), "my-flux.json"), "{ not json");
      expect(comfyUiModelNames()).not.toContain("my-flux");

      // and a broken override of a shipped model does not fall back to the
      // shipped graph: the file the user wrote wins, so it decides the model
      fs.writeFileSync(path.join(PathHelper.comfyWorkflowsDir(), "qwen-image-2.1.json"), '{"nodes": "not a graph"}');
      expect(comfyUiModelNames()).not.toContain("qwen-image-2.1");
      await images.refreshAvailableGenerators([comfyGen(comfy)]);
      expect(images.hasAvailableGenerator()).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // the reason reaches the log, with the file it is about
    expect(logged.join("\n")).toMatch(/my-flux\.json.*not readable JSON/s);
    expect(logged.join("\n")).toMatch(/qwen-image-2\.1\.json.*none of/s);
  });

  it("leaves the reference out for a model whose file has no template for it", async () => {
    // A file the user writes can ship fewer variants than the app's own — the
    // model then simply does not take references. The picture is still drawn,
    // from the text alone, and the unusable reference is never uploaded.
    writeWorkflow("text-only-model", { text: templateOf("no references here") });
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    fs.writeFileSync(imageFile(chatIdDefault, "ref-for-text-only.png"), "x");
    const r = await oneShot(
      comfyGen(comfy, { model: "text-only-model" }),
      "one reference, no template for it",
      [imageId(chatIdDefault, "ref-for-text-only.png")],
      "text-only-ref.png",
    );
    expect(r.status).toBe("ok");
    // the server saw the job, never the picture it cannot take
    expect(comfy.uploads).toEqual([]);
    expect(comfy.jobs).toHaveLength(1);
    expect(comfy.jobs[0].refs).toEqual([]);
  });

  it("takes a model name as a file name, never as a path", async () => {
    // a hand-written config must not be able to point the loader outside the
    // two workflow folders (data root holds config.json with the API keys)
    expect(comfyUiModelNames()).not.toContain("..\\config");
    await images.refreshAvailableGenerators([comfyGen(comfy, { model: "../../config" })]);
    expect(images.hasAvailableGenerator()).toBe(false);
    const job = images.startImageJob({
      id: imageId(chatIdDefault, "escaping-model.png"),
      prompt: "p",
      refs: [],
    });
    expect((await job.result).status).toBe("failed");
  });
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
    fs.mkdirSync(PathHelper.chatFilesDir(jobChatId), { recursive: true });
    const real = imageFile(jobChatId, "a-real-reference.png");
    fs.writeFileSync(real, "x");
    const r = await runJob("job-refs.png", {
      prompt: "from one reference",
      refs: [imageId(jobChatId, "a-real-reference.png"), "/etc/passwd", `${jobChatId}/files/gone.png`, "../out.png"],
    });
    expect(r.status).toBe("ok");
    expect(comfy.uploads).toHaveLength(1);
    expect(comfy.uploads[0]).toContain("a-real-reference.png");
    expect(comfy.jobs[0].workflow).not.toContain("passwd");
    expect(comfy.jobs[0].workflow).not.toContain("gone.png");
    expect(comfy.jobs[0].workflow).not.toContain("out.png");
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
    // generators (each with its own workflow) but they share one GPU, so one
    // queue.
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
    // …and each of them ran its own model's workflow, named in the file it
    // asked the server to save the picture as.
    expect(comfy.jobs.map((j) => String(j.prefix).split("_")[1]).sort()).toEqual([
      "qwenimage21",
      "qwenimage2512",
    ]);
  }, 60000);
});
