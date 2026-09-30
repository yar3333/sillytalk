import fs from 'fs';
import os from 'os';
import path from 'path';
import { chatDir, chatFilesDir } from './config';
import { cancelAllJobs, generateImages, refreshActiveGenerator, startImageJob } from './imagegen';
import { ImageGenerator } from './types';

const chatId = 'jest-local-cmd-test';
const cmdFile = path.join(os.tmpdir(), 'sillytalk-gen-test.cmd');
const ps1File = path.join(os.tmpdir(), 'sillytalk-gen-test.ps1');
const failFile = path.join(os.tmpdir(), 'sillytalk-gen-test-fail.cmd');

const cmdGen: ImageGenerator = {
  command: cmdFile,
  args: [
    '--prompt',
    '{prompt}',
    '--input',
    '{absolutePathsToInputImages}',
    '--output',
    '{absolutePathToOutputImage}',
  ],
  maxInputImages: 0,
};

const ps1Gen: ImageGenerator = {
  command: ps1File,
  args: [
    '-Prompt',
    '{prompt}',
    '-InputImagePath',
    '{absolutePathsToInputImages}',
    '-OutputImagePath',
    '{absolutePathToOutputImage}',
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
    'param([string]$Prompt,[string]$InputImagePath,[string]$OutputImagePath)\r\n' +
      'Set-Content -Path $OutputImagePath -Value @($Prompt, $InputImagePath)\r\n',
  );
  // A batch file that "fails": writes to stdout and stderr and exits with
  // code 3 — we check that all of it lands in the error message.
  fs.writeFileSync(
    failFile,
    '@echo off\r\necho stdout line from failing script\r\necho stderr line from failing script 1>&2\r\nexit /b 3\r\n',
  );
  fs.rmSync(chatFilesDir(chatId), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(chatFilesDir(chatId), { recursive: true, force: true });
  fs.rmSync(cmdFile, { force: true });
  fs.rmSync(ps1File, { force: true });
  fs.rmSync(failFile, { force: true });
});

it('runs a .cmd and substitutes the prompt and the absolute output path', async () => {
  const names = await generateImages([cmdGen], chatId, 'hello world test', []);
  expect(names).toHaveLength(1);
  const file = path.join(chatFilesDir(chatId), names[0]);
  expect(fs.existsSync(file)).toBe(true);
  const content = fs.readFileSync(file, 'utf-8');
  expect(content).toContain('hello world test');
});

it('passes absolute reference paths to the batch file', async () => {
  fs.mkdirSync(chatFilesDir(chatId), { recursive: true });
  const refPath = path.join(chatFilesDir(chatId), 'ref.png');
  fs.writeFileSync(refPath, 'x');
  const names = await generateImages([cmdGen], chatId, 'hello', ['ref.png']);
  const file = path.join(chatFilesDir(chatId), names[0]);
  const content = fs.readFileSync(file, 'utf-8');
  expect(content).toContain(refPath);
});

it('runs a .ps1 through powershell.exe and substitutes the arguments', async () => {
  const names = await generateImages([ps1Gen], chatId, 'ps prompt test', []);
  expect(names).toHaveLength(1);
  const file = path.join(chatFilesDir(chatId), names[0]);
  expect(fs.existsSync(file)).toBe(true);
  const content = fs.readFileSync(file, 'utf-8');
  expect(content).toContain('ps prompt test');
});

it('passes comma-joined references to the ps1', async () => {
  fs.mkdirSync(chatFilesDir(chatId), { recursive: true });
  const refPath = path.join(chatFilesDir(chatId), 'ref.png');
  fs.writeFileSync(refPath, 'x');
  const names = await generateImages([ps1Gen], chatId, 'hello', ['ref.png']);
  const file = path.join(chatFilesDir(chatId), names[0]);
  const content = fs.readFileSync(file, 'utf-8');
  expect(content).toContain(refPath);
});

it('the launch error carries the code, the full command line and the whole program output', async () => {
  const gen: ImageGenerator = {
    command: failFile,
    args: ['--prompt', '{prompt}', '--output', '{absolutePathToOutputImage}'],
    maxInputImages: 0,
  };
  let err: Error | null = null;
  try {
    await generateImages([gen], chatId, 'fail test', []);
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  const msg = err!.message;
  expect(msg).toContain('exited with code 3');
  // the full command line — with the cmd.exe wrapper and the file itself
  expect(msg).toContain('cmd.exe /d /s /c');
  expect(msg).toContain(failFile);
  // and the whole program output: both stderr and stdout
  expect(msg).toContain('stderr line from failing script');
  expect(msg).toContain('stdout line from failing script');
});

it('rejects more references than the generator supports', async () => {
  fs.mkdirSync(chatFilesDir(chatId), { recursive: true });
  for (const n of ['a.png', 'b.png', 'c.png']) {
    fs.writeFileSync(path.join(chatFilesDir(chatId), n), 'x');
  }
  const limited: ImageGenerator = { ...ps1Gen, maxInputImages: 2 };
  await expect(
    generateImages([limited], chatId, 'hello', ['a.png', 'b.png', 'c.png']),
  ).rejects.toThrow(/at most 2/);
  // 0 = unlimited: three references pass through (the batch file receives them)
  await generateImages([cmdGen], chatId, 'hello', ['a.png', 'b.png', 'c.png']);
});

it('does not generate without an available generator', async () => {
  await refreshActiveGenerator([]);
  await expect(generateImages([], chatId, 'hello', [])).rejects.toThrow(/not configured/);
});

// ---- background image jobs (startImageJob) ----
// The job writes to a script (a shell script on Linux/macOS, a .cmd on
// Windows) so the tests are cross-platform. The script receives the reserved
// output path as its first argument.
describe('startImageJob (background generation)', () => {
  const jobChatId = 'jest-image-job-test';
  const scriptExt = process.platform === 'win32' ? '.cmd' : '.sh';
  const okFile = path.join(os.tmpdir(), `sillytalk-job-ok${scriptExt}`);
  const slowFile = path.join(os.tmpdir(), `sillytalk-job-slow${scriptExt}`);
  const failFile = path.join(os.tmpdir(), `sillytalk-job-fail${scriptExt}`);

  const genOf = (file: string, withOutputArg = true): ImageGenerator => ({
    command: file,
    args: withOutputArg ? ['{absolutePathToOutputImage}'] : [],
    maxInputImages: 0,
  });

  beforeAll(() => {
    if (process.platform === 'win32') {
      fs.writeFileSync(okFile, '@echo off\r\necho job ok > "%~1"\r\n');
      fs.writeFileSync(slowFile, '@echo off\r\nping -n 30 127.0.0.1 >nul\r\necho job ok > "%~1"\r\n');
      fs.writeFileSync(failFile, '@echo off\r\necho fail line from the job 1>&2\r\nexit /b 2\r\n');
    } else {
      fs.writeFileSync(okFile, '#!/bin/sh\necho job ok > "$1"\n');
      fs.writeFileSync(slowFile, '#!/bin/sh\nsleep 30\necho job ok > "$1"\n');
      fs.writeFileSync(failFile, '#!/bin/sh\necho fail line from the job >&2\nexit 2\n');
      for (const f of [okFile, slowFile, failFile]) fs.chmodSync(f, 0o755);
    }
    // The job refuses to run for a deleted chat — the chat dir must exist.
    fs.rmSync(chatDir(jobChatId), { recursive: true, force: true });
    fs.mkdirSync(chatDir(jobChatId), { recursive: true });
  });

  afterAll(async () => {
    await refreshActiveGenerator([]);
    fs.rmSync(chatDir(jobChatId), { recursive: true, force: true });
    for (const f of [okFile, slowFile, failFile]) fs.rmSync(f, { force: true });
  });

  it('writes the image to the reserved file name', async () => {
    await refreshActiveGenerator([genOf(okFile)]);
    const name = 'job-ready.png';
    const job = startImageJob({ chatId: jobChatId, name, prompt: 'p', refFilenames: [] });
    const r = await job.result;
    expect(r.status).toBe('ok');
    const file = path.join(chatFilesDir(jobChatId), name);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('job ok');
  });

  it('a failed program resolves to "failed" with the program error, no file left', async () => {
    await refreshActiveGenerator([genOf(failFile, false)]);
    const name = 'job-fail.png';
    const job = startImageJob({ chatId: jobChatId, name, prompt: 'p', refFilenames: [] });
    const r = await job.result;
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.hadOld).toBe(false);
      expect(r.error).toContain('exited with code 2');
      expect(r.error).toContain('fail line from the job');
    }
    expect(fs.existsSync(path.join(chatFilesDir(jobChatId), name))).toBe(false);
  });

  it('a cancel stops the run and resolves to "cancelled", no file left', async () => {
    await refreshActiveGenerator([genOf(slowFile)]);
    const name = 'job-cancel.png';
    const job = startImageJob({ chatId: jobChatId, name, prompt: 'p', refFilenames: [] });
    setTimeout(() => job.cancel(), 500);
    const r = await job.result;
    expect(r.status).toBe('cancelled');
    if (r.status === 'cancelled') expect(r.hadOld).toBe(false);
    expect(fs.existsSync(path.join(chatFilesDir(jobChatId), name))).toBe(false);
  });

  it('cancelAllJobs cancels a running job (the server-shutdown path)', async () => {
    await refreshActiveGenerator([genOf(slowFile)]);
    const name = 'job-shutdown.png';
    const job = startImageJob({ chatId: jobChatId, name, prompt: 'p', refFilenames: [] });
    setTimeout(() => cancelAllJobs(), 500);
    // The run would otherwise take 30s; the shutdown cancel must settle it
    // promptly, which also proves the whole process group is killed (the
    // "close" event fires only once every pipe holder is gone).
    const r = await job.result;
    expect(r.status).toBe('cancelled');
    expect(fs.existsSync(path.join(chatFilesDir(jobChatId), name))).toBe(false);
  });

  it('a failed regeneration keeps the older image (hadOld)', async () => {
    await refreshActiveGenerator([genOf(failFile, false)]);
    const name = 'job-keepold.png';
    const file = path.join(chatFilesDir(jobChatId), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old image');
    const job = startImageJob({ chatId: jobChatId, name, prompt: 'p', refFilenames: [] });
    const r = await job.result;
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.hadOld).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('old image');
  });
});
