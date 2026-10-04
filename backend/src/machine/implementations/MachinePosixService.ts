import { ChildProcess, spawn } from "child_process";
import { IMachineService, programFailureMessage } from "../IMachineService";

// The POSIX (Linux/macOS) implementation: programs run directly (no shell
// wrappers) in their own process group, so a kill reaches everything they
// spawned. .bat/.cmd scripts are a Windows format and are refused up front.
export class MachinePosixService implements IMachineService {
  commandLine(command: string, args: string[]): string {
    // Display only (error messages): the plain invocation, args quoted.
    const cmd = command.trim().replace(/^"+|"+$/g, "");
    return [cmd, ...args.map((arg) => `"${arg}"`)].join(" ");
  }

  runProgram(
    command: string,
    args: string[],
    registerChild: (child: ChildProcess) => void = () => undefined,
  ): Promise<void> {
    const line = this.commandLine(command, args);
    const cmd = command.trim().replace(/^"+|"+$/g, "");
    if (/\.(bat|cmd)$/i.test(cmd)) {
      return Promise.reject(
        new Error(`A .bat/.cmd generator program is only supported on Windows\nCommand line: ${line}`),
      );
    }
    return new Promise((resolve, reject) => {
      // detached: the program leads its own process group. A cancel then
      // kills the whole group (killTree), so an orphaned grandchild (e.g. a
      // `sleep` forked by a shell script) cannot keep the stdout/stderr
      // pipes open and stall the job (and the whole generation queue).
      const child = spawn(cmd, args, { detached: true });
      registerChild(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) =>
        reject(new Error(`Failed to start the program: ${err.message}\nCommand line: ${line}`)),
      );
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(programFailureMessage(code, line, stdout, stderr)));
      });
    });
  }

  killTree(child: ChildProcess): void {
    // Not started yet (spawn failed) or already exited — nothing to kill.
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    // Kill the whole process group (the program was spawned detached).
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}
