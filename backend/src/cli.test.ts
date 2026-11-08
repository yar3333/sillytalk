import {
  ComfyUiSelfTestLog,
  ComfyUiSelfTestOptions,
  ComfyUiSelfTestReport,
  ComfyUiSelfTestService,
} from "./image_generation/comfyui/ComfyUiSelfTestService";
import { parseArgs, run } from "./cli";

// The CLI is a parsing-and-printing layer, so that is what is tested here: what
// a command line means, what a wrong one answers, and which exit code a run
// ends with. The test of the run itself is in the self-test service's suite;
// this one hands the CLI a stand-in for it.

function reportOf(over: Partial<ComfyUiSelfTestReport> = {}): ComfyUiSelfTestReport {
  return {
    ok: true,
    url: "http://127.0.0.1:8188",
    outDir: "/tmp/comfyui-test",
    seconds: 1,
    verdict: "nothing to fix",
    workflows: [{ model: "m", file: "/w/m.json", source: "app", set: { text: {} } }],
    items: [],
    problems: [],
    ...over,
  };
}

class StubSelfTest extends ComfyUiSelfTestService {
  seen: ComfyUiSelfTestOptions | null = null;
  cancelPressed = false;

  constructor(private readonly report: ComfyUiSelfTestReport) {
    super();
  }

  override async run(options: ComfyUiSelfTestOptions, _log: ComfyUiSelfTestLog): Promise<ComfyUiSelfTestReport> {
    this.seen = options;
    return this.report;
  }

  override cancel(): void {
    this.cancelPressed = true;
  }
}

describe("parseArgs", () => {
  it("asks for help when there is nothing to do", () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"], ["test-comfyui", "--help"]]) {
      expect(parseArgs(argv)).toEqual({ command: "help" });
    }
  });

  it("refuses a command the program does not have", () => {
    const parsed = parseArgs(["install"]);
    expect("error" in parsed && parsed.error).toMatch(/Unknown command: install/);
  });

  it("wants the server address and accepts the shapes one comes in", () => {
    expect("error" in parseArgs(["test-comfyui"])).toBe(true);
    expect(parseArgs(["test-comfyui", "http://127.0.0.1:8188/"])).toMatchObject({
      url: "http://127.0.0.1:8188",
    });
    expect(parseArgs(["test-comfyui", "192.168.0.5:8188"])).toMatchObject({ url: "http://192.168.0.5:8188" });
    expect(parseArgs(["test-comfyui", "https://example.com/comfy"])).toMatchObject({
      url: "https://example.com/comfy",
    });
    expect("error" in parseArgs(["test-comfyui", "http://"])).toBe(true);
  });

  it("reads its options", () => {
    const parsed = parseArgs([
      "test-comfyui",
      "127.0.0.1:8188",
      "--model",
      "qwen-image-2.1",
      "--model",
      "my-flux",
      "--size",
      "768x512",
      "--device",
      "cuda:1",
      "--prompt",
      "a blue house",
      "--out",
      "/tmp/pics",
      "--no-refs",
      "--no-draw",
    ]);
    expect(parsed).toMatchObject({
      command: "test-comfyui",
      options: {
        url: "http://127.0.0.1:8188",
        models: ["qwen-image-2.1", "my-flux"],
        width: 768,
        height: 512,
        device: "cuda:1",
        prompt: "a blue house",
        outDir: "/tmp/pics",
        withRefs: false,
        draw: false,
      },
    });
  });

  it("answers a bad option instead of guessing what it meant", () => {
    expect("error" in parseArgs(["test-comfyui", "u", "--modelz", "x"])).toBe(true);
    expect("error" in parseArgs(["test-comfyui", "u", "--model"])).toBe(true);
    expect("error" in parseArgs(["test-comfyui", "u", "--size", "big"])).toBe(true);
    expect("error" in parseArgs(["test-comfyui", "u", "--size", "32x32"])).toBe(true);
  });
});

describe("ComfyUiSelfTestService.urlOf", () => {
  it("normalizes an address and rejects what is not one", () => {
    expect(ComfyUiSelfTestService.urlOf("http://host:8188///")).toBe("http://host:8188");
    expect(ComfyUiSelfTestService.urlOf(" host ")).toBe("http://host");
    expect(ComfyUiSelfTestService.urlOf("")).toBeNull();
    expect(ComfyUiSelfTestService.urlOf("http://")).toBeNull();
    expect(ComfyUiSelfTestService.urlOf("http://a b")).toBeNull();
  });
});

describe("run", () => {
  async function collect(argv: string[], service: StubSelfTest) {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await run(argv, {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      selfTest: service,
    });
    return { code, lines, errors, service };
  }

  it("prints the usage for help and exits 0", async () => {
    const { code, lines } = await collect(["help"], new StubSelfTest(reportOf()));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/test-comfyui <url>/);
  });

  it("ends 2 with the reason when the command line is wrong", async () => {
    const { code, errors, service } = await collect(["nope"], new StubSelfTest(reportOf()));
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/Unknown command/);
    expect(service.seen).toBeNull();
  });

  it("ends 0 when the run was clean and says how to use the server afterwards", async () => {
    const { code, lines } = await collect(["test-comfyui", "http://127.0.0.1:8188"], new StubSelfTest(reportOf()));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Settings → Image generation → \+ ComfyUI/);
  });

  it("ends 1 when something failed, and does not advertise the server", async () => {
    const stub = new StubSelfTest(reportOf({ ok: false, verdict: "2 templates failed", problems: ["a"] }));
    const { code, lines } = await collect(["test-comfyui", "http://127.0.0.1:8188"], stub);
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toMatch(/Settings →/);
    expect(stub.seen).toMatchObject({ url: "http://127.0.0.1:8188" });
  });

  // Ctrl+C is the only way a run that draws for minutes can be stopped, and the
  // point of wiring it is that the server is told to drop the job — so the
  // cancel has to reach the service, not just end the process.
  it("asks the run to stop when the user presses Ctrl+C", async () => {
    const listenersBefore = process.listenerCount("SIGINT");
    const stub = new HangingSelfTest();
    const running = run(["test-comfyui", "http://127.0.0.1:8188"], {
      log: () => undefined,
      error: () => undefined,
      selfTest: stub,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.cancelPressed).toBe(false);

    process.emit("SIGINT");

    expect(stub.cancelPressed).toBe(true);
    expect(await running).toBe(0);
    // the listener must not outlive the command it was installed for
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });
});

/** A run that goes on until it is cancelled — the shape of a real generation. */
class HangingSelfTest extends ComfyUiSelfTestService {
  cancelPressed = false;
  private gate: Promise<void>;
  private release!: () => void;

  constructor() {
    super();
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  override async run(_options: ComfyUiSelfTestOptions, _log: ComfyUiSelfTestLog): Promise<ComfyUiSelfTestReport> {
    await this.gate;
    return reportOf();
  }

  override cancel(): void {
    this.cancelPressed = true;
    this.release();
  }
}
