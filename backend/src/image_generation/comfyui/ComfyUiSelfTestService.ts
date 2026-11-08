import fs from "fs";
import path from "path";
import { deflateSync } from "zlib";
import { ComfyUiSettings } from "../../configuration/ComfyUiSettings";
import { PathHelper } from "../../shared/PathHelper";
import { ApiNode, ApiWorkflow, ComfyUiDriver } from "../drivers/ComfyUiDriver";
import {
  COMFYUI_WORKFLOW_VARIANTS,
  ComfyUiWorkflowEntry,
  ComfyUiWorkflowVariant,
  comfyUiMaxRefs,
  comfyUiWorkflowEntries,
} from "./ComfyUiWorkflows";
import { comboOptionsOf, ComfyUiNodeClass, ComfyUiObjectInfo, ComfyUiSystemStats } from "./ComfyUiServerInfo";

// The ComfyUI self-test behind `sillytalk test-comfyui <url>`.
//
// It answers one question end to end — can this server draw the pictures this
// app sends it, and if not, which of the things between the app and a finished
// PNG is missing — without the user opening the ComfyUI console or reading the
// app log. So it walks the same chain the app walks, cheapest step first, and
// says out loud what each step answered:
//
//   1. GET  /system_stats    — is the server there at all, on what version, on
//      which GPU, with how much VRAM free (the answer the app caches as
//      "available" is only yes/no; here it is the hardware it runs on);
//   2. the workflow files    — which models the app can draw with, from which
//      folder, and why a file it holds is not one;
//   3. POST /workflow/convert — the converter custom node, per template: a
//      missing node is the most common reason nothing works and the app cannot
//      draw a single picture without it;
//   4. GET  /object_info     — every node class and every model name the server
//      really has, compared with what the converted workflows ask for, so a
//      checkpoint the server does not have is named BEFORE a job fails on it;
//   5. the generation itself — one real job per model and per template (0, 1
//      and 2 reference images go through different branches of a workflow, so a
//      server can pass one and fail the others), with the picture kept on disk
//      so the user can look at it.
//
// Steps 1–4 cost seconds; step 5 costs one GPU job per template — which is why
// it comes last and why everything before it is reported first.
//
// The service knows neither the config nor the running app: the point is to
// test a server the user is about to configure. It takes the URL and the run
// settings as options, reads nothing but the workflow catalogue, and writes
// nothing outside its output folder.

// What one template ended as. "skipped" is a template the run did not try —
// after a cancel, or a text-only run (--no-refs), or because the step before it
// already failed for the whole server.
export type ComfyUiSelfTestStatus = "ok" | "failed" | "skipped";

// A run of the self-test. Everything has a default, so
// `sillytalk test-comfyui http://127.0.0.1:8188` alone does the whole job.
export interface ComfyUiSelfTestOptions {
  /** The ComfyUI server — a bare host:port is taken as http://. */
  url: string;
  /** The GPU the workflow loaders pin to (PARAM_DEVICE). */
  device?: string;
  /** The size the test pictures are drawn at (the workflow's own steps and CFG apply). */
  width?: number;
  height?: number;
  /** Only these workflow names (default: every workflow of the catalogue). */
  models?: string[];
  /** The prompt of the test pictures. */
  prompt?: string;
  /** Where the test pictures go (default `<data root>/comfyui-test`). */
  outDir?: string;
  /** Draw at all (false = the checks only, `--no-draw`). */
  draw?: boolean;
  /** Also draw the reference templates (false = the text template only). */
  withRefs?: boolean;
}

// What happened to one template of one model.
export interface ComfyUiSelfTestItem {
  model: string;
  variant: ComfyUiWorkflowVariant;
  refs: number;
  status: ComfyUiSelfTestStatus;
  seconds: number;
  /** The picture on disk (only when there was one to write). */
  outPath?: string;
  bytes?: number;
  /** The size the file itself says it has, when it is a readable picture. */
  drawnWidth?: number;
  drawnHeight?: number;
  error?: string;
  /** What the user can do about this one. */
  hints: string[];
  /** What looked wrong before the draw (a node or a model name the server lacks). */
  warnings: string[];
}

// The whole run — the caller's exit code and the machine-readable part of the
// report (the lines the user reads were already written through the log sink).
export interface ComfyUiSelfTestReport {
  /** True when nothing failed and nothing needed a look. */
  ok: boolean;
  url: string;
  outDir: string;
  seconds: number;
  /** Set when the server itself could not be tested — nothing else was tried. */
  fatal?: string;
  /** One sentence the run ends on. */
  verdict: string;
  /** The workflow catalogue as it was read (unusable files included, with the reason). */
  workflows: ComfyUiWorkflowEntry[];
  items: ComfyUiSelfTestItem[];
  /** Every problem found, in the order the run met them. */
  problems: string[];
}

// Where the run reports as it goes. A line sink rather than a structured
// formatter on purpose: the lines ARE the product of a diagnostic command, and
// the test reads them back the way the user would.
export type ComfyUiSelfTestLog = (line: string) => void;

const DEFAULT_DEVICE = "cuda:0";
const DEFAULT_SIZE = 1024;
// A short, boring prompt: the test is about the plumbing, and a prompt that
// needs extra GPU time only makes the slow paths harder to read.
const DEFAULT_PROMPT = "a red apple on a wooden table, studio light, sharp focus";
// The probes of the server. A live ComfyUI answers these in well under a second,
// so a long wait means the machine is busy loading a model rather than the
// request being lost — but a diagnostic must not hang on one either.
const STATS_TIMEOUT_MS = 15_000;
const CONVERT_TIMEOUT_MS = 60_000;
// The picture a reference template is drawn from: a real PNG the server can
// decode, big enough not to look like a degenerate input.
const REFERENCE_SIZE = 512;

export class ComfyUiSelfTestService {
  // The cancel of the whole run (between the steps) and of the job that is
  // running right now — aborting that one also tells the server to drop it.
  private runCtrl: AbortController | null = null;
  private jobCtrl: AbortController | null = null;
  private cancelled = false;
  // The server answered the first probe and then stopped answering: a ComfyUI
  // that dies in the middle of a run (a driver abort, an OOM killer) is one
  // event with one cause, not N failures of N templates — see serverLost.
  private serverWasAlive = false;
  private serverLost = false;

  /**
   * Stop the run: the current job is aborted and the server is asked to drop
   * what it was given (the driver does that on abort), the templates after it
   * are reported as skipped. The CLI calls this on Ctrl+C, so pressing it does
   * not leave a generation running on the server with nobody waiting for it.
   */
  cancel(): void {
    this.cancelled = true;
    this.runCtrl?.abort();
    this.jobCtrl?.abort();
  }

  async run(options: ComfyUiSelfTestOptions, log: ComfyUiSelfTestLog): Promise<ComfyUiSelfTestReport> {
    const started = Date.now();
    this.runCtrl = new AbortController();
    this.cancelled = false;
    this.serverWasAlive = false;
    this.serverLost = false;

    const url = ComfyUiSelfTestService.normalizeUrl(options.url);
    const device = options.device?.trim() || DEFAULT_DEVICE;
    const width = options.width ?? DEFAULT_SIZE;
    const height = options.height ?? DEFAULT_SIZE;
    const prompt = options.prompt?.trim() || DEFAULT_PROMPT;
    const outDir = options.outDir?.trim() || path.join(PathHelper.configDir(), "comfyui-test");
    const draw = options.draw !== false;
    const withRefs = options.withRefs !== false;

    const report: ComfyUiSelfTestReport = {
      ok: false,
      url,
      outDir,
      seconds: 0,
      verdict: "",
      workflows: [],
      items: [],
      problems: [],
    };
    const probe = this.driverFor({ url, model: "", device, width, height });

    log(`sillytalk ComfyUI self-test — ${url}`);
    log(`  draws ${width}x${height}, GPU ${device}`);
    log(`  pictures to ${outDir}`);
    log(`  workflows   ${ComfyUiSelfTestService.dirLabel()}`);

    // ---- 1. the server ----
    log("");
    log("[1/5] The server (GET /system_stats)");
    if (!(await this.checkServer(probe, url, device, width, height, log, report))) {
      report.fatal = report.problems[0] ?? `The ComfyUI server at ${url} did not answer.`;
      return this.finish(report, started, log, draw);
    }

    // ---- 2. the workflows ----
    log("");
    log("[2/5] The workflow files of the app");
    const all = comfyUiWorkflowEntries();
    const workflows = all.filter((entry) => !options.models?.length || options.models.includes(entry.model));
    report.workflows = workflows;
    if (workflows.length === 0) {
      report.problems.push(
        options.models?.length
          ? `No workflow of the app is named "${options.models.join(", ")}" — the catalogue has: ${
              all.map((e) => e.model).join(", ") || "(nothing)"
            }`
          : `The app has no workflow to draw with: nothing readable in ${ComfyUiSelfTestService.dirLabel()}`,
      );
      log(`  ${report.problems[0]}`);
      return this.finish(report, started, log, draw);
    }
    const usable: ComfyUiWorkflowEntry[] = [];
    for (const entry of workflows) {
      if (!entry.set) {
        report.problems.push(`the workflow "${entry.model}" cannot be used: ${entry.error} (${entry.file})`);
        log(`  BROKEN  ${entry.model} [${entry.source}] ${entry.file}`);
        log(`          ${entry.error}`);
        if (entry.shadowed) {
          log(`          the shipped workflow it replaces IS readable: ${entry.shadowed}`);
          log(`          the app uses your file and does not fall back to that one`);
        }
        continue;
      }
      usable.push(entry);
      const variants = COMFYUI_WORKFLOW_VARIANTS.filter((v) => entry.set?.[v]).join(", ");
      log(`  ok      ${entry.model} [${entry.source}] ${variants} (at most ${comfyUiMaxRefs(entry.set)} references)`);
    }
    if (usable.length === 0) {
      report.fatal = "None of the workflow files the app has can be used.";
      return this.finish(report, started, log, draw);
    }

    // ---- 3. the converter node, 4. the nodes and models of the server ----
    log("");
    log("[3/5] The workflow converter (POST /workflow/convert)");
    const converted = new Map<string, ApiWorkflow[]>();
    if (await this.checkConvert(usable, converted, url, device, width, height, log, report)) {
      return this.finish(report, started, log, draw);
    }

    log("");
    log("[4/5] The nodes and model files of the server (GET /object_info)");
    const objectInfo = await this.loadObjectInfo(probe, log);
    if (objectInfo) {
      for (const entry of usable) {
        await this.checkWorkflowNodes(
          entry,
          converted.get(entry.model) ?? [],
          this.driverFor({ url, model: entry.model, device, width, height }),
          objectInfo,
          log,
          report,
        );
      }
    }

    // ---- 5. the real generations ----
    log("");
    if (!draw) {
      log("[5/5] Generation — skipped (--no-draw)");
      if (report.problems.length === 0) log("  everything the checks can reach is in order");
      return this.finish(report, started, log, draw);
    }
    log(`[5/5] Generation — one real job per template of every workflow (${width}x${height})`);
    const refs = withRefs ? this.referencePictures(outDir, log) : [];
    for (const entry of usable) {
      if (!entry.set) continue;
      for (const variant of COMFYUI_WORKFLOW_VARIANTS) {
        if (!entry.set[variant]) continue;
        const refCount = ComfyUiSelfTestService.refCountOf(variant);
        const label = `${entry.model}/${variant}`;
        if (refCount > 0 && !withRefs) {
          log(`  skip    ${label} — the reference templates are not drawn (--no-refs)`);
          continue;
        }
        // A server that died mid-run is one event, not a list of failures: the
        // templates after it could only repeat the same connection error, so they
        // are reported as what they are — never tried.
        if (this.serverLost) {
          report.items.push({
            model: entry.model,
            variant,
            refs: refCount,
            status: "skipped",
            seconds: 0,
            hints: [],
            warnings: [],
            error: "not tried — the server stopped answering during this run",
          });
          log(`  skip    ${label} — the server stopped answering during this run`);
          continue;
        }
        if (refCount > refs.length) {
          report.items.push({
            model: entry.model,
            variant,
            refs: refCount,
            status: "failed",
            seconds: 0,
            hints: [],
            warnings: [],
            error: "no test reference picture could be written to draw from",
          });
          report.problems.push(`${label}: no test reference picture could be written to draw from`);
          log(`  FAILED  ${label} — no test reference picture could be written to draw from`);
          continue;
        }
        await this.drawOne(entry, variant, refs.slice(0, refCount), prompt, outDir, device, width, height, log, report);
      }
    }

    // The second reading of the device list: by now torch has loaded a model, so
    // the field that was empty before the first job can name the GPU and its
    // free VRAM. A server that died in the run cannot answer this, and asking it
    // would only bury the real finding under a connection error.
    if (report.items.some((i) => i.seconds > 0) && !this.serverLost) {
      log("");
      log("The server again, now that it has drawn (GET /system_stats)");
      try {
        const stats = await probe.systemStats(STATS_TIMEOUT_MS);
        if (stats?.system) this.reportDevices(stats.system, { width, height, device, log, report, afterDraws: true });
      } catch (err) {
        log(`  skipped — it did not answer this time (${ComfyUiSelfTestService.errorText(err)})`);
      }
    }

    return this.finish(report, started, log, draw);
  }

  // ---- step 1: the server ----

  private async checkServer(
    driver: ComfyUiDriver,
    url: string,
    device: string,
    width: number,
    height: number,
    log: ComfyUiSelfTestLog,
    report: ComfyUiSelfTestReport,
  ): Promise<boolean> {
    let stats: ComfyUiSystemStats;
    try {
      stats = await driver.systemStats(STATS_TIMEOUT_MS);
    } catch (err) {
      const text = ComfyUiSelfTestService.errorText(err);
      const { explanation, hints } = ComfyUiSelfTestService.serverProblem(text, url);
      log(`  FAILED  ${explanation}`);
      log(`          ${text}`);
      for (const hint of hints) log(`          ${hint}`);
      report.problems.push(`${explanation} — ${hints[0] ?? "check the address and that the server is running"}`);
      return false;
    }

    const system = stats?.system;
    if (!system || typeof system !== "object") {
      const why = `${url} answered /system_stats with something that is not ComfyUI's answer: ${ComfyUiSelfTestService.brief(stats)}`;
      log(`  FAILED  ${why}`);
      log(`          the URL must be a ComfyUI server (its own port, 8188 by default), not another service`);
      report.problems.push(why);
      return false;
    }

    log(
      `  ok      ComfyUI ${system.comfyui_version ?? "?"}, python ${system.python_version ?? "?"}, ` +
        `pytorch ${system.pytorch_version ?? "?"} (${system.os ?? "?"})`,
    );
    if (typeof system.ram_total === "number") {
      log(`          RAM ${ComfyUiSelfTestService.mib(system.ram_total)} MiB`);
    }
    this.reportDevices(system, { width, height, device, log, report, afterDraws: false });
    this.serverWasAlive = true;
    return true;
  }

  /**
   * The compute devices the server reports, with the two checks that are worth
   * a warning: a GPU whose VRAM is already nearly full (another inference
   * server on the same box — from the chat this looks exactly like a broken
   * generator) and a `--device` the server does not have.
   *
   * It is called twice because of how this field behaves in practice: a server
   * was seen answering /system_stats without a device list before its first job
   * and drawing three pictures on its GPU right after it (0.44 / ROCm), so an
   * empty list before the draws says nothing and must not be reported as a
   * problem — ComfyUI builds the list from torch, which is the likely reason it
   * is not filled until a model has been loaded. After a real job the same field
   * is read again, and that reading is the one worth printing.
   */
  private reportDevices(
    system: NonNullable<ComfyUiSystemStats["system"]>,
    ctx: {
      width: number;
      height: number;
      device: string;
      log: ComfyUiSelfTestLog;
      report: ComfyUiSelfTestReport;
      afterDraws: boolean;
    },
  ): void {
    const { width, height, device, log, report } = ctx;
    const devices = Array.isArray(system.devices) ? system.devices : [];
    if (devices.length === 0) {
      log(
        ctx.afterDraws
          ? `          still no compute device in the answer after drawing — so there is nothing to check the --device of a generator against`
          : `          no compute device in the answer — a server often reports them only once it has loaded a model, so this is read again after the first job`,
      );
      return;
    }
    const indexes: string[] = [];
    for (const d of devices) {
      const vram =
        typeof d.vram_total === "number"
          ? ` — ${ComfyUiSelfTestService.mib(d.vram_total)} MiB total, ` +
            `${ComfyUiSelfTestService.mib(d.vram_free ?? 0)} MiB free`
          : "";
      log(`          ${d.name ?? d.type ?? "device"}${vram}`);
      if (d.index !== undefined) indexes.push(String(d.index));
      // Only the first reading is the state a new job would start from; after a
      // draw the free VRAM is whatever that job just left behind.
      if (!ctx.afterDraws && typeof d.vram_free === "number" && d.vram_free < 2 * 1024 * 1024 * 1024) {
        const warn =
          `${d.name ?? "A device"} of the server has only ${ComfyUiSelfTestService.mib(d.vram_free)} MiB of VRAM free` +
          ` — a ${width}x${height} job will most likely fail out of memory`;
        log(`  WARNING ${warn}`);
        report.problems.push(warn);
      }
    }
    if (devices.length > 1 && indexes.length > 0 && !indexes.some((n) => device.includes(n))) {
      const warn = `the GPU "${device}" matches none of the devices the server reports (${indexes.join(", ")})`;
      log(`  WARNING ${warn}`);
      report.problems.push(warn);
    }
  }

  // ---- step 3: the converter node ----

  /**
   * Converts every template of every model, because that is where a workflow
   * file the user wrote shows up — and it is free next to a GPU job. Returns
   * true when the converter endpoint itself is missing, which makes the rest of
   * the run pointless (the app cannot send any workflow without it).
   */
  private async checkConvert(
    usable: ComfyUiWorkflowEntry[],
    converted: Map<string, ApiWorkflow[]>,
    url: string,
    device: string,
    width: number,
    height: number,
    log: ComfyUiSelfTestLog,
    report: ComfyUiSelfTestReport,
  ): Promise<boolean> {
    for (const entry of usable) {
      if (!entry.set) continue;
      const driver = this.driverFor({ url, model: entry.model, device, width, height });
      for (const variant of COMFYUI_WORKFLOW_VARIANTS) {
        const template = entry.set[variant];
        if (!template) continue;
        const label = `${entry.model}/${variant}`;
        const started = Date.now();
        try {
          const api = await driver.convert(
            template,
            ComfyUiSelfTestService.refCountOf(variant),
            this.signal(CONVERT_TIMEOUT_MS),
          );
          const nodes = Object.keys(api ?? {}).length;
          if (nodes === 0) {
            const why = "the converter node answered with an empty workflow";
            log(`  FAILED  ${label} — ${why} (the template is not a ComfyUI graph)`);
            report.problems.push(`${label}: ${why}`);
            continue;
          }
          converted.set(entry.model, [...(converted.get(entry.model) ?? []), api]);
          log(
            `  ok      ${label} — ${nodes} nodes in ${ComfyUiSelfTestService.seconds(Date.now() - started)} s` +
              `${ComfyUiSelfTestService.placeholderSummary(api)}`,
          );
        } catch (err) {
          const text = ComfyUiSelfTestService.errorText(err);
          const fatal = ComfyUiSelfTestService.isConverterMissing(text)
            ? 'the server has no POST /workflow/convert endpoint, so install the custom node ' +
              '"comfyui-workflow-to-api-converter-endpoint" on it — the app sends its workflows in the ' +
              "UI format and the server turns them into the API format"
            : this.serverWasAlive && ComfyUiSelfTestService.isConnectionLost(text)
              ? `the server stopped answering in the middle of this run (${text}) — its own process ended; nothing else here can be checked until it is back`
              : null;
          log(`  ${fatal ? "STOPPED" : "FAILED "} ${label} — ${text}`);
          if (!fatal) {
            report.problems.push(`${label} could not be converted: ${text}`);
            continue;
          }
          // Both of these make the rest of the run pointless: without the
          // converter the app cannot send any workflow, and a server that died
          // answers nothing. The templates are reported as never tried.
          if (fatal.startsWith("the server stopped")) {
            this.serverLost = true;
            for (const hint of ComfyUiSelfTestService.serverLostHints(entry.model)) log(`          ${hint}`);
          }
          report.problems.push(fatal);
          for (const skipped of this.templatesOf(usable)) {
            report.items.push({ ...skipped, status: "skipped", seconds: 0, hints: [], warnings: [], error: fatal });
          }
          return true;
        }
      }
    }
    return false;
  }

  /** The model/variant pairs a run would attempt — the shape of a report item. */
  private templatesOf(usable: ComfyUiWorkflowEntry[]): Array<{ model: string; variant: ComfyUiWorkflowVariant; refs: number }> {
    const pairs: Array<{ model: string; variant: ComfyUiWorkflowVariant; refs: number }> = [];
    for (const entry of usable) {
      for (const variant of COMFYUI_WORKFLOW_VARIANTS) {
        if (!entry.set?.[variant]) continue;
        pairs.push({ model: entry.model, variant, refs: ComfyUiSelfTestService.refCountOf(variant) });
      }
    }
    return pairs;
  }

  // ---- step 4: what the server can execute ----

  private async loadObjectInfo(driver: ComfyUiDriver, log: ComfyUiSelfTestLog): Promise<ComfyUiObjectInfo | null> {
    const started = Date.now();
    try {
      const info = await driver.objectInfo();
      const classes = Object.keys(info ?? {}).length;
      if (classes === 0) {
        log(`  WARNING ${driver.baseUrl} answered /object_info with nothing — the node and model checks are skipped`);
        return null;
      }
      log(`  ok      ${classes} node classes in ${ComfyUiSelfTestService.seconds(Date.now() - started)} s`);
      return info;
    } catch (err) {
      // Not fatal: an old or hardened build may not answer this. The draws are
      // the authoritative verdict, so the run goes on and says what it skipped.
      log(`  skipped — /object_info did not answer (${ComfyUiSelfTestService.errorText(err)})`);
      log(`          the node and model-file checks are skipped, the generation below is tried anyway`);
      return null;
    }
  }

  /**
   * Compares one model's converted workflows with what the server has: every
   * node class must be one it can run, and every value it offers a choice for (a
   * checkpoint, a LoRA, a sampler) must be one it actually has. Both stay
   * warnings rather than verdicts — the draw that follows is the verdict — but
   * they name the cause while it is still free.
   */
  private async checkWorkflowNodes(
    entry: ComfyUiWorkflowEntry,
    apis: ApiWorkflow[],
    driver: ComfyUiDriver,
    info: ComfyUiObjectInfo,
    log: ComfyUiSelfTestLog,
    report: ComfyUiSelfTestReport,
  ): Promise<void> {
    const lines: string[] = [];
    const seen = new Set<string>();
    const missingClasses = new Set<string>();
    const addLine = (line: string): void => {
      if (seen.has(line)) return; // the three templates of a model share their nodes
      seen.add(line);
      lines.push(line);
    };
    for (const api of apis) {
      for (const node of Object.values(api)) {
        const classType = node?.class_type;
        if (!classType) continue;
        if (!info[classType]) missingClasses.add(classType);
        for (const [name, value] of Object.entries(ComfyUiSelfTestService.inputValuesOf(node))) {
          const problem = ComfyUiSelfTestService.comboProblem(classType, name, value, info[classType]);
          if (problem) addLine(problem);
        }
      }
    }
    for (const classType of missingClasses) {
      // Asked about on its own before it is called missing: a node the listing
      // does not show can be one the server loads lazily, and a false alarm in a
      // diagnostic costs more than the request it saves.
      if (await driver.hasNodeClass(classType)) continue;
      addLine(`the server has no node class "${classType}" — a custom node of this workflow is not installed`);
    }
    if (lines.length === 0) {
      log(`  ok      ${entry.model} — every node and every model file its workflows need is on the server`);
      return;
    }
    log(`  WARNING ${entry.model}`);
    for (const line of lines) {
      log(`          ${line}`);
      report.problems.push(`${entry.model}: ${line}`);
    }
    log(`          these are warnings about what the workflows ask for — the draw below is the real answer`);
  }

  /** A value the server cannot accept, or null when this input is fine. */
  private static comboProblem(
    classType: string,
    input: string,
    value: unknown,
    node: ComfyUiNodeClass | undefined,
  ): string | null {
    // A PARAM_* placeholder is the app's own token: the value it stands for
    // exists only when the job runs (an uploaded reference name, a size), so no
    // list of the server's could contain it and comparing would invent a problem.
    if (typeof value !== "string" || value.startsWith("PARAM_")) return null;
    const spec = node?.input?.required?.[input] ?? node?.input?.optional?.[input];
    const options = comboOptionsOf(spec);
    if (!options || options.includes(value)) return null;
    if (options.length === 0) {
      return `${classType}.${input} loads "${value}" and the server has no name for that input at all — its model folder of that type is empty`;
    }
    const shown = options.slice(0, 5).join(", ") + (options.length > 5 ? `, and ${options.length} in total` : "");
    return `${classType}.${input} loads "${value}", which the server does not have (it has: ${shown})`;
  }

  // ---- step 5: the generations ----

  private async drawOne(
    entry: ComfyUiWorkflowEntry,
    variant: ComfyUiWorkflowVariant,
    refs: string[],
    prompt: string,
    outDir: string,
    device: string,
    width: number,
    height: number,
    log: ComfyUiSelfTestLog,
    report: ComfyUiSelfTestReport,
  ): Promise<void> {
    const label = `${entry.model}/${variant}`;
    const item: ComfyUiSelfTestItem = {
      model: entry.model,
      variant,
      refs: refs.length,
      status: "skipped",
      seconds: 0,
      hints: [],
      warnings: [],
    };
    report.items.push(item);
    if (this.cancelled) {
      item.error = "the run was cancelled before this template";
      log(`  skip    ${label} — the run was cancelled`);
      return;
    }

    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${ComfyUiSelfTestService.filePart(entry.model)}-${variant}.png`);
    item.outPath = outPath;
    log(`  ...     ${label} — ${refs.length ? `from ${refs.length} reference picture(s)` : "from text"} → ${outPath}`);

    const driver = this.driverFor({ url: report.url, model: entry.model, device, width, height });
    const started = Date.now();
    try {
      await driver.run(prompt, refs, outPath, (ctrl) => {
        this.jobCtrl = ctrl;
        // Ctrl+C while this job was still queued must not start it after all.
        if (this.cancelled) ctrl.abort();
      });
      item.seconds = (Date.now() - started) / 1000;
      const stat = fs.existsSync(outPath) ? fs.statSync(outPath) : null;
      item.bytes = stat?.size;
      const image = stat ? ComfyUiSelfTestService.imageInfoOf(outPath) : null;
      item.drawnWidth = image?.width;
      item.drawnHeight = image?.height;
      if (!stat || stat.size === 0) {
        item.status = "failed";
        item.error = "the server said the job was done and sent no picture";
        item.hints.push("look at the ComfyUI console of that server — a workflow whose SaveImage node writes nothing never reaches the app");
      } else {
        item.status = "ok";
        log(
          `  ok      ${label} — ${item.seconds.toFixed(1)} s, ${ComfyUiSelfTestService.kib(item.bytes ?? 0)} KiB` +
            (image ? `, ${image.width ?? "?"}x${image.height ?? "?"} ${image.format}` : `, ${ComfyUiSelfTestService.headOf(outPath)}`),
        );
        if (!image) {
          item.warnings.push(
            `the file is not a picture the app can recognize (${ComfyUiSelfTestService.headOf(outPath)}) — is the workflow's SaveImage node really writing an image?`,
          );
        } else if (image.width && image.width !== width) {
          item.warnings.push(
            `the picture came out ${image.width}x${image.height ?? "?"}, not the ${width}x${height} the app asked for — the workflow does not read PARAM_INT_OUTPUT_IMAGE_WIDTH/_HEIGHT`,
          );
        }
      }
    } catch (err) {
      item.seconds = (Date.now() - started) / 1000;
      const text = ComfyUiSelfTestService.errorText(err);
      // The server was answering at the start of the run and is not answering
      // now: that is the server's own process ending (a GPU abort takes ComfyUI
      // down with it, core dump and all), not a problem with this template — and
      // saying so once, loudly, is worth more than N connection errors.
      const lost = !this.cancelled && this.serverWasAlive && ComfyUiSelfTestService.isConnectionLost(text);
      if (lost && !this.serverLost) {
        this.serverLost = true;
        log(`  The server went away in the middle of this run — it answered ${report.url} at the start and does not answer now.`);
      }
      item.status = this.cancelled ? "skipped" : "failed";
      item.error = this.cancelled
        ? "the run was cancelled while this picture was being drawn"
        : lost
          ? `the server stopped answering while this job was running (${text})`
          : text;
      if (this.cancelled) {
        // nothing to advise about a run the user stopped themselves
      } else if (lost) {
        item.hints = ComfyUiSelfTestService.serverLostHints(entry.model);
      } else {
        item.hints = ComfyUiSelfTestService.drawHints(text);
      }
      log(`  ${this.cancelled ? "skip   " : "FAILED "} ${label} after ${item.seconds.toFixed(1)} s — ${item.error}`);
      for (const hint of item.hints) log(`          ${hint}`);
    } finally {
      this.jobCtrl = null;
    }

    if (item.status === "failed") {
      report.problems.push(`${label} failed: ${item.error}`);
      for (const hint of item.hints) {
        if (!report.problems.includes(hint)) report.problems.push(hint);
      }
    }
    for (const warn of item.warnings) {
      log(`          WARNING ${label}: ${warn}`);
      report.problems.push(`${label}: ${warn}`);
    }
  }

  /**
   * The two test references, written once per run. The reference templates load
   * them through POST /upload/image, so drawing them exercises the upload, the
   * LoadImage node and the edit branch of the workflow — not only the text one.
   */
  private referencePictures(outDir: string, log: ComfyUiSelfTestLog): string[] {
    fs.mkdirSync(outDir, { recursive: true });
    const files: string[] = [];
    for (const [index, name] of ["reference-a.png", "reference-b.png"].entries()) {
      const file = path.join(outDir, name);
      try {
        fs.writeFileSync(file, ComfyUiSelfTestService.testPng(REFERENCE_SIZE, index));
        files.push(file);
      } catch (err) {
        log(`  FAILED  the test reference ${file} could not be written — ${ComfyUiSelfTestService.errorText(err)}`);
      }
    }
    if (files.length) log(`  the reference pictures of the test: ${files.join(", ")}`);
    return files;
  }

  // ---- the shared pieces ----

  private driverFor(cfg: { url: string; model: string; device?: string; width?: number; height?: number }): ComfyUiDriver {
    const settings: ComfyUiSettings = {
      kind: "comfyui",
      url: cfg.url,
      model: cfg.model,
      device: cfg.device || DEFAULT_DEVICE,
      width: cfg.width ?? DEFAULT_SIZE,
      height: cfg.height ?? DEFAULT_SIZE,
      enabled: true,
    };
    return new ComfyUiDriver(settings);
  }

  /** The cancel signal of the run, shortened by a per-request timeout. */
  private signal(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    const run = this.runCtrl?.signal;
    return run ? AbortSignal.any([run, timeout]) : timeout;
  }

  private finish(report: ComfyUiSelfTestReport, started: number, log: ComfyUiSelfTestLog, drawRequested: boolean): ComfyUiSelfTestReport {
    report.seconds = (Date.now() - started) / 1000;
    const drawn = report.items.filter((i) => i.status !== "skipped");
    const failed = report.items.filter((i) => i.status === "failed");
    report.ok =
      !report.fatal &&
      failed.length === 0 &&
      report.problems.length === 0 &&
      (!drawRequested || drawn.length > 0);

    log("");
    log(`Summary — ${report.url} — ${report.seconds.toFixed(1)} s`);
    for (const item of report.items) {
      const mark = item.status === "ok" ? "ok" : item.status === "failed" ? "FAILED" : "skipped";
      const size =
        item.status === "ok" && item.drawnWidth && item.drawnHeight
          ? ` ${item.drawnWidth}x${item.drawnHeight}`
          : item.status === "ok" && item.bytes
            ? ` ${ComfyUiSelfTestService.kib(item.bytes)} KiB`
            : "";
      log(`  ${mark.padEnd(7)} ${item.model}/${item.variant}${size}${item.error ? ` — ${item.error}` : ""}`);
    }
    if (drawn.length || failed.length) log(`Draws: ${drawn.length - failed.length} ok, ${failed.length} failed.`);

    if (report.fatal) report.verdict = `the test stopped here: ${report.fatal}`;
    else if (this.serverLost)
      report.verdict =
        "the ComfyUI server's own process died during this run — the failures above are that one event, not a problem of each workflow";
    else if (failed.length) report.verdict = `${failed.length} template(s) of ${drawn.length} attempted could not be drawn`;
    else if (report.problems.length)
      report.verdict = `every picture was drawn; ${report.problems.length} thing(s) above are still worth a look`;
    else if (drawRequested) report.verdict = "nothing to fix — the server drew every template the app has";
    else report.verdict = "nothing to fix in what the checks can reach (the generation was skipped, --no-draw)";

    log("");
    if (report.ok) {
      log(`OK — ${report.verdict}.`);
      log(`The test pictures are in ${report.outDir}`);
      return report;
    }
    log(`NOT OK — ${report.verdict}.`);
    if (this.serverLost) {
      log(`The server is ${report.url} — its console or journal says why it ended; the test pictures drawn before that are in ${report.outDir}`);
    }
    if (report.problems.length) {
      log(`Problems (${report.problems.length}):`);
      report.problems.forEach((problem, index) => log(`  ${index + 1}. ${problem}`));
    }
    return report;
  }

  /** What a failed draw usually means, in the order the causes are worth checking. */
  private static drawHints(error: string): string[] {
    const hints: string[] = [];
    const lower = error.toLowerCase();
    const has = (needle: string): boolean => lower.includes(needle);
    if (ComfyUiSelfTestService.isConverterMissing(error)) {
      hints.push(
        'install the custom node "comfyui-workflow-to-api-converter-endpoint" on that server (ComfyUI Manager, or git clone it into custom_nodes and restart)',
      );
    }
    if (has("node_errors") || has("refused the workflow")) {
      hints.push(
        "open the workflow in the ComfyUI UI of that server: a red node is a custom node that is not installed, " +
          "and a model file that is missing is named by the path it was expected at",
      );
    }
    if (has("out of memory") || has("insufficient") || has("cuda error") || has("alloc")) {
      hints.push("the GPU ran out of memory — a smaller --size, another --device, or free the VRAM another process holds");
    }
    if (has("timed out")) {
      hints.push("the job is still in the queue or the model is still loading — look at the ComfyUI console and try again");
    }
    if (has("loadimage") || has("input image") || has("upload")) {
      hints.push(
        "the reference picture could not be uploaded or loaded — the server must accept POST /upload/image and read its own input/ folder",
      );
    }
    if (has("sent no picture") || has("wrote nothing") || has("no picture")) {
      hints.push("the workflow needs a SaveImage node — without it the app has nothing to download");
    }
    if (has("cancelled")) hints.push("the run was stopped; nothing is wrong with the server itself");
    return hints;
  }

  /** Why the server itself did not answer, in words the user can act on. */
  private static serverProblem(text: string, url: string): { explanation: string; hints: string[] } {
    const lower = text.toLowerCase();
    const other = `${url.startsWith("https") ? "http://" : "https://"}${url.replace(/^https?:\/\//, "")}`;
    if (lower.includes("econnrefused")) {
      return {
        explanation: `nothing listens on ${url}`,
        hints: [
          "start ComfyUI on that machine and check the port it runs on (8188 by default)",
          "ComfyUI binds 127.0.0.1 unless it is started with --listen 0.0.0.0, so a URL naming another machine cannot reach it",
        ],
      };
    }
    if (lower.includes("enotfound") || lower.includes("eai_again")) {
      return {
        explanation: `the host of ${url} does not resolve`,
        hints: ["use the machine's IP address, or a name the DNS of this machine knows"],
      };
    }
    if (lower.includes("wrong version number") || lower.includes("ssl") || lower.includes("tls")) {
      return {
        explanation: `${url} was asked over one scheme while the server answers over the other`,
        hints: [`try ${other}`],
      };
    }
    if (lower.includes("etimedout") || lower.includes("timed out") || lower.includes("timeout") || lower.includes("abort")) {
      return {
        explanation: `${url} did not answer in time`,
        hints: ["the machine may be asleep, behind a firewall, or busy loading a model — try again, then check the address"],
      };
    }
    if (lower.includes("404")) {
      return {
        explanation: `${url} answered, but it has no /system_stats, so it is not a ComfyUI server`,
        hints: ["the URL must be the ComfyUI server itself (8188 by default), not sillytalk (3210) or another service"],
      };
    }
    if (lower.includes("401") || lower.includes("403")) {
      return {
        explanation: `${url} refused the request (${lower.match(/\d\d\d/)?.[0] ?? "an http error"})`,
        hints: ["the server is behind an auth proxy — the app sends no credentials, so it must be reachable without one"],
      };
    }
    return {
      explanation: `${url} is not reachable as a ComfyUI server`,
      hints: ["check the address (http://host:8188) and that the server is running"],
    };
  }

  private static isConverterMissing(text: string): boolean {
    return text.includes("comfyui-workflow-to-api-converter-endpoint") || /\/workflow\/convert returned 404/.test(text);
  }

  /**
   * Whether the server stopped being reachable, as opposed to refusing a
   * request: the codes of a socket that was closed, reset or never accepted, and
   * the bare "fetch failed" the driver's message carries them in. Only worth
   * asking after the server has already answered once — the same codes at the
   * start of a run mean the plain "it is not there", which is another question
   * with another answer (see serverProblem).
   */
  private static isConnectionLost(text: string): boolean {
    return /econnreset|econnrefused|econnaborted|epipe|ehostunreach|enethostunreach|socket hang up|fetch failed/i.test(
      text,
    );
  }

  /** What to do when the server's own process died in the middle of the run. */
  private static serverLostHints(model: string): string[] {
    return [
      "look at the server's own output — journalctl -u <its service>, or the terminal it was started in: an 'Aborted (core dumped)' or a bare exit is ComfyUI itself crashing, usually inside the GPU code of the node that was running",
      `run it for one workflow (--model ${model}) and, if it dies again, with a smaller --size: a workflow the GPU cannot hold can take the server down instead of answering "out of memory"`,
      "the job the app was waiting for died with it, so this picture is lost — and the templates after it were not tried, because the server was gone",
    ];
  }

  /**
   * A server address as the user typed it: a trailing slash is not part of it,
   * a bare host:port is a plain-http server, and anything the URL parser cannot
   * read is not an address at all (null, so the CLI can say so before a run
   * starts). A path is kept — a ComfyUI behind a reverse proxy can live under
   * one.
   */
  static urlOf(raw: string): string | null {
    const typed = (raw ?? "").trim();
    if (!typed) return null;
    // A trailing slash is not part of an address, and a bare scheme ("http://")
    // is not an address either — dropping its slash first would otherwise turn
    // it into something a URL parser happily reads as a host name.
    const withoutSlash = typed.replace(/\/+$/, "");
    if (!withoutSlash || /^[a-z][a-z0-9+.-]*:$/i.test(withoutSlash)) return null;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutSlash) ? withoutSlash : `http://${withoutSlash}`;
    try {
      return new URL(url).hostname ? url : null;
    } catch {
      return null;
    }
  }

  /** The run's own address, normalized the same way the CLI validated it. */
  private static normalizeUrl(raw: string): string {
    return ComfyUiSelfTestService.urlOf(raw) ?? (raw ?? "").trim();
  }

  private static refCountOf(variant: ComfyUiWorkflowVariant): number {
    return variant === "text" ? 0 : variant === "oneImage" ? 1 : 2;
  }

  /** The two workflow folders, for the header line of the run. */
  private static dirLabel(): string {
    return `the app's own folder and ${PathHelper.comfyWorkflowsDir()}`;
  }

  private static filePart(model: string): string {
    return model.replace(/[^\w.+-]+/g, "_").slice(0, 60);
  }

  /** The inputs of a converted node that carry a value of their own (not a link). */
  private static inputValuesOf(node: ApiNode): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node?.inputs ?? {})) {
      if (Array.isArray(value)) continue; // a link to another node's output
      out[name] = value;
    }
    return out;
  }

  /** Which PARAM_* placeholders the converted workflow still carries (the app fills them per run). */
  private static placeholderSummary(api: ApiWorkflow): string {
    const found = [...new Set([...JSON.stringify(api).matchAll(/PARAM_[A-Z0-9_]+/g)].map((m) => m[0]))].sort();
    return found.length ? `, placeholders ${found.join(" ")}` : ", no PARAM_* placeholder (the app fills nothing)";
  }

  private static errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private static brief(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return (text ?? "").slice(0, 160);
  }

  /** The first bytes of a file, as hex — what a server sent instead of a picture. */
  private static headOf(file: string): string {
    try {
      return Buffer.from(fs.readFileSync(file).subarray(0, 12))
        .toString("hex")
        .replace(/(..)/g, "$1 ")
        .trim();
    } catch {
      return "unreadable";
    }
  }

  private static seconds(ms: number): string {
    return (ms / 1000).toFixed(1);
  }

  private static mib(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(0);
  }

  private static kib(bytes: number): string {
    return (bytes / 1024).toFixed(0);
  }

  // ---- the picture the reference templates are drawn from ----
  //
  // A real PNG written here rather than a fixture shipped in the package: the
  // run must work from an installed app with no data folder, and a picture the
  // server can actually decode is the point — the reference templates fail on a
  // bad upload long before anything else does. The pattern is deliberately
  // obvious (two halves and a disc) so a reference that really reached the
  // workflow is visible in the result.

  private static testPng(size: number, variant: number): Buffer {
    const radius = size / 4;
    const rows: Buffer[] = [];
    for (let y = 0; y < size; y++) {
      const row = Buffer.alloc(1 + size * 3); // one filter byte, then RGB
      for (let x = 0; x < size; x++) {
        const dx = x - size / 2;
        const dy = y - size / 2;
        const i = 1 + x * 3;
        if (dx * dx + dy * dy < radius * radius) {
          row[i] = 220;
          row[i + 1] = 40;
          row[i + 2] = 40;
        } else if (x < size / 2) {
          row[i] = 20;
          row[i + 1] = Math.floor((60 + (y * 120) / size + variant * 30) % 256);
          row[i + 2] = 200;
        } else {
          row[i] = 235;
          row[i + 1] = 200 - Math.floor((y * 120) / size);
          row[i + 2] = 40 + variant * 60;
        }
      }
      rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // truecolour RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ComfyUiSelfTestService.pngChunk("IHDR", header),
      ComfyUiSelfTestService.pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
      ComfyUiSelfTestService.pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  private static pngChunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(ComfyUiSelfTestService.crc32(body), 4 + body.length);
    return out;
  }

  private static crcTable?: Int32Array;

  private static crc32(buf: Buffer): number {
    if (!ComfyUiSelfTestService.crcTable) {
      const table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
      ComfyUiSelfTestService.crcTable = table;
    }
    const table = ComfyUiSelfTestService.crcTable;
    let crc = -1;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  // ---- what the drawn file really is ----

  /**
   * The format and the pixel size a picture file says it has, read off its own
   * header. Worth having: a workflow that ignores the size placeholders, and a
   * server that answers a download with an error page, both look like a success
   * until the file is opened. Null for a format this reader does not know.
   */
  static imageInfoOf(file: string): { format: string; width?: number; height?: number } | null {
    let head: Buffer;
    try {
      const fd = fs.openSync(file, "r");
      try {
        head = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
      return { format: "PNG", width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      const jpeg = ComfyUiSelfTestService.jpegSize(head);
      return jpeg ? { format: "JPEG", ...jpeg } : { format: "JPEG" };
    }
    if (head.length >= 10 && head.subarray(0, 3).toString("ascii") === "GIF") {
      return { format: "GIF", width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }
    if (
      head.length >= 30 &&
      head.subarray(0, 4).toString("ascii") === "RIFF" &&
      head.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      const chunk = head.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") {
        return { format: "WEBP", width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
      }
      if (chunk === "VP8 ") {
        return { format: "WEBP", width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      }
      return { format: "WEBP" };
    }
    if (head.length >= 26 && head.subarray(0, 2).toString("ascii") === "BM") {
      return { format: "BMP", width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) };
    }
    return null;
  }

  /** The frame size of a JPEG, taken from its first start-of-frame marker. */
  private static jpegSize(head: Buffer): { width: number; height: number } | null {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = head[i + 1];
      // The standalone markers carry no length; everything else is one segment.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { width: head.readUInt16BE(i + 7), height: head.readUInt16BE(i + 5) };
      if (marker === 0xda) break; // the scan data: whatever follows is pixels, not a header
      i += 2 + head.readUInt16BE(i + 2);
    }
    return null;
  }
}
