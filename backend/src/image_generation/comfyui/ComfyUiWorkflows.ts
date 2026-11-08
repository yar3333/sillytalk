import fs from "fs";
import path from "path";
import { PathHelper } from "../../shared/PathHelper";

// A ComfyUI workflow in the UI format — the format ComfyUI itself saves a
// workflow in. The app does not interpret the graph: it hands the template to
// the server's POST /workflow/convert and gets the API format back, so the
// templates stay editable in the ComfyUI UI. To the app a template is an
// opaque object whose PARAM_* values it substitutes before submitting.
export type ComfyUiWorkflowTemplate = Record<string, unknown>;

// The templates of one model, one per number of reference images: a reference
// goes through an edit-capable branch of the workflow (the picture enters the
// text encoder and the VAE latents), so a set carries a template for 0, 1 and
// 2 references and no more. A set may carry FEWER — a model that cannot take
// references ships only `text` — and a generation asking for more than the set
// has is refused before the job starts.
export interface ComfyUiWorkflowSet {
  text?: ComfyUiWorkflowTemplate;
  oneImage?: ComfyUiWorkflowTemplate;
  twoImages?: ComfyUiWorkflowTemplate;
}

// The template keys of a set, in the order of the reference count each serves.
const VARIANTS = ["text", "oneImage", "twoImages"] as const;
export type ComfyUiWorkflowVariant = (typeof VARIANTS)[number];

// The variants in the order of their reference count (0, 1, 2) — exported for
// the callers that walk the templates of a model one by one (the ComfyUI
// self-test), rather than hardcoding the names again.
export const COMFYUI_WORKFLOW_VARIANTS: readonly ComfyUiWorkflowVariant[] = VARIANTS;

// Which of the two folders a workflow file came from.
export type ComfyUiWorkflowSource = "app" | "user";

// One workflow of the catalogue as the app sees it: which file defines it
// (the user's own wins), what it can draw, and — when it cannot — why. The
// self-test prints this table; the app only needs the name list, so the errors
// stay out of the log until a caller asks.
export interface ComfyUiWorkflowEntry {
  model: string;
  /** The file the app would load — the user's own even when it is broken. */
  file: string;
  source: ComfyUiWorkflowSource;
  /** The templates it defines; null when the file cannot be used at all. */
  set: ComfyUiWorkflowSet | null;
  /** Why the file is not a workflow the app can run. */
  error?: string;
  /**
   * A broken user file that shadows a readable shipped workflow: the app uses
   * the user's file and does NOT fall back, so the shipped copy sitting right
   * next to it is worth naming in the report.
   */
  shadowed?: string;
}

// Where the workflows live — two folders, read on every lookup:
//
//   <this folder>/workflows/<model>.json   the ones the app ships; the source
//       of truth is backend/src/image_generation/comfyui/workflows/ and the
//       build step (backend "scripts/copy-workflows.cjs") copies them next to
//       the compiled module, which is where __dirname points at runtime;
//   <data root>/comfyui/<model>.json       the user's own: a file named after
//       a shipped model replaces it, a file with a new name adds a model that
//       shows up in the Settings pick like any other.
//
// Nothing is cached here on purpose: a template is tens of kilobytes and a
// generation is a GPU job, so re-reading costs nothing, while a cache is
// exactly what would make the user's edit invisible. The one expensive thing —
// the server's POST /workflow/convert — is cached in ComfyUiDriver, and that
// cache is keyed by the template text so an edited file converts again.
function bundledDir(): string {
  return path.join(__dirname, "workflows");
}

// A model name is a file stem here, never a path — a hand-written config must
// not be able to point the loader at a file outside the two folders.
function isModelName(model: string): boolean {
  return !!model && !model.includes("/") && !model.includes("\\") && !model.includes("\0");
}

// The workflow files of one folder as `model name -> file path`; a folder that
// does not exist simply has none.
function modelFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    files.set(entry.name.slice(0, -".json".length), path.join(dir, entry.name));
  }
  return files;
}

// Reads and validates one workflow file: JSON holding an object with at least
// one of the known templates. Anything else is not a workflow, and the reason
// comes back with the file so a caller can say it out loud — the server log for
// the app, the self-test report for the user, who wrote half of these files and
// deserves to know what is wrong with one.
interface WorkflowFileRead {
  file: string;
  source: ComfyUiWorkflowSource;
  set: ComfyUiWorkflowSet | null;
  error?: string;
}

function readWorkflowFile(file: string, source: ComfyUiWorkflowSource): WorkflowFileRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { file, source, set: null, error: `not readable JSON — ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { file, source, set: null, error: "expected an object holding the workflow templates" };
  }
  const graph = parsed as Record<string, unknown>;
  const set: ComfyUiWorkflowSet = {};
  for (const variant of VARIANTS) {
    const template = graph[variant];
    if (template && typeof template === "object" && !Array.isArray(template)) {
      set[variant] = template as ComfyUiWorkflowTemplate;
    }
  }
  if (Object.keys(set).length === 0) {
    return {
      file,
      source,
      set: null,
      error:
        `holds none of "${VARIANTS.join(", ")}" — the file keeps the ComfyUI graph ` +
        `under those keys, one per number of reference images`,
    };
  }
  return { file, source, set };
}

// The workflow file that defines a model: the user's own when it is there —
// even when it is broken, because falling back to the shipped one would make
// the file they just wrote look like it did nothing — and the shipped one
// otherwise. Null when neither exists.
function workflowFileOf(model: string): string | null {
  if (!isModelName(model)) return null;
  const name = `${model.trim()}.json`;
  for (const dir of [PathHelper.comfyWorkflowsDir(), bundledDir()]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The workflow set of a model, or null when no readable workflow file defines
// it — the model is then not one the app can draw with. A file the app cannot
// use is written to the server log here, because this is where a job finds out
// and the alternative is a generation failing over a file nobody explained.
export function comfyUiWorkflowSet(model: string): ComfyUiWorkflowSet | null {
  const file = workflowFileOf(model);
  if (!file) return null;
  const read = readWorkflowFile(file, file.startsWith(path.resolve(bundledDir())) ? "app" : "user");
  if (read.error) console.error(`ComfyUI workflow ${file}: ${read.error}`);
  return read.set;
}

// Every workflow of the catalogue — the shipped ones and the user's own, a user
// file winning over a shipped one of the same name — each with the templates it
// defines or the reason it is unusable. This is the shape a person reads; the
// app itself only ever asks for a name (comfyUiWorkflowSet) or the name list.
export function comfyUiWorkflowEntries(): ComfyUiWorkflowEntry[] {
  const byModel = new Map<string, { app?: WorkflowFileRead; user?: WorkflowFileRead }>();
  const collect = (dir: string, source: ComfyUiWorkflowSource): void => {
    for (const [name, file] of modelFiles(dir)) {
      const read = readWorkflowFile(file, source);
      const slot = byModel.get(name) ?? {};
      slot[source] = read;
      byModel.set(name, slot);
    }
  };
  collect(bundledDir(), "app");
  collect(PathHelper.comfyWorkflowsDir(), "user");

  const entries: ComfyUiWorkflowEntry[] = [];
  for (const [model, slot] of byModel) {
    // The user's file wins even when it is broken — silently falling back to
    // the shipped one would make the file they just wrote look ignored. The
    // report names the shipped copy that is being shadowed so the fix is obvious.
    const used = slot.user ?? slot.app;
    if (!used) continue;
    entries.push({
      model,
      file: used.file,
      source: used.source,
      set: used.set,
      error: used.error,
      shadowed: slot.user?.error && slot.app?.set ? slot.app.file : undefined,
    });
  }
  return entries.sort((a, b) => a.model.localeCompare(b.model));
}

// The models the app can draw with: every readable workflow of the catalogue. A
// model whose file cannot be read is left out, so a generator naming it becomes
// unavailable instead of failing every job with a parse error — the reason is
// already in the log by way of comfyUiWorkflowSet.
export function comfyUiModelNames(): string[] {
  const names: string[] = [];
  for (const entry of comfyUiWorkflowEntries()) {
    if (entry.set) names.push(entry.model);
    else console.error(`ComfyUI workflow ${entry.file}: ${entry.error}`);
  }
  return names.sort();
}

// The template that serves `refCount` reference images. A count above the
// highest template is checked by the caller (comfyUiMaxRefs) BEFORE picking, so
// here it is only one of 0, 1 and 2.
export function variantFor(refCount: number): ComfyUiWorkflowVariant {
  if (refCount === 0) return "text";
  if (refCount === 1) return "oneImage";
  return "twoImages";
}

// The template of a model for a generation with `refCount` references, or null
// when the model is unknown to the app or has no template for that count.
export function comfyUiWorkflowFor(model: string, refCount: number): ComfyUiWorkflowTemplate | null {
  return comfyUiWorkflowSet(model)?.[variantFor(refCount)] ?? null;
}

// How many reference images a workflow set takes — the highest template it
// holds, so a generation asking for more is refused before the job starts
// rather than drawing from a template that has no place for the extra picture.
// It is read off the set the caller already has: a model whose file holds only
// `text` takes no references, whatever the app itself ships.
export function comfyUiMaxRefs(set: ComfyUiWorkflowSet | null): number {
  if (!set) return -1;
  for (let refs = VARIANTS.length - 1; refs >= 0; refs--) {
    if (set[variantFor(refs)]) return refs;
  }
  return -1;
}
