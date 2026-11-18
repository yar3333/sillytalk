import { ComfyUiLora, ComfyUiOrientation } from "./configuration/ComfyUiSettings";
import { ComfyUiSelfTestOptions, ComfyUiSelfTestService } from "./image_generation/comfyui/ComfyUiSelfTestService";
import { PathHelper } from "./shared/PathHelper";

// The command line of the app. The published bin keeps `sillytalk` with no
// argument running the server, so this module is what everything else is: at
// the moment the one command that needs a terminal rather than a browser, the
// ComfyUI self-test.
//
// Like the routes, the CLI is a thin layer: it parses what the user typed,
// hands the run to a domain service, and prints what comes back. No state of
// its own, no container — a command that needed the chats or the images
// database would resolve them here, in the one place that is allowed to.

const USAGE = `sillytalk — a web chat with AI characters (the API and the frontend on one port)

  sillytalk                        run the app in the foreground
  sillytalk test-comfyui <url>     test a ComfyUI server from end to end
  sillytalk help                   this text

test-comfyui <url> checks a ComfyUI server the app can draw through: that it is
up and what hardware it has, that the comfyui-sillytalk plugin is installed on
it and what that plugin offers, and then one real picture per model and per
reference count, each verified on disk afterwards. The server chooses the GPUs
itself, so nothing here names one. Nothing of the app's config is read or
changed, and the only files written are the test pictures.

  --model <code>        only this model of the server's catalogue (repeatable)
  --orientation <o>     square | portrait | landscape (default: the model's own)
  --model-file <name>   a file of the server's models/diffusion_models/ to draw
                        with instead of the workflow's own
  --lora <name[@s]>     a file of the server's models/loras/ to merge, with an
                        optional strength (repeatable, applied in this order)
  --prompt <text>       the prompt of the test pictures
  --out <dir>           where the test pictures go (default <data root>/comfyui-test)
  --no-refs             draw without reference images only
  --no-draw             run the checks and draw nothing

Exit code: 0 clean, 1 something failed or needs a look, 2 a bad command line.
Data folder: ${PathHelper.configDir()} (SILLYTALK_DATA_DIR moves it elsewhere).`;

// A parsed command line, or the reason the one that was typed is not one.
export type ParsedCommand =
  | { command: "help" }
  | { command: "test-comfyui"; url: string; options: ComfyUiSelfTestOptions }
  | { error: string };

const FLAGS_WITH_VALUE = new Set(["--model", "--orientation", "--model-file", "--lora", "--prompt", "--out"]);
const SWITCHES = new Set(["--no-refs", "--no-draw"]);
const ORIENTATIONS: readonly string[] = ["square", "portrait", "landscape"];

export function parseArgs(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (!command || command === "help" || argv.includes("--help") || argv.includes("-h")) return { command: "help" };
  if (command !== "test-comfyui") {
    return { error: `Unknown command: ${command}\n\nRun "sillytalk help" for what this program does.` };
  }

  const urlArg = rest.find((part) => !part.startsWith("-"));
  if (!urlArg) {
    return {
      error:
        `test-comfyui needs the URL of the ComfyUI server, for example:\n` +
        `  sillytalk test-comfyui http://127.0.0.1:8188`,
    };
  }
  const url = ComfyUiSelfTestService.urlOf(urlArg);
  if (!url) {
    return { error: `"${urlArg}" is not a server address — try http://127.0.0.1:8188 (a bare host:port is fine too)` };
  }

  const options: ComfyUiSelfTestOptions = { url };
  const models: string[] = [];
  const loras: ComfyUiLora[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === urlArg) continue;
    if (SWITCHES.has(flag)) {
      if (flag === "--no-refs") options.withRefs = false;
      else options.draw = false;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) {
      return { error: `Unknown option for test-comfyui: ${flag}\n\nRun "sillytalk test-comfyui --help" for the list.` };
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} needs a value` };
    }
    i++;
    if (flag === "--model") models.push(value);
    else if (flag === "--prompt") options.prompt = value;
    else if (flag === "--out") options.outDir = value;
    else if (flag === "--model-file") options.modelFile = value.trim();
    else if (flag === "--lora") loras.push(loraOf(value));
    else {
      const orientation = value.trim().toLowerCase();
      if (!ORIENTATIONS.includes(orientation)) {
        return { error: `--orientation wants one of ${ORIENTATIONS.join(" | ")}, got "${value}"` };
      }
      options.orientation = orientation as ComfyUiOrientation;
    }
  }
  if (models.length) options.models = models;
  if (loras.length) options.loras = loras;
  return { command: "test-comfyui", url, options };
}

// `style.safetensors@0.7` is that LoRA at 70 %. A name with no `@`, or one whose
// tail is not a number, is the whole file name — a file genuinely called
// `x@2.safetensors` has to stay typeable.
function loraOf(value: string): ComfyUiLora {
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const strength = Number(value.slice(at + 1));
    if (Number.isFinite(strength)) return { name: value.slice(0, at), strength };
  }
  return { name: value };
}

// The seams of a test: where the run writes, and the service it runs against.
export interface CliOverrides {
  log?: (line: string) => void;
  error?: (line: string) => void;
  selfTest?: ComfyUiSelfTestService;
}

/** Runs one command line and returns the process exit code. */
export async function run(argv: string[], overrides: CliOverrides = {}): Promise<number> {
  const log = overrides.log ?? ((line: string) => console.log(line));
  const error = overrides.error ?? ((line: string) => console.error(line));

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    error(parsed.error);
    return 2;
  }
  if (parsed.command === "help") {
    log(USAGE);
    return 0;
  }

  const test = overrides.selfTest ?? new ComfyUiSelfTestService();
  // Ctrl+C has to mean "stop this run", not "leave a generation on the server":
  // the service aborts the job and the server is told to drop it. A second one
  // ends the process where it stands.
  let cancelPressed = false;
  const onSigint = (): void => {
    if (cancelPressed) {
      error("");
      error("Ending now — a job that was already sent stays on the ComfyUI server; check its queue.");
      process.exit(130);
    }
    cancelPressed = true;
    log("");
    log("Stopping the run — the current job is cancelled on the server (Ctrl+C again ends it at once)");
    test.cancel();
  };
  process.on("SIGINT", onSigint);

  try {
    const report = await test.run(parsed.options, log);
    log("");
    log(report.summary);
    for (const problem of report.problems) log(`  ! ${problem}`);
    if (report.ok && report.models.length) {
      log("");
      log(
        `To draw with this server in the app: Settings → Image generation → + ComfyUI, ` +
          `URL ${report.url}, and one of its models: ${report.models.map((m) => m.code).join(", ")}.`,
      );
    }
    return report.ok ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/** Entry point of the published `sillytalk` bin (and of `node backend/dist/cli.js`). */
export function main(argv: string[] = process.argv.slice(2)): void {
  run(argv)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

// So that `node backend/dist/cli.js test-comfyui …` and `ts-node src/cli.ts …`
// do something instead of loading the module and sitting in silence.
if (require.main === module) main();
