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

test-comfyui <url> checks the server and every workflow the app can draw with —
the ones it ships and the ones in <data root>/comfyui — and draws one real
picture per template (text, 1 reference, 2 references), reporting each step: the
server and its GPUs, the workflow files, the converter node, the node classes and
model files the server actually has, then the jobs and the errors behind them.
Nothing of the app's config is read or changed, and the only files written are
the test pictures.

  --model <name>      only this workflow (repeatable)
  --size <WxH>        the size of the test pictures (default 1024x1024)
  --device <gpu>      the GPU the workflow pins its loaders to (default cuda:0)
  --prompt <text>     the prompt of the test pictures
  --out <dir>         where the test pictures go (default <data root>/comfyui-test)
  --no-refs           draw the text template only
  --no-draw           run the checks and draw nothing

Exit code: 0 clean, 1 something failed or needs a look, 2 a bad command line.
Data folder: ${PathHelper.configDir()} (SILLYTALK_DATA_DIR moves it elsewhere).`;

// A parsed command line, or the reason the one that was typed is not one.
export type ParsedCommand =
  | { command: "help" }
  | { command: "test-comfyui"; url: string; options: ComfyUiSelfTestOptions }
  | { error: string };

const FLAGS_WITH_VALUE = new Set(["--model", "--size", "--device", "--prompt", "--out"]);
const SWITCHES = new Set(["--no-refs", "--no-draw"]);

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
    else if (flag === "--device") options.device = value;
    else if (flag === "--prompt") options.prompt = value;
    else if (flag === "--out") options.outDir = value;
    else {
      const match = /^(\d+)\s*[x*]\s*(\d+)$/i.exec(value.trim());
      if (!match) {
        return { error: `--size wants a size like 1024x1024, got "${value}"` };
      }
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width < 64 || height < 64 || width > 8192 || height > 8192) {
        return { error: `--size ${value} is outside what a generator takes (64..8192 on a side)` };
      }
      options.width = width;
      options.height = height;
    }
  }
  if (models.length) options.models = models;
  return { command: "test-comfyui", url, options };
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
    if (report.ok && report.workflows.some((entry) => entry.set)) {
      log("");
      log(
        `To draw with this server in the app: Settings → Image generation → + ComfyUI, ` +
          `URL ${report.url}, and the model name of a workflow that worked.`,
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
