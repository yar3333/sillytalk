import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { SdApiSettings, ImageGenerator, LocalProgramSettings, isLocalGenerator } from './types';
import { chatDir, chatFilesDir, expandPath, loadConfig } from './config';
import { getMachineService } from './machine';

// ---- available generators ----
// Every enabled and available generator is used: jobs of different
// generators run in PARALLEL, while the jobs of one generator are queued
// (one run at a time per generator). At startup (and after a config change)
// the imageGenerators entries are probed (in parallel) and the available
// ones are cached here.
let availableGenerators: ImageGenerator[] = [];

export function getAvailableGenerators(): ImageGenerator[] {
  return availableGenerators;
}

export function hasAvailableGenerator(): boolean {
  return availableGenerators.length > 0;
}

// Recomputes the available generators; called at startup and when settings
// are saved. The SD API probes run in parallel.
export async function refreshAvailableGenerators(
  generators: ImageGenerator[],
): Promise<ImageGenerator[]> {
  const probed = await Promise.all(
    generators.map(async (g) =>
      generatorEnabled(g) && (await generatorAvailable(g)) ? g : null,
    ),
  );
  availableGenerators = probed.filter((g): g is ImageGenerator => g !== null);
  return availableGenerators;
}

// enabled defaults to true — a generator without the field is on.
function generatorEnabled(g: ImageGenerator): boolean {
  return g.enabled !== false;
}

// The identity of a generator for the per-generator queue: the command
// (local program) or the URL (SD API). Two config entries pointing at the
// same program share a queue — the program (and the GPU) must not be hit
// by several runs at once.
function generatorKey(g: ImageGenerator): string {
  return isLocalGenerator(g)
    ? `cmd:${expandPath(g.command)}`
    : `url:${g.url.replace(/\/+$/, '')}`;
}

async function sdApiGenerate(
  cfg: SdApiSettings,
  prompt: string,
  refPaths: string[],
  registerAbort: (ctrl: AbortController) => void = () => undefined,
): Promise<Buffer[]> {
  const endpoint = refPaths.length > 0 ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img';
  const payload: Record<string, unknown> = {
    prompt,
    steps: cfg.steps,
    width: cfg.width,
    height: cfg.height,
    negative_prompt: cfg.negativePrompt,
  };
  if (refPaths.length > 0) {
    payload.init_images = refPaths.map((p) => fs.readFileSync(p).toString('base64'));
    payload.denoising_strength = cfg.denoisingStrength;
  }

  // The AbortController is registered so a background job can cancel the
  // request in flight (the cancel-image endpoint).
  const ctrl = new AbortController();
  registerAbort(ctrl);
  const response = await fetch(`${cfg.url.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`SD API returned ${response.status}: ${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as { images?: string[] };
  if (!data.images?.length) throw new Error('SD API returned no images');
  return data.images.map((b64) => Buffer.from(b64, 'base64'));
}

// SD API availability: does the server answer /sdapi/v1/sd-models (short timeout).
async function sdApiAvailable(cfg: SdApiSettings): Promise<boolean> {
  if (!cfg.url) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/sdapi/v1/sd-models`, {
        signal: ctrl.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// A local program is available if a command is set. If the command looks like
// an absolute path to a file — check that the file exists.
function localAvailable(cfg: LocalProgramSettings): boolean {
  const cmd = expandPath(cfg.command ?? '').trim();
  if (!cmd) return false;
  if (/^[a-zA-Z]:[\\/]/.test(cmd) || cmd.startsWith('\\\\') || cmd.startsWith('/')) {
    return fs.existsSync(cmd);
  }
  return true;
}

async function generatorAvailable(g: ImageGenerator): Promise<boolean> {
  return isLocalGenerator(g) ? localAvailable(g) : sdApiAvailable(g);
}

// The first enabled and available generator in config order.
async function firstAvailable(generators: ImageGenerator[]): Promise<ImageGenerator | null> {
  for (const g of generators) {
    if (generatorEnabled(g) && (await generatorAvailable(g))) return g;
  }
  return null;
}

// The reserved file name of a generated image (in the chat files/).
export function newGeneratedImageName(): string {
  return `gen-${randomUUID().slice(0, 8)}.png`;
}

// Resolves reference file names (inside the chat files/) to existing absolute
// paths.
function resolveRefPaths(dir: string, refFilenames: string[]): string[] {
  return refFilenames
    .map((name) => path.join(dir, path.basename(name)))
    .filter((p) => fs.existsSync(p));
}

// Runs one generator to produce a SINGLE image and write it to outPath
// (absolute). Local programs write the file themselves (the path is
// substituted into {absolutePathToOutputImage}); the SD API returns buffers.
// registerChild / registerAbort let a caller cancel a run in flight (a
// background job); both are optional.
async function writeOneImage(
  gen: ImageGenerator,
  prompt: string,
  refPaths: string[],
  outPath: string,
  registerChild?: (child: ChildProcess) => void,
  registerAbort?: (ctrl: AbortController) => void,
): Promise<void> {
  if (isLocalGenerator(gen)) {
    if (gen.maxInputImages > 0 && refPaths.length > gen.maxInputImages) {
      throw new Error(
        `The generator supports at most ${gen.maxInputImages} reference images (${refPaths.length} provided)`,
      );
    }
    if (!gen.command) throw new Error('The local generator program command is not set');
    // local: a single program run; the backend places the output file itself —
    // the tool must write the PNG by absolute path.
    // {prompt} — the prompt text; {absolutePathsToInputImages} — comma-joined
    // absolute reference paths (empty when there are none);
    // {absolutePathToOutputImage} — the absolute output file path.
    const args = gen.args.map((arg) =>
      arg
        .replaceAll('{prompt}', prompt)
        .replaceAll('{absolutePathsToInputImages}', refPaths.join(','))
        .replaceAll('{absolutePathToOutputImage}', outPath),
    );
    const command = expandPath(gen.command);
    const machine = getMachineService();
    await machine.runProgram(command, args, registerChild);
    if (!fs.existsSync(outPath)) {
      throw new Error(
        `The program did not create the file ${outPath}\nCommand line: ${machine.commandLine(command, args)}`,
      );
    }
    return;
  }

  const buffers = await sdApiGenerate(gen, prompt, refPaths, registerAbort);
  fs.writeFileSync(outPath, buffers[0]);
}

// Generates images for a chat with the first enabled and available
// generator (config order). refFilenames — file names inside the chat
// files/. Returns the names of the saved images (inside the chat files/).
export async function generateImages(
  generators: ImageGenerator[],
  chatId: string,
  prompt: string,
  refFilenames: string[],
): Promise<string[]> {
  const gen = await firstAvailable(generators);
  if (!gen) {
    throw new Error('Image generation is not configured (no available generator)');
  }
  const dir = chatFilesDir(chatId);
  fs.mkdirSync(dir, { recursive: true });
  const refPaths = resolveRefPaths(dir, refFilenames);

  if (isLocalGenerator(gen)) {
    const name = newGeneratedImageName();
    await writeOneImage(gen, prompt, refPaths, path.join(dir, name));
    return [name];
  }

  // The SD API can return several images at once — save each of them.
  const buffers = await sdApiGenerate(gen, prompt, refPaths);
  return buffers.map((buffer) => {
    const name = newGeneratedImageName();
    fs.writeFileSync(path.join(dir, name), buffer);
    return name;
  });
}

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

export type ImageJobResult =
  | { status: 'ok' }
  // hadOld — an image already existed at the name before the run, so a
  // failed/cancelled run leaves the message ready on the old file.
  | { status: 'failed'; error: string; hadOld: boolean }
  | { status: 'cancelled'; hadOld: boolean };

export interface ImageJob {
  // Resolves when the generation finishes (ok / failed / cancelled).
  readonly result: Promise<ImageJobResult>;
  // Cancels the run in flight. A job that has not started yet is dropped.
  cancel(): void;
}

interface JobEntry {
  job: ImageJob;
  aborts: AbortController[];
  child: ChildProcess | null;
  cancelled: boolean;
}

// The in-flight (and queued) jobs, keyed by `${chatId}:${reservedName}`.
const jobs = new Map<string, JobEntry>();
// The per-generator chains: the jobs of one generator are serialized (a
// local program and the GPU must not be hit by several runs at once), while
// different generators run in parallel. The chains never reject — every
// task settles its own result.
const genChains = new Map<string, Promise<void>>();
// The current load of each chain: the running + the queued jobs of it.
const genLoads = new Map<string, number>();

// The least-loaded available generator (config order breaks the ties), or
// null when none is available.
function pickGenerator(): ImageGenerator | null {
  let best: ImageGenerator | null = null;
  let bestLoad = Infinity;
  for (const g of availableGenerators) {
    const load = genLoads.get(generatorKey(g)) ?? 0;
    if (load < bestLoad) {
      best = g;
      bestLoad = load;
    }
  }
  return best;
}

export function jobKey(chatId: string, name: string): string {
  return `${chatId}:${name}`;
}

// The job currently registered for the image (a newer one after a
// regeneration replaced it), or undefined.
export function getCurrentJob(chatId: string, name: string): ImageJob | undefined {
  return jobs.get(jobKey(chatId, name))?.job;
}

// Cancels the in-flight job for the given image. Returns true when a job was
// cancelled.
export function cancelJob(chatId: string, name: string): boolean {
  const entry = jobs.get(jobKey(chatId, name));
  if (!entry) return false;
  entry.job.cancel();
  return true;
}

// Cancels every in-flight (and queued) job. Used on server shutdown so a
// stop/restart does not leave orphaned generator processes running (holding
// the GPU). The kills are best-effort and in flight when the server exits.
export function cancelAllJobs(): void {
  for (const entry of [...jobs.values()]) entry.job.cancel();
}

// Starts a background generation that writes to the reserved `name` in the
// chat files/. The reserved name must already be part of a saved chat message
// (with the "pending" status) — the caller updates the chat when `result`
// resolves. The job removes itself from the registry when done.
export function startImageJob(opts: {
  chatId: string;
  name: string;
  prompt: string;
  refFilenames: string[];
}): ImageJob {
  const { chatId, name, prompt, refFilenames } = opts;
  const key = jobKey(chatId, name);
  const dir = chatFilesDir(chatId);
  const target = path.join(dir, name);
  const entry: JobEntry = {
    job: null as unknown as ImageJob,
    aborts: [],
    child: null,
    cancelled: false,
  };

  const run = async (gen: ImageGenerator): Promise<ImageJobResult> => {
    // Was there a usable image at the name before this run? (decides whether
    // a failure/cancel leaves the message ready on the old file or broken.)
    const hadOld = fs.existsSync(target);
    // A unique temp file in the same dir, so the rename is atomic.
    const temp = path.join(dir, `.${name}.tmp-${randomUUID().slice(0, 8)}`);
    try {
      if (entry.cancelled) return { status: 'cancelled', hadOld };
      // The chat was deleted while the job waited in the queue — do not
      // recreate its folder with an orphan image.
      if (!fs.existsSync(chatDir(chatId))) {
        return { status: 'failed', error: 'The chat was deleted', hadOld: false };
      }
      fs.mkdirSync(dir, { recursive: true });
      const refPaths = resolveRefPaths(dir, refFilenames);
      await writeOneImage(
        gen,
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
        return { status: 'cancelled', hadOld };
      }
      fs.renameSync(temp, target);
      return { status: 'ok' };
    } catch (err) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // the temp cleanup failed — the result still has to settle
      }
      if (entry.cancelled) return { status: 'cancelled', hadOld };
      return { status: 'failed', error: (err as Error).message, hadOld };
    } finally {
      // A newer job (a regeneration) may have replaced this one in the
      // registry — then it owns the key and this job must not remove it.
      if (jobs.get(key) === entry) jobs.delete(key);
    }
  };

  // Enqueues the run into its generator's chain (the per-generator queue)
  // and accounts for the chain load (for the least-loaded pick).
  const enqueue = (gen: ImageGenerator): Promise<ImageJobResult> => {
    const gk = generatorKey(gen);
    genLoads.set(gk, (genLoads.get(gk) ?? 0) + 1);
    const prev = genChains.get(gk) ?? Promise.resolve();
    const runP: Promise<ImageJobResult> = prev.then(() => run(gen)).finally(() => {
      genLoads.set(gk, Math.max(0, (genLoads.get(gk) ?? 1) - 1));
    });
    genChains.set(gk, runP.then(() => undefined, () => undefined));
    return runP;
  };

  const result: Promise<ImageJobResult> = (async (): Promise<ImageJobResult> => {
    // The generator is picked when the job starts: the least-loaded
    // available one (so the jobs spread over the generators). If the cache
    // is empty (no startup refresh yet) the availability is recomputed
    // first.
    let gen = pickGenerator();
    if (!gen) {
      await refreshAvailableGenerators(loadConfig().imageGenerators);
      gen = pickGenerator();
    }
    if (!gen) {
      return {
        status: 'failed',
        error: 'Image generation is not configured (no available generator)',
        hadOld: fs.existsSync(target),
      };
    }
    return enqueue(gen);
  })();

  const job: ImageJob = {
    result,
    cancel(): void {
      entry.cancelled = true;
      for (const a of entry.aborts) a.abort();
      // Kill the whole process tree (the program + everything it spawned) —
      // the platform-specific part lives in the MachineService.
      if (entry.child) getMachineService().killTree(entry.child);
    },
  };
  entry.job = job;
  jobs.set(key, entry);
  return job;
}
