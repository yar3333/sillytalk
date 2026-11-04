import fs from "fs";
import os from "os";
import path from "path";
import { PathHelper } from "../shared/PathHelper";
import { ImageMetaFile } from "../shared/ImageMetaFile";
import { ImageGenerationRecord } from "../shared/ImageMeta";
import { createMachineService } from "../machine/IMachineService";
import { TextGenerationService } from "../text_generation/TextGenerationService";
import { ImageGenerationService } from "./ImageGenerationService";
import { ImageGenerator } from "../configuration/ImageGenerator";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Config } from "../configuration/Config";
import { ImageJobResult } from "./ImageJobResult";

// Isolate the data root: an image id is a path relative to it and only the ids
// inside it are accepted, so the folders used below must not be the real
// ~/.config/sillytalk (the accessors read the env on every call).
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sillytalk-images-"));
process.env.SILLYTALK_DATA_DIR = dataRoot;

// The config is stubbed: a job whose driver cache is empty re-probes it, and
// the tests must not depend on the real config.json contents.
class EmptyConfigurationService extends ConfigurationService {
  loadConfig(): Config {
    return { listen: "127.0.0.1:3210", llmModels: {}, imageGenerators: [] };
  }
}

// One service instance for the whole suite — the state (the availability
// cache and the job registry) lives on the instance, and the tests recompute
// the availability via refreshAvailableGenerators as needed. The service is
// chat-agnostic: a job is given an image id and settles a result.
const configuration = new EmptyConfigurationService();
const images = new ImageGenerationService(createMachineService(), new TextGenerationService(configuration), configuration);

// The id of a picture of a chat — the way a message and the API address it: a
// path relative to the data folder, with "/" separators.
function imageId(chatId: string, name: string): string {
  return PathHelper.imageIdOf(path.join(PathHelper.chatFilesDir(chatId), name));
}
// The absolute path an id addresses (the file the generator has to write).
function imageFile(chatId: string, name: string): string {
  return path.join(PathHelper.chatFilesDir(chatId), name);
}

// A one-shot generation through the production path: a background job for a
// single generator (the reserved id is given by the test). Resolves to the job
// result.
async function oneShot(
  gen: ImageGenerator,
  prompt: string,
  refs: string[],
  name: string,
  chatId = chatIdDefault,
): Promise<ImageJobResult> {
  await images.refreshAvailableGenerators([gen]);
  const job = images.startImageJob({ id: imageId(chatId, name), prompt, refs, chatId });
  return job.result;
}

const chatIdDefault = "jest-local-cmd-test";
const cmdFile = path.join(os.tmpdir(), "sillytalk-gen-test.cmd");
const ps1File = path.join(os.tmpdir(), "sillytalk-gen-test.ps1");
const failFile = path.join(os.tmpdir(), "sillytalk-gen-test-fail.cmd");

const cmdGen: ImageGenerator = {
  command: cmdFile,
  args: ["--prompt", "{prompt}", "--input", "{absolutePathsToInputImages}", "--output", "{absolutePathToOutputImage}"],
  maxInputImages: 0,
};

const ps1Gen: ImageGenerator = {
  command: ps1File,
  args: [
    "-Prompt",
    "{prompt}",
    "-InputImagePath",
    "{absolutePathsToInputImages}",
    "-OutputImagePath",
    "{absolutePathToOutputImage}",
  ],
  maxInputImages: 0,
};

// The batch file writes the prompt (%2) and the reference paths (%4) into the
// output file (%6) — that way the test sees the arguments arrived at the
// right places. A fake ps1 does the same via param() — it checks the launch
// branch through powershell.exe -File.
beforeAll(() => {
  fs.writeFileSync(cmdFile, '@echo off\r\n> "%~6" echo %~2\r\n>> "%~6" echo %~4\r\n');
  fs.writeFileSync(
    ps1File,
    "param([string]$Prompt,[string]$InputImagePath,[string]$OutputImagePath)\r\n" +
      "Set-Content -Path $OutputImagePath -Value @($Prompt, $InputImagePath)\r\n",
  );
  // A batch file that "fails": writes to stdout and stderr and exits with
  // code 3 — we check that all of it lands in the error message.
  fs.writeFileSync(
    failFile,
    "@echo off\r\necho stdout line from failing script\r\necho stderr line from failing script 1>&2\r\nexit /b 3\r\n",
  );
  // The job refuses to run for a deleted chat — the chat dir must exist.
  fs.rmSync(PathHelper.chatDir(chatIdDefault), { recursive: true, force: true });
  fs.mkdirSync(PathHelper.chatDir(chatIdDefault), { recursive: true });
});

afterAll(() => {
  fs.rmSync(PathHelper.chatDir(chatIdDefault), { recursive: true, force: true });
  fs.rmSync(cmdFile, { force: true });
  fs.rmSync(ps1File, { force: true });
  fs.rmSync(failFile, { force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// The .cmd/.ps1 launch tests run the platform machine service for real, so
// they only pass on Windows: the POSIX service refuses .bat/.cmd by design
// and powershell.exe is not available there.
const describeWindows = process.platform === "win32" ? describe : describe.skip;
describeWindows(".cmd/.ps1 generator launch (Windows only)", () => {
  it("runs a .cmd and substitutes the prompt and the absolute output path", async () => {
    const r = await oneShot(cmdGen, "hello world test", [], "one-cmd.png");
    expect(r.status).toBe("ok");
    const file = imageFile(chatIdDefault, "one-cmd.png");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("hello world test");
  });

  it("passes absolute reference paths to the batch file", async () => {
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    const refPath = imageFile(chatIdDefault, "ref.png");
    fs.writeFileSync(refPath, "x");
    const r = await oneShot(cmdGen, "hello", [imageId(chatIdDefault, "ref.png")], "one-cmd-ref.png");
    expect(r.status).toBe("ok");
    const content = fs.readFileSync(imageFile(chatIdDefault, "one-cmd-ref.png"), "utf-8");
    expect(content).toContain(refPath);
  });

  it("runs a .ps1 through powershell.exe and substitutes the arguments", async () => {
    const r = await oneShot(ps1Gen, "ps prompt test", [], "one-ps1.png");
    expect(r.status).toBe("ok");
    const file = imageFile(chatIdDefault, "one-ps1.png");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("ps prompt test");
  });

  it("passes comma-joined references to the ps1", async () => {
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    const refPath = imageFile(chatIdDefault, "ref.png");
    fs.writeFileSync(refPath, "x");
    const r = await oneShot(ps1Gen, "hello", [imageId(chatIdDefault, "ref.png")], "one-ps1-ref.png");
    expect(r.status).toBe("ok");
    const content = fs.readFileSync(imageFile(chatIdDefault, "one-ps1-ref.png"), "utf-8");
    expect(content).toContain(refPath);
  });

  it("the launch error carries the code, the full command line and the whole program output", async () => {
    const gen: ImageGenerator = {
      command: failFile,
      args: ["--prompt", "{prompt}", "--output", "{absolutePathToOutputImage}"],
      maxInputImages: 0,
    };
    const r = await oneShot(gen, "fail test", [], "one-fail.png");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      const msg = r.error;
      expect(msg).toContain("exited with code 3");
      // the full command line — with the cmd.exe wrapper and the file itself
      expect(msg).toContain("cmd.exe /d /s /c");
      expect(msg).toContain(failFile);
      // and the whole program output: both stderr and stdout
      expect(msg).toContain("stderr line from failing script");
      expect(msg).toContain("stdout line from failing script");
    }
  });

  it("an unlimited generator (maxInputImages 0) accepts all references", async () => {
    fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
    const refs: string[] = [];
    for (const n of ["a.png", "b.png", "c.png"]) {
      fs.writeFileSync(imageFile(chatIdDefault, n), "x");
      refs.push(imageId(chatIdDefault, n));
    }
    // 0 = unlimited: three references pass through (the batch file receives them)
    const r = await oneShot(cmdGen, "hello", refs, "one-unlimited.png");
    expect(r.status).toBe("ok");
  });
});

it("rejects more references than the generator supports", async () => {
  // chatFilesDir (not chatDir): the refs are written into files/, and
  // recursive:true also creates the chat dir the job checks for. On POSIX
  // the Windows-only tests that used to create files/ are skipped.
  fs.mkdirSync(PathHelper.chatFilesDir(chatIdDefault), { recursive: true });
  const refs: string[] = [];
  for (const n of ["a.png", "b.png", "c.png"]) {
    fs.writeFileSync(imageFile(chatIdDefault, n), "x");
    refs.push(imageId(chatIdDefault, n));
  }
  const limited: ImageGenerator = { ...ps1Gen, maxInputImages: 2 };
  const r = await oneShot(limited, "hello", refs, "limited.png");
  expect(r.status).toBe("failed");
  if (r.status === "failed") expect(r.error).toMatch(/at most 2/);
});

it("does not generate without an available generator", async () => {
  await images.refreshAvailableGenerators([]);
  const job = images.startImageJob({ id: imageId(chatIdDefault, "nogen.png"), prompt: "hello", refs: [] });
  const r = await job.result;
  expect(r.status).toBe("failed");
  if (r.status === "failed") expect(r.error).toMatch(/not configured/);
});

// ---- local generator availability (a missing script file is filtered out) ----
// These only probe the driver's availability (file existence), so they are
// cross-platform and do not launch anything.
describe("local generator availability", () => {
  const existing = path.join(
    os.tmpdir(),
    `sillytalk-avail-existing-${process.pid}.${process.platform === "win32" ? "cmd" : "sh"}`,
  );
  const gen = (command: string): ImageGenerator => ({ command, args: [], maxInputImages: 0 });

  beforeAll(() => fs.writeFileSync(existing, "x"));
  afterAll(() => fs.rmSync(existing, { force: true }));

  it("is unavailable for an empty command", async () => {
    await images.refreshAvailableGenerators([gen("")]);
    expect(images.hasAvailableGenerator()).toBe(false);
  });

  it("keeps a generator whose absolute script exists", async () => {
    await images.refreshAvailableGenerators([gen(existing)]);
    expect(images.hasAvailableGenerator()).toBe(true);
  });

  it("filters out an absolute path to a missing script", async () => {
    const missing = path.join(os.tmpdir(), "sillytalk-no-such-script.py");
    fs.rmSync(missing, { force: true });
    await images.refreshAvailableGenerators([gen(missing)]);
    expect(images.hasAvailableGenerator()).toBe(false);
  });

  it("filters out a quoted absolute path to a missing script", async () => {
    const missing = path.join(os.tmpdir(), "sillytalk-no-such-quoted.cmd");
    fs.rmSync(missing, { force: true });
    await images.refreshAvailableGenerators([gen(`"${missing}"`)]);
    expect(images.hasAvailableGenerator()).toBe(false);
  });

  it("filters out a relative path to a missing script", async () => {
    await images.refreshAvailableGenerators([gen("missing-dir/no-such-script.py")]);
    expect(images.hasAvailableGenerator()).toBe(false);
  });

  it("keeps a relative path to an existing script", async () => {
    const rel = path.join(".", `sillytalk-avail-rel-${process.pid}.py`);
    fs.writeFileSync(rel, "x");
    try {
      await images.refreshAvailableGenerators([gen(rel)]);
      expect(images.hasAvailableGenerator()).toBe(true);
    } finally {
      fs.rmSync(rel, { force: true });
    }
  });

  it("keeps a bare program name (resolved through PATH)", async () => {
    await images.refreshAvailableGenerators([gen("python")]);
    expect(images.hasAvailableGenerator()).toBe(true);
  });
});

// ---- background image jobs (startImageJob) ----
// The job writes to a script (a shell script on Linux/macOS, a .cmd on
// Windows) so the tests are cross-platform. The script receives the reserved
// output path as its first argument.
describe("startImageJob (background generation)", () => {
  const jobChatId = "jest-image-job-test";
  const scriptExt = process.platform === "win32" ? ".cmd" : ".sh";
  const okFile = path.join(os.tmpdir(), `sillytalk-job-ok${scriptExt}`);
  const slowFile = path.join(os.tmpdir(), `sillytalk-job-slow${scriptExt}`);
  const failFile = path.join(os.tmpdir(), `sillytalk-job-fail${scriptExt}`);
  // Two identical scripts in different files: the generator key is the
  // command, so these are two DIFFERENT generators (two queues).
  const logFileA = path.join(os.tmpdir(), `sillytalk-job-logA${scriptExt}`);
  const logFileB = path.join(os.tmpdir(), `sillytalk-job-logB${scriptExt}`);
  const echoRefsFile = path.join(os.tmpdir(), `sillytalk-job-refs${scriptExt}`);

  const genOf = (file: string, withOutputArg = true, extra: { enabled?: boolean } = {}): ImageGenerator => ({
    command: file,
    args: withOutputArg ? ["{absolutePathToOutputImage}"] : [],
    maxInputImages: 0,
    ...extra,
  });

  // A generator whose prompt carries a shared log path (arg 1): the script
  // logs "start"/"end" there, so a test can see whether two runs overlapped
  // (parallel generators) or ran one behind the other (one queue).
  const logGen = (file: string): ImageGenerator => ({
    command: file,
    args: ["{prompt}", "{absolutePathToOutputImage}"],
    maxInputImages: 0,
  });

  // A generator that writes the reference list (arg 1) into the output file
  // (arg 2) — that is how a test sees which references survived the resolve.
  const echoRefsGen = (file: string): ImageGenerator => ({
    command: file,
    args: ["{absolutePathsToInputImages}", "{absolutePathToOutputImage}"],
    maxInputImages: 0,
  });

  // Starts a job for a picture of this describe's chat and waits for its
  // result — the shape most of the tests below need.
  async function runJob(
    name: string,
    opts: { prompt?: string; refs?: string[]; meta?: ImageGenerationRecord } = {},
  ): Promise<ImageJobResult> {
    const job = images.startImageJob({
      id: imageId(jobChatId, name),
      prompt: opts.prompt ?? "p",
      refs: opts.refs ?? [],
      chatId: jobChatId,
      meta: opts.meta,
    });
    return job.result;
  }

  beforeAll(() => {
    if (process.platform === "win32") {
      fs.writeFileSync(okFile, '@echo off\r\necho job ok > "%~1"\r\n');
      fs.writeFileSync(slowFile, '@echo off\r\nping -n 30 127.0.0.1 >nul\r\necho job ok > "%~1"\r\n');
      fs.writeFileSync(failFile, "@echo off\r\necho fail line from the job 1>&2\r\nexit /b 2\r\n");
      for (const f of [logFileA, logFileB]) {
        fs.writeFileSync(
          f,
          '@echo off\r\necho start >> "%~1"\r\nping -n 3 127.0.0.1 >nul\r\necho end >> "%~1"\r\necho job ok > "%~2"\r\n',
        );
      }
      fs.writeFileSync(echoRefsFile, '@echo off\r\necho refs %~1 > "%~2"\r\n');
    } else {
      fs.writeFileSync(okFile, '#!/bin/sh\necho job ok > "$1"\n');
      fs.writeFileSync(slowFile, '#!/bin/sh\nsleep 30\necho job ok > "$1"\n');
      fs.writeFileSync(failFile, "#!/bin/sh\necho fail line from the job >&2\nexit 2\n");
      for (const f of [okFile, slowFile, failFile]) fs.chmodSync(f, 0o755);
      for (const f of [logFileA, logFileB]) {
        fs.writeFileSync(f, '#!/bin/sh\necho start >> "$1"\nsleep 2\necho end >> "$1"\necho job ok > "$2"\n');
        fs.chmodSync(f, 0o755);
      }
      fs.writeFileSync(echoRefsFile, '#!/bin/sh\necho "refs $1" > "$2"\n');
      fs.chmodSync(echoRefsFile, 0o755);
    }
    // The job refuses to run for a deleted chat — the chat dir must exist.
    fs.rmSync(PathHelper.chatDir(jobChatId), { recursive: true, force: true });
    fs.mkdirSync(PathHelper.chatDir(jobChatId), { recursive: true });
  });

  afterAll(async () => {
    await images.refreshAvailableGenerators([]);
    fs.rmSync(PathHelper.chatDir(jobChatId), { recursive: true, force: true });
    for (const f of [okFile, slowFile, failFile, logFileA, logFileB, echoRefsFile]) fs.rmSync(f, { force: true });
  });

  it("writes the image to the reserved name and records its story in the sidecar", async () => {
    await images.refreshAvailableGenerators([genOf(okFile)]);
    const id = imageId(jobChatId, "job-ready.png");
    const job = images.startImageJob({
      id,
      prompt: "a red boat at dusk",
      refs: [],
      chatId: jobChatId,
      meta: { prompt: "a red boat at dusk", source: "auto", model: "m1", width: 512, height: 512, steps: 20 },
    });
    const r = await job.result;
    expect(r.status).toBe("ok");
    const file = path.join(PathHelper.chatFilesDir(jobChatId), "job-ready.png");
    expect(fs.readFileSync(file, "utf-8")).toContain("job ok");
    // the picture carries its own generation data next to itself, ready to be
    // read by hand or reused; the file is the canonical "<image>.png.json"
    const sidecar = ImageMetaFile.read(file);
    expect(sidecar).toMatchObject({
      prompt: "a red boat at dusk",
      source: "auto",
      model: "m1",
      width: 512,
      height: 512,
      steps: 20,
    });
    expect(sidecar?.generator).toBeTruthy();
    // the job is off the registry once it settled
    expect(images.getCurrentJob(id)).toBeUndefined();
  });

  it("a description the user wrote while the job ran survives the sidecar write", async () => {
    await images.refreshAvailableGenerators([genOf(okFile)]);
    const file = imageFile(jobChatId, "job-caption.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ImageMetaFile.write(file, { description: "what the user says it shows" });
    const r = await runJob("job-caption.png", { prompt: "a red boat", meta: { prompt: "a red boat", source: "manual" } });
    expect(r.status).toBe("ok");
    expect(ImageMetaFile.read(file)).toMatchObject({
      description: "what the user says it shows",
      prompt: "a red boat",
    });
  });

  it("only the references that are really pictures of the data folder reach the generator", async () => {
    await images.refreshAvailableGenerators([echoRefsGen(echoRefsFile)]);
    fs.mkdirSync(PathHelper.chatFilesDir(jobChatId), { recursive: true });
    const real = imageFile(jobChatId, "a-real-reference.png");
    fs.writeFileSync(real, "x");
    const name = "job-refs.png";
    const r = await runJob(name, {
      refs: [imageId(jobChatId, "a-real-reference.png"), "/etc/passwd", `${jobChatId}/files/gone.png`, "../out.png"],
    });
    expect(r.status).toBe("ok");
    const content = fs.readFileSync(imageFile(jobChatId, name), "utf-8");
    expect(content).toContain(real);
    expect(content).not.toContain("/etc/passwd");
    expect(content).not.toContain("gone.png");
    expect(content).not.toContain("out.png");
  });

  it("refuses an id that points outside the data folders", async () => {
    await images.refreshAvailableGenerators([genOf(okFile)]);
    const job = images.startImageJob({ id: "../../escaped.png", prompt: "p", refs: [] });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/Unknown image id/);
    expect(fs.existsSync(path.join(PathHelper.configDir(), "..", "escaped.png"))).toBe(false);
  });

  it('a failed program resolves to "failed" with the program error, no file left', async () => {
    await images.refreshAvailableGenerators([genOf(failFile, false)]);
    const name = "job-fail.png";
    const job = images.startImageJob({ id: imageId(jobChatId, name), prompt: "p", refs: [], chatId: jobChatId });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.hadOld).toBe(false);
      expect(r.error).toContain("exited with code 2");
      expect(r.error).toContain("fail line from the job");
    }
    expect(fs.existsSync(imageFile(jobChatId, name))).toBe(false);
  });

  it("a failed run leaves the sidecar of the old picture alone", async () => {
    await images.refreshAvailableGenerators([genOf(failFile, false)]);
    const name = "job-fail-sidecar.png";
    const file = imageFile(jobChatId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old image");
    ImageMetaFile.write(file, { description: "the old scene", prompt: "the old prompt" });
    const job = images.startImageJob({ id: imageId(jobChatId, name), prompt: "p", refs: [], chatId: jobChatId });
    const r = await job.result;
    expect(r.status).toBe("failed");
    expect(fs.readFileSync(file, "utf-8")).toBe("old image");
    expect(ImageMetaFile.read(file)).toMatchObject({ description: "the old scene", prompt: "the old prompt" });
  });

  it('a cancel stops the run and resolves to "cancelled", no file left', async () => {
    await images.refreshAvailableGenerators([genOf(slowFile)]);
    const name = "job-cancel.png";
    const id = imageId(jobChatId, name);
    const job = images.startImageJob({ id, prompt: "p", refs: [], chatId: jobChatId });
    expect(images.getCurrentJob(id)).toBe(job);
    setTimeout(() => job.cancel(), 500);
    const r = await job.result;
    expect(r.status).toBe("cancelled");
    if (r.status === "cancelled") expect(r.hadOld).toBe(false);
    expect(fs.existsSync(imageFile(jobChatId, name))).toBe(false);
  });

  it("cancelJob stops the job of an image by its id", async () => {
    await images.refreshAvailableGenerators([genOf(slowFile)]);
    const id = imageId(jobChatId, "job-cancel-by-id.png");
    images.startImageJob({ id, prompt: "p", refs: [], chatId: jobChatId });
    setTimeout(() => images.cancelJob(id), 500);
    // the same job is found again by the id alone — the registry is keyed by it
    expect(images.getCurrentJob(id)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(images.getCurrentJob(id)).toBeUndefined();
    expect(images.cancelJob(id)).toBe(false);
  });

  it("cancelAllJobs cancels a running job (the server-shutdown path)", async () => {
    await images.refreshAvailableGenerators([genOf(slowFile)]);
    const name = "job-shutdown.png";
    const job = images.startImageJob({ id: imageId(jobChatId, name), prompt: "p", refs: [], chatId: jobChatId });
    setTimeout(() => images.cancelAllJobs(), 500);
    // The run would otherwise take 30s; the shutdown cancel must settle it
    // promptly, which also proves the whole process group is killed (the
    // "close" event fires only once every pipe holder is gone).
    const r = await job.result;
    expect(r.status).toBe("cancelled");
    expect(fs.existsSync(imageFile(jobChatId, name))).toBe(false);
  });

  it("a failed regeneration keeps the older image (hadOld)", async () => {
    await images.refreshAvailableGenerators([genOf(failFile, false)]);
    const name = "job-keepold.png";
    const file = imageFile(jobChatId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old image");
    const job = images.startImageJob({ id: imageId(jobChatId, name), prompt: "p", refs: [], chatId: jobChatId });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.hadOld).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("old image");
  });

  it("a job whose chat was deleted while it waited does not recreate it", async () => {
    await images.refreshAvailableGenerators([genOf(okFile)]);
    const goneChat = "jest-image-gone-chat";
    fs.mkdirSync(PathHelper.chatDir(goneChat), { recursive: true });
    const id = imageId(goneChat, "orphan.png");
    const job = images.startImageJob({ id, prompt: "p", refs: [], chatId: goneChat });
    fs.rmSync(PathHelper.chatDir(goneChat), { recursive: true, force: true });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/chat was deleted/);
    expect(fs.existsSync(PathHelper.chatDir(goneChat))).toBe(false);
  });

  it("enabled defaults to true: a generator without the field is available", async () => {
    await images.refreshAvailableGenerators([genOf(okFile)]);
    expect(images.hasAvailableGenerator()).toBe(true);
  });

  it("skips a disabled generator (enabled: false)", async () => {
    const disabled = genOf(okFile, false, { enabled: false });
    await images.refreshAvailableGenerators([disabled]);
    expect(images.hasAvailableGenerator()).toBe(false);
    const job = images.startImageJob({
      id: imageId(jobChatId, "job-disabled.png"),
      prompt: "p",
      refs: [],
      chatId: jobChatId,
    });
    const r = await job.result;
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/not configured/);
  });

  it("runs the jobs in parallel on different generators", async () => {
    await images.refreshAvailableGenerators([logGen(logFileA), logGen(logFileB)]);
    const log = path.join(os.tmpdir(), `sillytalk-job-parallel-${process.pid}.log`);
    fs.writeFileSync(log, "");
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      images.startImageJob({ id: imageId(jobChatId, "par-1.png"), prompt: log, refs: [], chatId: jobChatId }).result,
      images.startImageJob({ id: imageId(jobChatId, "par-2.png"), prompt: log, refs: [], chatId: jobChatId }).result,
    ]);
    const totalMs = Date.now() - t0;
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    // cmd's echo appends a trailing space on redirect — trim the lines.
    const lines = fs
      .readFileSync(log, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim());
    // Both runs started before either one finished — a real overlap: if the
    // jobs had been queued one behind the other, the first "end" would come
    // before the second "start".
    expect(lines[0]).toBe("start");
    expect(lines[1]).toBe("start");
    // Two ~2s runs side by side take ~2s, not ~4s.
    expect(totalMs).toBeLessThan(4000);
    fs.rmSync(log, { force: true });
  }, 30000);

  it("queues the jobs of one generator (one run at a time, in order)", async () => {
    await images.refreshAvailableGenerators([logGen(logFileA)]);
    const log = path.join(os.tmpdir(), `sillytalk-job-queue-${process.pid}.log`);
    fs.writeFileSync(log, "");
    const [r1, r2] = await Promise.all([
      images.startImageJob({ id: imageId(jobChatId, "q-1.png"), prompt: log, refs: [], chatId: jobChatId }).result,
      images.startImageJob({ id: imageId(jobChatId, "q-2.png"), prompt: log, refs: [], chatId: jobChatId }).result,
    ]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    const lines = fs
      .readFileSync(log, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim());
    // One run at a time: the first run finished before the second started.
    expect(lines).toEqual(["start", "end", "start", "end"]);
    fs.rmSync(log, { force: true });
  }, 30000);
});
