import { ChildProcess } from 'child_process';
import { PosixMachineService } from './machine-posix';
import { WindowsMachineService } from './machine-win32';

// The OS-specific machine operations used by the local image generation: how
// a generator program is LAUNCHED (shell wrappers, process groups, windows
// options) and how it is KILLED (together with everything it spawned). One
// implementation per platform, selected once at startup (initMachineService).
export interface MachineService {
  // The command line as shown to a human (error messages) — the exact
  // invocation, wrappers included.
  commandLine(command: string, args: string[]): string;
  // Launches the program, capturing stdout/stderr. Resolves when it exits
  // with code 0, rejects with a detailed message otherwise. registerChild is
  // called with the spawned process so a caller can kill it (killTree); omit
  // it when the run does not need to be cancellable.
  runProgram(
    command: string,
    args: string[],
    registerChild?: (child: ChildProcess) => void,
  ): Promise<void>;
  // Kills the process tree rooted at the child (the program AND its
  // children). Best-effort: a child that never started or already exited is
  // a no-op.
  killTree(child: ChildProcess): void;
}

// Shared, platform-neutral failure message: exit code, the full command line
// and the entire output (stderr and stdout) with no truncation, not just
// "code N".
export function programFailureMessage(
  code: number | null,
  line: string,
  stdout: string,
  stderr: string,
): string {
  const parts = [
    `The program exited with code ${code === null ? 'no code' : code}`,
    `Command line: ${line}`,
  ];
  const errOut = stderr.trim();
  const out = stdout.trim();
  if (errOut || out) {
    const chunks: string[] = [];
    if (errOut) chunks.push(`stderr:\n${errOut}`);
    if (out) chunks.push(`stdout:\n${out}`);
    parts.push(`Program output:\n${chunks.join('\n\n')}`);
  } else {
    parts.push('Program output: (empty)');
  }
  return parts.join('\n');
}

let machineService: MachineService | undefined;

// Selects the implementation for the current platform (process.platform; the
// architecture does not change any behavior) and caches it. Called at
// startup in index.ts; getMachineService falls back to it lazily.
export function initMachineService(): MachineService {
  machineService ??=
    process.platform === 'win32' ? new WindowsMachineService() : new PosixMachineService();
  return machineService;
}

export function getMachineService(): MachineService {
  return machineService ?? initMachineService();
}
