import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ChildProcess } from "child_process";
import { Character, Chat, Config, ImageGenerator, Model } from "../types";
import { characterPhotosDir, chatDir, chatFilesDir } from "../config";
import { createToken } from "../di";
import { ChatService } from "../chats/ChatService";
import { LlmService } from "../llm/LlmService";
import { MachineService } from "../machine";
import { DriverFactory } from "./DriverFactory";
import { ImageJobResult } from "./ImageJobResult";
import { ImageJob } from "./ImageJob";
import { IImageGeneratorDriver } from "./IImageGeneratorDriver";

// One registered background job: the public ImageJob plus the handles its
// cancellation needs — the abort controllers of the run in flight and the
// spawned process (whose whole tree the MachineService kills).
interface JobEntry {
  job: ImageJob;
  aborts: AbortController[];
  child: ChildProcess | null;
  cancelled: boolean;
}

// One entry of the reference-image inventory (see imageInventory).
export type InventoryItem = { path: string; label: string };

// The DI token of the image-generation service (registered in index.ts).
export const IMAGE_GENERATION = createToken<ImageGenerationService>("ImageGenerationService");

// The top-level image-generation service: the availability cache, the
// one-shot generateImages and the background job registry. The dependencies
// (the machine service, the config loader) are injected; all the state
// lives on the instance, not in module globals.
export class ImageGenerationService {
  // ---- available generators ----
  // Every enabled and available generator is used: jobs of different
  // generators run in PARALLEL, while the jobs of one generator are queued
  // (one run at a time per generator). At startup (and after a config change)
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

  // The in-flight (and queued) jobs, keyed by `${chatId}:${reservedName}`.
  private readonly jobs = new Map<string, JobEntry>();
  // The per-generator chains: the jobs of one generator are serialized (a
  // local program and the GPU must not be hit by several runs at once), while
  // different generators run in parallel. The chains never reject — every
  // task settles its own result.
  private readonly genChains = new Map<string, Promise<void>>();
  // The current load of each chain: the running + the queued jobs of it.
  private readonly genLoads = new Map<string, number>();

  private readonly drivers: DriverFactory;

  constructor(
    private readonly machine: MachineService,
    // The LLM service (translatePrompt for ensureEnglishPrompt) — another
    // domain service, injected like the machine one.
    private readonly llm: LlmService,
    // The chat service (importCharacterPhoto for the [PHOTO] references) —
    // the lower-level domain the image refs are copied through.
    private readonly chats: ChatService,
    // The config is read through the loader (not injected as a value), so a
    // job that starts after a settings change probes the current generators.
    private readonly loadConfig: () => Config,
  ) {
    this.drivers = new DriverFactory(machine);
  }

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

  // Generates an image with the first enabled and available generator
  // (config order). refFilenames — file names inside the chat files/.
  // Returns the name of the saved image (inside the chat files/).
  async generateImages(
    generators: ImageGenerator[],
    chatId: string,
    prompt: string,
    refFilenames: string[],
  ): Promise<string[]> {
    let driver: IImageGeneratorDriver | null = null;
    for (const g of generators) {
      if (!ImageGenerationService.isEnabled(g)) continue;
      const d = this.drivers.create(g);
      if (await d.available()) {
        driver = d;
        break;
      }
    }
    if (!driver) {
      throw new Error("Image generation is not configured (no available generator)");
    }
    const dir = chatFilesDir(chatId);
    fs.mkdirSync(dir, { recursive: true });
    const name = this.newGeneratedImageName();
    await driver.run(prompt, this.resolveRefPaths(dir, refFilenames), path.join(dir, name));
    return [name];
  }

  // The reserved file name of a generated image (in the chat files/).
  newGeneratedImageName(): string {
    return `gen-${randomUUID().slice(0, 8)}.png`;
  }

  // ---- reference-image inventory (the [IMG:... | N] / [PHOTO:N] protocol) ----

  // Images the model can reference in the [IMG:description | 1,2] tag:
  // the character's photos first, then every image already in the chat
  // (chronological order). The order = the numbers in the tag.
  imageInventory(chat: Chat, character: Character | null): InventoryItem[] {
    const items: InventoryItem[] = [];
    if (character) {
      const photosDir = characterPhotosDir(character.id);
      if (fs.existsSync(photosDir)) {
        for (const f of fs
          .readdirSync(photosDir)
          .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
          .sort()) {
          items.push({ path: path.join(photosDir, f), label: "character photo" });
        }
      }
    }
    const filesDir = chatFilesDir(chat.id);
    for (const m of chat.messages) {
      for (const img of m.images ?? []) {
        const p = path.join(filesDir, path.basename(img));
        if (fs.existsSync(p)) {
          items.push({
            path: p,
            label: m.role === "user" ? "image from the user" : "image from a reply",
          });
        }
      }
    }
    return items;
  }

  // Tag numbers -> file names in the chat files/. A character photo is copied
  // into the chat (importCharacterPhoto); chat images are taken as-is.
  resolveInventoryRefs(chatId: string, indices: number[], inventory: InventoryItem[]): string[] {
    const refs: string[] = [];
    const filesDir = chatFilesDir(chatId);
    for (const n of indices) {
      const item = inventory[n - 1];
      if (!item) continue;
      if (path.dirname(item.path) === filesDir) {
        refs.push(path.basename(item.path));
      } else {
        const name = this.chats.importCharacterPhoto(chatId, item.path);
        if (name) refs.push(name);
      }
    }
    return refs;
  }

  // ---- prompts ----

  // The generation prompts are always in English: if the text has Cyrillic,
  // translate it with the chat's model; on translation failure use the original.
  async ensureEnglishPrompt(model: Model | null, prompt: string): Promise<string> {
    if (!model || !this.hasCyrillic(prompt)) return prompt;
    try {
      return (await this.llm.translatePrompt(model, prompt)).trim() || prompt;
    } catch {
      return prompt;
    }
  }

  private hasCyrillic(text: string): boolean {
    return /[а-яё]/i.test(text);
  }

  // The job currently registered for the image (a newer one after a
  // regeneration replaced it), or undefined.
  getCurrentJob(chatId: string, name: string): ImageJob | undefined {
    return this.jobs.get(ImageGenerationService.jobKey(chatId, name))?.job;
  }

  // Cancels the in-flight job for the given image. Returns true when a job was
  // cancelled.
  cancelJob(chatId: string, name: string): boolean {
    const entry = this.jobs.get(ImageGenerationService.jobKey(chatId, name));
    if (!entry) return false;
    entry.job.cancel();
    return true;
  }

  // Cancels every in-flight (and queued) job. Used on server shutdown so a
  // stop/restart does not leave orphaned generator processes running (holding
  // the GPU). The kills are best-effort and in flight when the server exits.
  cancelAllJobs(): void {
    for (const entry of [...this.jobs.values()]) entry.job.cancel();
  }

  // Starts a background generation that writes to the reserved `name` in the
  // chat files/. The reserved name must already be part of a saved chat message
  // (with the "pending" status) — the caller updates the chat when `result`
  // resolves. The job removes itself from the registry when done.
  startImageJob(opts: { chatId: string; name: string; prompt: string; refFilenames: string[] }): ImageJob {
    const { chatId, name, prompt, refFilenames } = opts;
    const key = ImageGenerationService.jobKey(chatId, name);
    const dir = chatFilesDir(chatId);
    const target = path.join(dir, name);
    const entry: JobEntry = {
      job: null as unknown as ImageJob,
      aborts: [],
      child: null,
      cancelled: false,
    };

    const run = async (driver: IImageGeneratorDriver): Promise<ImageJobResult> => {
      // Was there a usable image at the name before this run? (decides whether
      // a failure/cancel leaves the message ready on the old file or broken.)
      const hadOld = fs.existsSync(target);
      // A unique temp file in the same dir, so the rename is atomic.
      const temp = path.join(dir, `.${name}.tmp-${randomUUID().slice(0, 8)}`);
      try {
        if (entry.cancelled) return { status: "cancelled", hadOld };
        // The chat was deleted while the job waited in the queue — do not
        // recreate its folder with an orphan image.
        if (!fs.existsSync(chatDir(chatId))) {
          return { status: "failed", error: "The chat was deleted", hadOld: false };
        }
        fs.mkdirSync(dir, { recursive: true });
        const refPaths = this.resolveRefPaths(dir, refFilenames);
        await driver.run(
          prompt,
          refPaths,
          temp,
          (child) => {
            entry.child = child;
          },
          (ctrl) => {
            entry.aborts.push(ctrl);
          },
        );
        if (entry.cancelled) {
          // The run finished but was cancelled: drop the temp, keep the old.
          fs.rmSync(temp, { force: true });
          return { status: "cancelled", hadOld };
        }
        fs.renameSync(temp, target);
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
        // registry — then it owns the key and this job must not remove it.
        if (this.jobs.get(key) === entry) this.jobs.delete(key);
      }
    };

    // Enqueues the run into its generator's chain (the per-generator queue)
    // and accounts for the chain load (for the least-loaded pick).
    const enqueue = (driver: IImageGeneratorDriver): Promise<ImageJobResult> => {
      const gk = driver.key;
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
        await this.refreshAvailableGenerators(this.loadConfig().imageGenerators);
        driver = this.pickDriver();
      }
      if (!driver) {
        return {
          status: "failed",
          error: "Image generation is not configured (no available generator)",
          hadOld: fs.existsSync(target),
        };
      }
      return enqueue(driver);
    })();

    const job: ImageJob = {
      result,
      cancel: (): void => {
        entry.cancelled = true;
        for (const a of entry.aborts) a.abort();
        // Kill the whole process tree (the program + everything it spawned) —
        // the platform-specific part lives in the MachineService.
        if (entry.child) this.machine.killTree(entry.child);
      },
    };
    entry.job = job;
    this.jobs.set(key, entry);
    return job;
  }

  // The least-loaded available generator (config order breaks the ties), or
  // null when none is available.
  private pickDriver(): IImageGeneratorDriver | null {
    let best: IImageGeneratorDriver | null = null;
    let bestLoad = Infinity;
    for (const d of this.availableDrivers) {
      const load = this.genLoads.get(d.key) ?? 0;
      if (load < bestLoad) {
        best = d;
        bestLoad = load;
      }
    }
    return best;
  }

  // Resolves reference file names (inside the chat files/) to existing
  // absolute paths.
  private resolveRefPaths(dir: string, refFilenames: string[]): string[] {
    return refFilenames.map((name) => path.join(dir, path.basename(name))).filter((p) => fs.existsSync(p));
  }

  // enabled defaults to true — a generator without the field is on.
  private static isEnabled(g: ImageGenerator): boolean {
    return g.enabled !== false;
  }

  private static jobKey(chatId: string, name: string): string {
    return `${chatId}:${name}`;
  }
}
