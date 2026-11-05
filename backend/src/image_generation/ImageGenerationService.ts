import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Model } from "../configuration/Model";
import { PathHelper } from "../shared/PathHelper";
import { ImageGenerationRecord } from "../shared/ImageMeta";
import { ImageMetaFile } from "../shared/ImageMetaFile";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { createToken } from "../di";
import { ImageGenerator } from "../configuration/ImageGenerator";
import { TextGenerationService } from "../text_generation/TextGenerationService";
import { DriverFactory } from "./DriverFactory";
import { ImageJobResult } from "./ImageJobResult";
import { ImageJob } from "./ImageJob";
import { IImageGeneratorDriver } from "./IImageGeneratorDriver";

// One registered background job: the public ImageJob plus the abort
// controllers of the run in flight (a backend that works over HTTP stops with
// them and is told to drop the job it was given).
interface JobEntry {
  job: ImageJob;
  aborts: AbortController[];
  cancelled: boolean;
}

// The DI token of the image-generation service (registered in index.ts).
export const DI_IMAGE_GENERATION_SERVICE = createToken<ImageGenerationService>("ImageGenerationService");

// The top-level image-generation service: the availability cache and the
// background job registry. The dependencies (the text-generation and
// configuration services) are injected; all the state lives on the instance,
// not in module globals.
//
// It knows nothing about chats or messages: a job is given the image id (the
// path of the picture relative to the data folder) it must write and the ids of
// the references to draw from, and it settles a result the caller applies to
// the chat.
export class ImageGenerationService {
  // ---- available generators ----
  // Every enabled and available generator is used: jobs of different
  // generators run in PARALLEL, while the jobs of one queue (one server / one
  // GPU) are queued one at a time. At startup (and after a config change)
  // the imageGenerators entries are probed (in parallel) and the available
  // drivers are cached here.
  private availableDrivers: IImageGeneratorDriver[] = [];

  // ---- background image jobs ----
  // Image generation runs in the background so it does not block the LLM
  // dialogue: the reply is saved (with the reserved image name and the
  // "pending" status) and returned to the client right away, and the image file
  // appears when the job finishes. The client polls the chat to see the result.
  //
  // A job writes to a temporary file and renames it to the reserved name only
  // on success, so the reserved name is never left with a partial image. If the
  // job fails or is cancelled while an older image existed at the name, the old
  // one is kept (the message stays ready); otherwise the image is left
  // "failed"/broken for the user to regenerate.

  // The in-flight (and queued) jobs, keyed by the image id they write.
  private readonly jobs = new Map<string, JobEntry>();
  // The per-queue chains: the jobs of one generator are serialized (a server
  // and its GPU must not be hit by several runs at once), while different
  // generators run in parallel. The chains never reject — every task settles
  // its own result.
  private readonly genChains = new Map<string, Promise<void>>();
  // The current load of each chain: the running + the queued jobs of it.
  private readonly genLoads = new Map<string, number>();
  // How many jobs each generator was given since the process started. Several
  // generators can share one queue (one ComfyUI server, one GPU), and the
  // queue load alone cannot tell them apart — this is what makes the jobs of
  // one queue go to the generators in turn.
  private readonly driverPicks = new WeakMap<IImageGeneratorDriver, number>();

  private readonly drivers = new DriverFactory();

  constructor(
    // The text generation service (translatePrompt for ensureEnglishPrompt) —
    // another domain service, injected like the configuration one.
    private readonly textGeneration: TextGenerationService,
    // The configuration service — read on demand, so a job that starts after
    // a settings change probes the current generators.
    private readonly configuration: ConfigurationService,
  ) {}

  hasAvailableGenerator(): boolean {
    return this.availableDrivers.length > 0;
  }

  // Recomputes the available generators; called at startup and when settings
  // are saved. The probes run in parallel.
  async refreshAvailableGenerators(generators: ImageGenerator[]): Promise<IImageGeneratorDriver[]> {
    const candidates = generators.filter((g) => ImageGenerationService.isEnabled(g)).map((g) => this.drivers.create(g));
    const probed = await Promise.all(candidates.map(async (d) => ((await d.available()) ? d : null)));
    this.availableDrivers = probed.filter((d): d is IImageGeneratorDriver => d !== null);
    return this.availableDrivers;
  }

  // ---- prompts ----

  // The generation prompts are always in English: if the text has Cyrillic,
  // translate it with the chat's model; on translation failure use the original.
  async ensureEnglishPrompt(model: Model | null, prompt: string): Promise<string> {
    if (!model || !this.hasCyrillic(prompt)) return prompt;
    try {
      return (await this.textGeneration.translatePrompt(model, prompt)).trim() || prompt;
    } catch {
      return prompt;
    }
  }

  private hasCyrillic(text: string): boolean {
    return /[а-яё]/i.test(text);
  }

  // The job currently registered for an image (a newer one after a
  // regeneration replaced it), or undefined. An image id is a path relative to
  // the data folder, so it is unique on its own — no chat in the key.
  getCurrentJob(id: string): ImageJob | undefined {
    return this.jobs.get(id)?.job;
  }

  // Cancels the in-flight job for the given image. Returns true when a job was
  // cancelled.
  cancelJob(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    entry.job.cancel();
    return true;
  }

  // Cancels every in-flight (and queued) job. Used on server shutdown so a
  // restart does not leave a generation running on a generator server with
  // nobody waiting for its picture (holding the GPU). The stops are
  // best-effort and in flight when the process exits.
  cancelAllJobs(): void {
    for (const entry of [...this.jobs.values()]) entry.job.cancel();
  }

  // Starts a background generation that writes the image `id` (a path relative
  // to the data folder) which must already be reserved in a saved chat message
  // with the "pending" status. `refs` are image ids too. The caller updates the
  // chat when `result` resolves. The job removes itself from the registry when
  // done.
  //
  // On success the generation data is mirrored into the sidecar *.json next to
  // the file (the prompt, the references, the generator that ran) so the
  // picture carries its own story outside the database; a description the user
  // wrote in the meantime is left alone (the write merges, it does not replace).
  startImageJob(opts: {
    id: string;
    prompt: string;
    refs: string[];
    chatId?: string;
    meta?: ImageGenerationRecord;
  }): ImageJob {
    const { id, prompt, refs, chatId, meta } = opts;
    const target = PathHelper.resolveImageId(id);
    const dir = target ? path.dirname(target) : null;
    const entry: JobEntry = {
      job: null as unknown as ImageJob,
      aborts: [],
      cancelled: false,
    };

    const run = async (driver: IImageGeneratorDriver): Promise<ImageJobResult> => {
      if (!target || !dir) return { status: "failed", error: `Unknown image id "${id}"`, hadOld: false };
      // Was there a usable image at the id before this run? (decides whether
      // a failure/cancel leaves the message ready on the old file or broken.)
      const hadOld = fs.existsSync(target);
      // A unique temp file in the same dir, so the rename is atomic.
      const temp = path.join(dir, `.${path.basename(target)}.tmp-${randomUUID().slice(0, 8)}`);
      try {
        if (entry.cancelled) return { status: "cancelled", hadOld };
        // The chat was deleted while the job waited in the queue — do not
        // recreate its folder with an orphan image.
        if (chatId && !fs.existsSync(PathHelper.chatDir(chatId))) {
          return { status: "failed", error: "The chat was deleted", hadOld: false };
        }
        fs.mkdirSync(dir, { recursive: true });
        const refPaths = ImageGenerationService.resolveRefPaths(refs);
        await driver.run(prompt, refPaths, temp, (ctrl) => {
          entry.aborts.push(ctrl);
        });
        if (entry.cancelled) {
          // The run finished but was cancelled: drop the temp, keep the old.
          fs.rmSync(temp, { force: true });
          return { status: "cancelled", hadOld };
        }
        fs.renameSync(temp, target);
        ImageMetaFile.write(target, {
          ...(meta
            ? {
                prompt: meta.prompt,
                negativePrompt: meta.negativePrompt,
                refs: meta.refs,
                source: meta.source,
                model: meta.model,
                width: meta.width,
                height: meta.height,
                steps: meta.steps,
              }
            : {}),
          generator: driver.key,
        });
        return { status: "ok" };
      } catch (err) {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          // the temp cleanup failed — the result still has to settle
        }
        if (entry.cancelled) return { status: "cancelled", hadOld };
        return { status: "failed", error: (err as Error).message, hadOld };
      } finally {
        // A newer job (a regeneration) may have replaced this one in the
        // registry — then it owns the entry and this job must not remove it.
        if (this.jobs.get(id) === entry) this.jobs.delete(id);
      }
    };

    // Enqueues the run into the chain of its generator's queue (the jobs of
    // one server are serialized) and accounts for the chain load (for the
    // least-loaded pick).
    const enqueue = (driver: IImageGeneratorDriver): Promise<ImageJobResult> => {
      const gk = driver.queueKey;
      this.genLoads.set(gk, (this.genLoads.get(gk) ?? 0) + 1);
      const prev = this.genChains.get(gk) ?? Promise.resolve();
      const runP: Promise<ImageJobResult> = prev
        .then(() => run(driver))
        .finally(() => {
          this.genLoads.set(gk, Math.max(0, (this.genLoads.get(gk) ?? 1) - 1));
        });
      this.genChains.set(
        gk,
        runP.then(
          () => undefined,
          () => undefined,
        ),
      );
      return runP;
    };

    const result: Promise<ImageJobResult> = (async (): Promise<ImageJobResult> => {
      // The generator is picked when the job starts: the least-loaded
      // available one (so the jobs spread over the generators). If the cache
      // is empty (no startup refresh yet) the availability is recomputed
      // first.
      let driver = this.pickDriver();
      if (!driver) {
        await this.refreshAvailableGenerators(this.configuration.loadConfig().imageGenerators);
        driver = this.pickDriver();
      }
      if (!driver) {
        return {
          status: "failed",
          error: "Image generation is not configured (no available generator)",
          hadOld: target !== null && fs.existsSync(target),
        };
      }
      return enqueue(driver);
    })();

    const job: ImageJob = {
      result,
      cancel: (): void => {
        entry.cancelled = true;
        // Aborting the run's controller stops its requests, and the driver
        // uses the same signal to tell its server to drop the job it was
        // given (a generation keeps running there without a client waiting).
        for (const a of entry.aborts) a.abort();
      },
    };
    entry.job = job;
    this.jobs.set(id, entry);
    return job;
  }

  // The generator to run a job on: the one of the least-loaded queue, config
  // order breaking the tie between queues. Several generators can share one
  // queue — the same ComfyUI server with a model each — and those take the
  // jobs in turn, so every model the user configured on a server gets used
  // instead of only the first one.
  private pickDriver(): IImageGeneratorDriver | null {
    let queue: string | null = null;
    let bestLoad = Infinity;
    for (const d of this.availableDrivers) {
      const load = this.genLoads.get(d.queueKey) ?? 0;
      if (load < bestLoad) {
        queue = d.queueKey;
        bestLoad = load;
      }
    }
    if (queue === null) return null;
    let best: IImageGeneratorDriver | null = null;
    let bestPicks = Infinity;
    for (const d of this.availableDrivers) {
      if (d.queueKey !== queue) continue;
      const picks = this.driverPicks.get(d) ?? 0;
      if (picks < bestPicks) {
        best = d;
        bestPicks = picks;
      }
    }
    if (best) this.driverPicks.set(best, bestPicks + 1);
    return best;
  }

  // Resolves reference image ids to the absolute paths of the files that exist.
  private static resolveRefPaths(refIds: string[]): string[] {
    return refIds
      .map((id) => PathHelper.resolveImageId(id))
      .filter((p): p is string => p !== null && fs.existsSync(p));
  }

  // enabled defaults to true — a generator without the field is on.
  private static isEnabled(g: ImageGenerator): boolean {
    return g.enabled !== false;
  }
}
