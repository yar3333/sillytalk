import fs from "fs";
import path from "path";
import { ComfyUiSettings } from "../../configuration/ComfyUiSettings";
import {
  comfyUiMaxRefs,
  comfyUiModelNames,
  comfyUiWorkflowSet,
  ComfyUiWorkflowTemplate,
  variantFor,
} from "../comfyui/ComfyUiWorkflows";
import { IImageGeneratorDriver } from "../IImageGeneratorDriver";

// One node of a workflow in the API format (what the server's
// /workflow/convert returns and what /prompt expects): inputs by name, a
// link to another node being the node id + the output index.
type ApiNode = { class_type?: string; inputs?: Record<string, unknown> };
type ApiWorkflow = Record<string, ApiNode>;

// The picture the server's SaveImage node wrote: where in its output/ folder.
type SavedImage = { filename: string; subfolder?: string; type?: string };

// The history entry of a submitted job.
type HistoryEntry = {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<string, { images?: SavedImage[] }>;
};

// An HTTP answer of the server that carries its status code, so a caller can
// react to one code (404 of /workflow/convert means the converter node is
// missing) without parsing the message.
type HttpFailure = Error & { status?: number };

// How often the finished job is looked for in the server history, and how long
// to wait for it at all — the same 2 s / 10 min the cmd/ps1 generators used.
const POLL_INTERVAL_MS = 2000;
const GENERATION_TIMEOUT_MS = 600_000;
// The probe of "is the server up", and the requests sent when the user
// cancelled: short, they must not hold the job.
const PROBE_TIMEOUT_MS = 2000;
const CANCEL_TIMEOUT_MS = 3000;

// The ComfyUI backend: the workflow templates come from the app's own folder
// and the user's `<data root>/comfyui/` folder (see
// ../comfyui/ComfyUiWorkflows.ts) and the driver walks a ComfyUI server over
// its HTTP API — the same steps the cmd/ps1 generators of AiPic took, in one
// place:
//
//   1. POST /workflow/convert  — the server turns the UI-format template of the
//      model into the API format (the custom node
//      comfyui-workflow-to-api-converter-endpoint);
//   2. the PARAM_* placeholders of the result become this run's prompt, seed,
//      size, GPU and file name;
//   3. POST /upload/image      — every reference picture is uploaded into the
//      server's input/ folder and the workflow loads it by the name it got;
//   4. POST /prompt            — the job is queued, its prompt_id is returned;
//   5. GET  /history/{id}      — polled until the job is done (or the wait is
//      given up);
//   6. GET  /view              — the finished picture is downloaded, so no
//      shared folder with the server is needed.
//
// The server keeps its copies (ComfyUI cannot delete files over HTTP): the
// picture stays in output/, the references in input/.
export class ComfyUiDriver implements IImageGeneratorDriver {
  readonly key: string;
  readonly queueKey: string;

  // The API-format copies of the UI templates, per model + reference count.
  // The conversion is a property of the template, not of a run, so it happens
  // once per template; the placeholders are substituted on a copy, so the
  // cached workflow is never modified. The template text travels with the copy:
  // a template is a file the user can edit between two generations, and a
  // converted copy of the OLD text must not be what the next picture uses.
  private readonly apiWorkflows = new Map<string, { templateJson: string; api: ApiWorkflow }>();

  private readonly base: string;

  constructor(private readonly cfg: ComfyUiSettings) {
    this.base = ComfyUiDriver.normalizeUrl(cfg.url ?? "");
    // Two generators on one server (one model each) are two generators…
    this.key = `comfyui:${this.base}#${this.cfg.model}`;
    // …but one queue: a ComfyUI server works through one prompt at a time.
    this.queueKey = `comfyui:${this.base}`;
  }

  async available(): Promise<boolean> {
    // The model has to be one a workflow file defines (the app's own or the
    // user's); a generator naming a model it cannot run is filtered out here
    // rather than failing every job.
    if (!this.base || !comfyUiWorkflowSet(this.cfg.model)) return false;
    try {
      await this.request("/system_stats", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }

  async run(
    prompt: string,
    refPaths: string[],
    outPath: string,
    registerAbort?: (ctrl: AbortController) => void,
  ): Promise<void> {
    if (!this.base) throw new Error("The ComfyUI generator has no server URL");
    // The workflow is re-read for every job, so a template the user edited is
    // used from the next picture on — no restart, no stale copy.
    const set = comfyUiWorkflowSet(this.cfg.model);
    if (!set) {
      throw new Error(
        `The ComfyUI generator names the model "${this.cfg.model}", which no workflow file of the app ` +
          `defines (the app can draw with: ${comfyUiModelNames().join(", ")})`,
      );
    }
    // The file decides how many references this model takes — asking for more
    // is refused here, before a picture is uploaded or a job queued: the
    // template of the highest count has no widget for an extra one, and
    // drawing from it anyway would quietly drop the reference on the floor.
    const maxRefs = comfyUiMaxRefs(set);
    if (refPaths.length > maxRefs) {
      throw new Error(
        `The "${this.cfg.model}" workflow supports at most ${maxRefs} reference images (${refPaths.length} provided)`,
      );
    }
    const template = set[variantFor(refPaths.length)];
    if (!template) {
      throw new Error(
        `The "${this.cfg.model}" workflow has no template for ${refPaths.length} reference images ` +
          `(its file defines: ${Object.keys(set).join(", ")})`,
      );
    }

    // One controller for the whole run: cancelling the job stops every request
    // of it, and the server is told to drop the prompt it was given.
    const ctrl = new AbortController();
    registerAbort?.(ctrl);
    let promptId: string | null = null;
    let finished = false;
    ctrl.signal.addEventListener("abort", () => {
      if (!finished) void this.abandonJob(promptId);
    });

    const api = await this.apiWorkflow(template, refPaths.length, ctrl.signal);
    const refNames = await this.uploadRefs(refPaths, ctrl.signal);
    // substitute() walks the workflow generically, so the result is handed back
    // as the same shape it was given.
    const job = ComfyUiDriver.substitute(api, this.valuesFor(prompt, refNames)) as ApiWorkflow;
    promptId = await this.submit(job, ctrl.signal);
    const saved = await this.awaitCompletion(promptId, ctrl.signal);
    await this.download(saved, outPath, ctrl.signal);
    finished = true;
  }

  // ---- one request ----

  // A request to the server. A non-2xx answer becomes an error carrying the
  // method, the full URL, the status and what the server said — a ComfyUI
  // problem (a missing node, a missing model file, a bad workflow) has to be
  // readable in the card without opening the server console.
  private async request(route: string, init: RequestInit): Promise<Response> {
    const url = `${this.base}${route}`;
    const response = await fetch(url, init).catch((err: Error) => {
      throw new Error(`ComfyUI request ${init.method ?? "GET"} ${url} failed: ${err.message}`);
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const failure: HttpFailure = new Error(
        `ComfyUI ${init.method ?? "GET"} ${url} returned ${response.status}${body ? `: ${body.slice(0, 1000)}` : ""}`,
      );
      failure.status = response.status;
      throw failure;
    }
    return response;
  }

  private async requestJson<T>(route: string, init: RequestInit): Promise<T> {
    const response = await this.request(route, init);
    return (await response.json()) as T;
  }

  // ---- the workflow of the model ----

  // The API-format copy of the model's template: from the cache of this
  // process when the template has not changed since it was converted, otherwise
  // from the server's converter endpoint (which needs the
  // comfyui-workflow-to-api-converter-endpoint custom node). An edited workflow
  // file is a different template text, so it converts again — the user's edit
  // cannot be shadowed by the copy of the previous one.
  private async apiWorkflow(
    template: ComfyUiWorkflowTemplate,
    refCount: number,
    signal: AbortSignal,
  ): Promise<ApiWorkflow> {
    const cacheKey = `${this.cfg.model}/${refCount}`;
    const templateJson = JSON.stringify(template);
    const cached = this.apiWorkflows.get(cacheKey);
    if (cached && cached.templateJson === templateJson) return cached.api;

    let api: ApiWorkflow;
    try {
      api = await this.requestJson<ApiWorkflow>("/workflow/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(template),
        signal,
      });
    } catch (err) {
      if ((err as HttpFailure).status === 404) {
        throw new Error(
          `The ComfyUI server ${this.base} has no POST /workflow/convert endpoint. Install the custom node ` +
            `"comfyui-workflow-to-api-converter-endpoint" on it — the app sends its workflow templates in the ` +
            `UI format and the server turns them into the API format.`,
        );
      }
      throw err;
    }
    if (!api || typeof api !== "object" || Object.keys(api).length === 0) {
      throw new Error(
        `The ComfyUI server ${this.base} returned no API workflow for the "${this.cfg.model}" template ` +
          `(the converter node answered with ${JSON.stringify(api).slice(0, 300)})`,
      );
    }
    this.apiWorkflows.set(cacheKey, { templateJson, api });
    return api;
  }

  // This run's values for the placeholders of the template. The steps, CFG and
  // the sampler stay inside the template — only these change per picture.
  private valuesFor(prompt: string, refNames: string[]): Record<string, string | number> {
    const values: Record<string, string | number> = {
      PARAM_PROMPT: prompt,
      PARAM_SEED: Math.floor(Math.random() * 2147483647),
      PARAM_DEVICE: this.cfg.device || "cuda:0",
      PARAM_INT_OUTPUT_IMAGE_WIDTH: this.cfg.width,
      PARAM_INT_OUTPUT_IMAGE_HEIGHT: this.cfg.height,
      PARAM_STRING_OUTPUT_IMAGE_FILENAME: this.outputPrefix(),
    };
    if (refNames.length === 1) values.PARAM_STRING_INPUT_IMAGE_FILENAME = refNames[0];
    if (refNames.length === 2) {
      values.PARAM_STRING_INPUT_IMAGE_FILENAME_1 = refNames[0];
      values.PARAM_STRING_INPUT_IMAGE_FILENAME_2 = refNames[1];
    }
    return values;
  }

  // The prefix SaveImage gives the file in the server's output/ folder. The
  // app keeps its own copy of the picture under its own name, so this one only
  // has to be recognisable and unique on the server.
  private outputPrefix(): string {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const model = this.cfg.model.replace(/[^A-Za-z0-9]/g, "");
    return `sillytalk_${model}_${stamp}_${Math.floor(Math.random() * 100000)}`;
  }

  // Replaces the PARAM_* placeholders with the run's values, returning a copy
  // (the cached workflow of the template is never touched). A whole-string
  // match only, as in the ps1 generators: a widget value either IS a
  // placeholder or is text the template owns.
  private static substitute(node: unknown, values: Record<string, string | number>): unknown {
    if (typeof node === "string") {
      return Object.prototype.hasOwnProperty.call(values, node) ? values[node] : node;
    }
    if (Array.isArray(node)) return node.map((item) => ComfyUiDriver.substitute(item, values));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = ComfyUiDriver.substitute(value, values);
      }
      return out;
    }
    return node;
  }

  // ---- the reference pictures ----

  // Uploads the references into the server's input/ folder (the built-in
  // endpoint) under a name that cannot collide, and returns the names the
  // server actually gave them — the workflow loads the pictures by those.
  private async uploadRefs(refPaths: string[], signal: AbortSignal): Promise<string[]> {
    const names: string[] = [];
    for (const refPath of refPaths) {
      const form = new FormData();
      const remote = `ref_${Math.floor(Math.random() * 1000000)}_${ComfyUiDriver.safeName(path.basename(refPath))}`;
      form.append("image", new Blob([fs.readFileSync(refPath)], { type: ComfyUiDriver.mimeOf(refPath) }), remote);
      // No Content-Type of its own: fetch adds the multipart boundary.
      const saved = await this.requestJson<{ name?: string }>("/upload/image", {
        method: "POST",
        body: form,
        signal,
      });
      if (!saved?.name) {
        throw new Error(
          `The ComfyUI server ${this.base} uploaded ${refPath} but answered with no file name ` +
            `(it said ${JSON.stringify(saved).slice(0, 300)})`,
        );
      }
      names.push(saved.name);
    }
    return names;
  }

  // The name of a reference on the server: the file's own name, without
  // anything a path or a file system would take for a separator.
  private static safeName(name: string): string {
    return name.replace(/[^\w.+=-]+/g, "_").slice(-64);
  }

  private static mimeOf(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    return "image/png";
  }

  // ---- the job ----

  private async submit(workflow: ApiWorkflow, signal: AbortSignal): Promise<string> {
    const answer = await this.requestJson<{ prompt_id?: string; node_errors?: Record<string, unknown> }>(
      "/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
        signal,
      },
    );
    if (answer?.node_errors && Object.keys(answer.node_errors).length > 0) {
      throw new Error(
        `The ComfyUI server ${this.base} refused the workflow of "${this.cfg.model}": ` +
          `${JSON.stringify(answer.node_errors).slice(0, 1500)}\n` +
          `(usually a custom node or a model file of the workflow is missing on that server)`,
      );
    }
    if (!answer?.prompt_id) {
      throw new Error(
        `The ComfyUI server ${this.base} did not answer with a prompt_id ` +
          `(it said ${JSON.stringify(answer).slice(0, 500)})`,
      );
    }
    return answer.prompt_id;
  }

  // Waits for the job to leave the queue and finish, then returns the picture
  // its SaveImage node wrote. A job that is not in the history yet is still
  // queued — the server does not say where in the queue it is.
  private async awaitCompletion(promptId: string, signal: AbortSignal): Promise<SavedImage> {
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${Math.round(GENERATION_TIMEOUT_MS / 1000)}s waiting for the ComfyUI job ` +
            `${promptId} — check the queue of ${this.base}`,
        );
      }
      await ComfyUiDriver.sleep(POLL_INTERVAL_MS, signal);
      const history = await this.requestJson<Record<string, HistoryEntry>>(
        `/history/${encodeURIComponent(promptId)}`,
        { signal },
      );
      const entry = history?.[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        throw new Error(
          `The ComfyUI job ${promptId} failed on the server: ${JSON.stringify(entry.status.messages ?? []).slice(0, 1500)}`,
        );
      }
      if (!entry.status?.completed) continue;
      const saved = ComfyUiDriver.firstImage(entry);
      if (!saved) {
        throw new Error(
          `The ComfyUI job ${promptId} finished but left no picture in its history (its SaveImage node wrote nothing)`,
        );
      }
      return saved;
    }
  }

  // The first picture of the job's outputs — the workflow has one SaveImage
  // node, so in practice there is exactly one.
  private static firstImage(entry: HistoryEntry): SavedImage | null {
    for (const output of Object.values(entry.outputs ?? {})) {
      const image = output?.images?.[0];
      if (image?.filename) return image;
    }
    return null;
  }

  // Downloads the picture through the built-in /view endpoint — the app needs
  // no shared folder with the server.
  private async download(image: SavedImage, outPath: string, signal: AbortSignal): Promise<void> {
    const query = new URLSearchParams({ filename: image.filename, type: "output" });
    if (image.subfolder) query.set("subfolder", image.subfolder);
    const response = await this.request(`/view?${query.toString()}`, { signal });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) {
      throw new Error(`The ComfyUI server ${this.base} sent an empty file for ${image.filename}`);
    }
    fs.writeFileSync(outPath, body);
  }

  // The user stopped waiting for this picture: the server is asked to drop it,
  // so the GPU is free for the next job. Removing it from the queue covers a
  // job that has not started, /interrupt one that has. Neither endpoint is
  // guaranteed to exist on every server — a server that refuses keeps the job
  // it was given, and nothing here fails the cancelled generation.
  private async abandonJob(promptId: string | null): Promise<void> {
    if (!promptId) return;
    for (const [route, body] of [
      ["/queue", { remove: [promptId] }],
      ["/interrupt", { prompt_id: promptId }],
    ] as const) {
      try {
        await fetch(`${this.base}${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
        });
      } catch {
        // best effort — a server without the endpoint goes on with its job
      }
    }
  }

  // Waits between the history polls, and stops waiting the moment the job is
  // cancelled instead of after the interval.
  private static sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("The generation was cancelled"));
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("The generation was cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Strips the trailing slashes of a ComfyUI base URL (the config may carry
  // "http://host:8188/").
  private static normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
  }
}
