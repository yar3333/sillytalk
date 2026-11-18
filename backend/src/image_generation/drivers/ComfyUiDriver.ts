import fs from "fs";
import path from "path";
import { ComfyUiLora, ComfyUiOrientation, ComfyUiSettings } from "../../configuration/ComfyUiSettings";
import { ComfyUiObjectInfo, ComfyUiSystemStats } from "../comfyui/ComfyUiServerInfo";
import { IImageGeneratorDriver } from "../IImageGeneratorDriver";

// One file the server has in a folder a client may pick from. `mb` is its size,
// which is what tells a user which of their three "qwen_image_fp8" files is the
// 20 GB one before they find out by waiting for it.
export type ComfyUiFileOption = {
  name: string;
  mb?: number;
  // A LoRA only: keyed by the model file it would merge into, what the server's
  // read of the two safetensors headers says. "no" is proof it would merge into
  // nothing; "unknown" means the layer names did not line up with anything,
  // which is allowed and worth saying. Absent for a pair it could not read.
  fits?: Record<string, { fits: "yes" | "no" | "unknown"; reason?: string }>;
};

// What a ComfyUI server answers on `/sillytalk/models` for one model. The
// plugin describes its own catalogue, so the app holds no workflow file and no
// list of what a model can do: `max_refs` is the server saying how many
// reference pictures its graph has a place for, `sizes` the pixel numbers
// behind each orientation, and the two option lists the contents of the
// server's own model folders — which is why the settings dialog offers a pick
// instead of a text field.
export type ComfyUiPluginModel = {
  code: string;
  label?: string;
  max_refs: number;
  orientation?: ComfyUiOrientation;
  sizes?: Partial<Record<ComfyUiOrientation, [number, number]>>;
  // The file the workflow loads when the client names none.
  model_file?: string | null;
  // Present only when the workflow can take another file at all.
  model_files?: { folder?: string; options: ComfyUiFileOption[] };
  // `max` is how many LoRA slots that model's graph wired (0 = no LoRAs).
  loras?: { max?: number; options: ComfyUiFileOption[] };
};

// One ComfyUI server's catalogue as the settings dialog receives it: the app
// never merges two servers' lists, because a file one box has is not a file the
// other has, and a pick that mixes them is a job that fails on the wrong server.
export type ComfyUiServerCatalogue = {
  url: string;
  models: ComfyUiPluginModel[];
};

// `/sillytalk/health`: the server's own account of what it can run on.
export type ComfyUiPluginHealth = {
  version?: string;
  comfyui_version?: string;
  workflow_dir?: string;
  models?: string[];
  broken_workflows?: { code: string; file?: string; error: string }[];
  devices?: {
    device: string;
    name?: string;
    vram_total_mb?: number;
    vram_free_mb?: number;
    vram_reclaimable_mb?: number;
  }[];
  resident_models?: { model: string; device: string; mb: number }[];
};

// Where one model loader of a run landed. The server decides this from the VRAM
// free at submit time, so the app neither asks nor overrides — it only reports
// it, in the log line and the error of a job that no card could take.
export type ComfyUiPlacement = {
  node: string;
  class: string;
  device: string;
  mb: number;
  note?: string;
};

// The answer of every `/sillytalk/jobs/...` route.
export type ComfyUiJob = {
  job_id: string;
  model?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  width?: number;
  height?: number;
  orientation?: ComfyUiOrientation;
  model_file?: string;
  loras?: { name: string; strength: number; node?: string }[];
  seed?: number;
  seconds?: number;
  error?: string;
  placements?: ComfyUiPlacement[];
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

// How often the job is asked where it is, and how long to wait at all — the
// same 2 s / 10 min the previous driver and the cmd/ps1 generators used.
const POLL_INTERVAL_MS = 2000;
const GENERATION_TIMEOUT_MS = 600_000;
// The probe of "is the server there", and the request that cancels: short, they
// must not hold the job.
const PROBE_TIMEOUT_MS = 2000;
const CANCEL_TIMEOUT_MS = 3000;
// The plugin's own routes are small JSON answers, but they are read on the way
// to a real draw, so a busy server gets a few seconds rather than two.
const PLUGIN_TIMEOUT_MS = 10_000;
// The node listing is a real payload, not a ping — the self-test would rather
// wait a few seconds for it than report a healthy server as broken.
const INFO_TIMEOUT_MS = 30_000;

// A ComfyUI server running the comfyui-sillytalk plugin.
//
// The whole protocol is four requests, and the app's side of the boundary is
// deliberately small: a prompt, its reference pictures, a model code and a
// size go out; a job id comes back; the finished PNG comes back.
//
//   1. POST /sillytalk/generate            — multipart, answers 202 with a job
//   2. GET  /sillytalk/jobs/{id}           — polled until the job is terminal
//   3. GET  /sillytalk/jobs/{id}/image     — the picture, as bytes
//   4. DELETE /sillytalk/jobs/{id}         — the user stopped waiting
//
// What is NOT here is the point of this split. The app holds no workflow graph,
// no PARAM_* placeholders and no converter endpoint, and it names no GPU: the
// plugin picks the card for every model loader from the VRAM that is free at
// the moment the job is submitted, which is the only moment that can know it.
// A device in a config file is a guess about a future the next process on the
// box can undo.
//
// The plugin is a hard requirement: a server without it is not a generator this
// app can use, and `available()` says so with the name of what to install.
export class ComfyUiDriver implements IImageGeneratorDriver {
  readonly key: string;
  readonly queueKey: string;

  private readonly base: string;

  // This model as the server described it, from the last probe. `maxRefs` is a
  // synchronous property of the interface while the answer is an HTTP request,
  // so the probe that decided this generator is usable is what fills it — the
  // service above only ever reads it on drivers it has probed.
  private probed: ComfyUiPluginModel | null = null;

  // Everything the server offered at the last probe, not only this generator's
  // model: a server that is up but does not have the one model configured still
  // knows what it could draw, and that is what the Settings pick should show.
  private catalogue: ComfyUiPluginModel[] = [];

  // Why the last probe rejected this server, for the self-test to show instead
  // of a bare "unavailable".
  private probeError: string | null = null;

  // Where the model loaders of the last run landed, as the server reported it.
  // The driver decides nothing about this and acts on none of it — it is kept
  // only so a caller that shows the run (the self-test) can say which card did
  // the work, which is the one thing a placement problem is read from.
  private lastPlacements: ComfyUiPlacement[] = [];

  // The finished job of the last run, for the same reason: what the server says
  // it drew with (its own default file or the one that was asked for, the LoRAs
  // it merged) is the only account of it that cannot drift from what happened.
  private lastJob: ComfyUiJob | null = null;

  constructor(private readonly cfg: ComfyUiSettings) {
    this.base = ComfyUiDriver.normalizeUrl(cfg.url ?? "");
    // Two generators on one server (one model each) are two generators…
    this.key = `comfyui:${this.base}#${this.cfg.model}`;
    // …but one queue: a ComfyUI server works through one prompt at a time.
    this.queueKey = `comfyui:${this.base}`;
  }

  /** The server URL this driver talks to (no trailing slash). */
  get baseUrl(): string {
    return this.base;
  }

  /** The model this generator asks the server for. */
  get model(): string {
    return this.cfg.model;
  }

  /** The model codes the server offered at the last probe. */
  get offeredModels(): string[] {
    return this.catalogue.map((m) => m.code);
  }

  /** Everything the server offered, files and LoRAs included (the settings pick). */
  get offeredCatalogue(): ComfyUiPluginModel[] {
    return this.catalogue;
  }

  /** Why the last probe said no, or null when it did not. */
  get unavailableBecause(): string | null {
    return this.probeError;
  }

  /** Where the loaders of the last run landed (empty before the first one). */
  get placements(): ComfyUiPlacement[] {
    return this.lastPlacements;
  }

  /** The file the last run loaded, as the server reported it. */
  get lastModelFile(): string | undefined {
    return this.lastJob?.model_file;
  }

  /** The LoRAs the last run merged, as the server reported them. */
  get lastLoras(): { name: string; strength: number }[] {
    return this.lastJob?.loras ?? [];
  }

  get maxRefs(): number {
    return this.probed?.max_refs ?? 0;
  }

  async available(): Promise<boolean> {
    if (!this.base) {
      this.probeError = "no server URL is configured";
      return false;
    }
    try {
      const models = await this.pluginModels();
      const mine = models.find((m) => m.code === this.cfg.model);
      if (!mine) {
        this.probeError =
          `the server ${this.base} does not offer the model "${this.cfg.model}" ` +
          `(it offers: ${models.map((m) => m.code).join(", ") || "nothing"})`;
        return false;
      }
      this.probed = mine;
      this.probeError = null;
      return true;
    } catch (err) {
      this.probeError = (err as Error).message;
      return false;
    }
  }

  // ---- the read-only probes the self-test uses ----
  //
  // The questions a ComfyUI problem comes down to: is the server there and on
  // what hardware, is the plugin on it and what does it offer, and does the
  // server have the nodes and model files the catalogue's workflows need. They
  // live here because the protocol belongs here — the self-test asks questions,
  // it does not learn HTTP dialects.

  /**
   * GET /sillytalk/health — the plugin, its catalogue and its cards.
   *
   * A 404 here means the server is a plain ComfyUI, so the answer names the
   * custom node to install: a server that is clearly up in a browser but is
   * missing from this app is otherwise impossible to diagnose from the outside.
   */
  async pluginHealth(timeoutMs: number = PLUGIN_TIMEOUT_MS): Promise<ComfyUiPluginHealth> {
    return this.pluginJson<ComfyUiPluginHealth>("/sillytalk/health", timeoutMs);
  }

  /**
   * GET /sillytalk/models — every model code the server can draw, with what
   * each takes.
   */
  async pluginModels(timeoutMs: number = PLUGIN_TIMEOUT_MS): Promise<ComfyUiPluginModel[]> {
    const answer = await this.pluginJson<{ models?: ComfyUiPluginModel[] }>("/sillytalk/models", timeoutMs);
    const models = Array.isArray(answer?.models) ? answer.models : [];
    this.catalogue = models.filter((m) => typeof m?.code === "string");
    return this.catalogue;
  }

  // A request to one of the plugin's own routes, with the one answer that needs
  // interpreting: 404 is not "the plugin said no", it is "there is no plugin".
  private async pluginJson<T>(route: string, timeoutMs: number): Promise<T> {
    try {
      return await this.requestJson<T>(route, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if ((err as HttpFailure).status === 404) {
        throw new Error(
          `The ComfyUI server ${this.base} has no GET ${route} endpoint. Install the custom node ` +
            `"comfyui-sillytalk" into its custom_nodes/ folder and restart it — this app draws through that ` +
            `plugin and does not send workflow graphs of its own.`,
        );
      }
      throw err;
    }
  }

  /** GET /system_stats — is the server up, and what is it running on. */
  systemStats(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ComfyUiSystemStats> {
    return this.requestJson<ComfyUiSystemStats>("/system_stats", { signal: AbortSignal.timeout(timeoutMs) });
  }

  /**
   * GET /object_info — every node class the server can execute, with the input
   * specs that say which model file names it actually has. The payload is a few
   * hundred kilobytes to a couple of megabytes, so it is fetched once per run
   * and given a longer timeout than a liveness probe.
   */
  objectInfo(timeoutMs: number = INFO_TIMEOUT_MS): Promise<ComfyUiObjectInfo> {
    return this.requestJson<ComfyUiObjectInfo>("/object_info", { signal: AbortSignal.timeout(timeoutMs) });
  }

  /**
   * Whether the server knows one node class, asked on its own — a node the
   * full listing does not show may simply be one the server loads lazily, and
   * calling the diagnostic a false name is worse than not calling it.
   */
  async hasNodeClass(classType: string, timeoutMs: number = INFO_TIMEOUT_MS): Promise<boolean> {
    try {
      const info = await this.requestJson<ComfyUiObjectInfo>(
        `/object_info/${encodeURIComponent(classType)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      return !!info && Object.keys(info).length > 0;
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
    // The service clamps the references to `maxRefs` before a job starts, and
    // maxRefs comes from the server's own catalogue — so a job that arrives
    // with more pictures than the model has slots for is a caller that drove
    // this driver directly. Dropping them quietly would draw a different
    // picture than the one that was asked for.
    if (this.probed && refPaths.length > this.probed.max_refs) {
      throw new Error(
        `The server ${this.base} takes at most ${this.probed.max_refs} reference image(s) for ` +
          `"${this.cfg.model}" (${refPaths.length} provided)`,
      );
    }

    // One controller for the whole run: cancelling stops every request of it,
    // and the server is told to drop the job it was given.
    const ctrl = new AbortController();
    registerAbort?.(ctrl);
    let jobId: string | null = null;
    let finished = false;
    ctrl.signal.addEventListener("abort", () => {
      if (!finished && jobId) void this.abandonJob(jobId);
    });

    const form = new FormData();
    form.append("model", this.cfg.model);
    form.append("prompt", prompt);
    // An orientation, not a size: the server knows the pixel numbers its model
    // was trained at, and the job answers with the ones it used.
    form.append("orientation", this.cfg.orientation || "square");
    if (this.cfg.modelFile) form.append("model_file", this.cfg.modelFile);
    const loras = ComfyUiDriver.lorasToSend(this.cfg.loras);
    if (loras.length) form.append("loras", JSON.stringify(loras));
    for (const ref of refPaths) {
      form.append("image", new Blob([fs.readFileSync(ref)], { type: ComfyUiDriver.mimeOf(ref) }), path.basename(ref));
    }

    const job = await this.requestJson<ComfyUiJob>("/sillytalk/generate", { method: "POST", body: form, signal: ctrl.signal });
    if (!job?.job_id) {
      throw new Error(
        `The ComfyUI server ${this.base} did not answer with a job_id (it said ${JSON.stringify(job).slice(0, 500)})`,
      );
    }
    jobId = job.job_id;
    const done = await this.awaitCompletion(jobId, ctrl.signal);
    const body = await this.downloadImage(jobId, ctrl.signal);
    fs.writeFileSync(outPath, body);
    finished = true;
    this.lastPlacements = done.placements ?? [];
    this.lastJob = done;
    const where = this.lastPlacements.map((p) => `${p.class}@${p.device}`).join(", ");
    const file = done.model_file ? ` ${path.basename(done.model_file)}` : "";
    const withLoras = (done.loras ?? []).length ? ` +${(done.loras ?? []).length} lora` : "";
    console.log(
      `[comfyui] ${this.cfg.model}${file}${withLoras}: ${done.seconds ?? "?"}s ` +
        `${done.width ?? "?"}x${done.height ?? "?"} on ${this.base}${where ? ` (${where})` : ""}`,
    );
  }

  // The LoRA list as the plugin wants it: a name is enough, a strength only when
  // the user moved the slider off full.
  private static lorasToSend(loras?: ComfyUiLora[]): { name: string; strength?: number }[] {
    return (loras ?? [])
      .filter((l) => l && l.name)
      .map((l) => (l.strength === undefined ? { name: l.name } : { name: l.name, strength: l.strength }));
  }

  // ---- one request ----

  // A request to the server. A non-2xx answer becomes an error carrying the
  // method, the full URL, the status and what the server said — a ComfyUI
  // problem (a missing plugin, a missing model file, a card too full) has to be
  // readable in the card without opening the server console.
  private async request(route: string, init: RequestInit): Promise<Response> {
    const url = `${this.base}${route}`;
    const response = await fetch(url, init).catch((err: Error) => {
      throw new Error(
        `ComfyUI request ${init.method ?? "GET"} ${url} failed: ${ComfyUiDriver.describeFetchError(err)}`,
      );
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

  // A connection failure reaches fetch as "fetch failed" with the real reason
  // (ECONNREFUSED, ENOTFOUND, http spoken to an https port) in `cause`, so the
  // message alone would leave even a diagnostic saying nothing but "failed".
  private static describeFetchError(err: Error): string {
    const cause = (err as { cause?: unknown }).cause;
    const code = (cause as { code?: string } | undefined)?.code ?? "";
    const reason = (cause as { message?: string } | undefined)?.message ?? (typeof cause === "string" ? cause : "");
    const detail = [code, reason].filter(Boolean).join(" ");
    return detail ? `${err.message} (${detail})` : err.message;
  }

  private async requestJson<T>(route: string, init: RequestInit): Promise<T> {
    const response = await this.request(route, init);
    return (await response.json()) as T;
  }

  // ---- the job ----

  // Waits for the job to reach a terminal state. The server owns the queue, so
  // "queued" is all it can say about a job that has not started; a job it has
  // forgotten is gone for good (its restart is not this app's restart).
  private async awaitCompletion(jobId: string, signal: AbortSignal): Promise<ComfyUiJob> {
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${Math.round(GENERATION_TIMEOUT_MS / 1000)}s waiting for the ComfyUI job ` +
            `${jobId} — check the queue of ${this.base}`,
        );
      }
      await ComfyUiDriver.sleep(POLL_INTERVAL_MS, signal);
      const job = await this.requestJson<ComfyUiJob>(`/sillytalk/jobs/${encodeURIComponent(jobId)}`, { signal });
      if (!job?.status) {
        throw new Error(
          `The ComfyUI server ${this.base} answered the job ${jobId} with ${JSON.stringify(job).slice(0, 300)}`,
        );
      }
      if (job.status === "succeeded") return job;
      if (job.status === "failed" || job.status === "cancelled") {
        throw new Error(
          `The ComfyUI job ${jobId} is ${job.status}${job.error ? `: ${job.error}` : ""}`,
        );
      }
    }
  }

  // The finished picture, as bytes. The plugin serves them from its own copy and
  // removes that copy on its own schedule, so the app needs neither a shared
  // folder with the server nor a cleanup call.
  private async downloadImage(jobId: string, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request(`/sillytalk/jobs/${encodeURIComponent(jobId)}/image`, { signal });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) {
      throw new Error(`The ComfyUI server ${this.base} sent an empty picture for the job ${jobId}`);
    }
    return body;
  }

  // The user stopped waiting for this picture: the server is asked to drop the
  // job, so the GPU is free for the next one. Best effort — a job that already
  // finished has nothing to drop, and a server that refuses keeps what it was
  // given without failing the generation the user already cancelled.
  private async abandonJob(jobId: string): Promise<void> {
    try {
      await fetch(`${this.base}/sillytalk/jobs/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      });
    } catch {
      // best effort
    }
  }

  // Waits between the polls, and stops waiting the moment the job is cancelled
  // instead of after the interval.
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

  private static mimeOf(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".bmp") return "image/bmp";
    return "image/png";
  }

  // Strips the trailing slashes of a ComfyUI base URL (the config may carry
  // "http://host:8188/").
  private static normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
  }
}

// An HTTP answer of the server that carries its status code, so a caller can
// react to one code (a 404 of /sillytalk/models means the plugin is missing)
// without parsing the message.
type HttpFailure = Error & { status?: number };
