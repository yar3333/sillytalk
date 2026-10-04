import { ChildProcess, spawn } from 'child_process';
import { MachineService, programFailureMessage } from './machine';

// Escapes an argument for the Windows command line (quotes, trailing backslashes).
export function escapeCmdArg(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// The Windows implementation: .bat/.cmd cannot be spawned directly (Node
// throws EINVAL) and run through cmd.exe; .ps1 runs through powershell.exe
// -File; plain executables spawn directly. Killing a tree needs taskkill,
// because child.kill() is a TerminateProcess on the direct child only.
export class WindowsMachineService implements MachineService {
  commandLine(command: string, args: string[]): string {
    const cmd = command.trim().replace(/^"+|"+$/g, '');
    if (/\.(bat|cmd)$/i.test(cmd)) {
      return `cmd.exe /d /s /c "${[escapeCmdArg(cmd), ...args.map(escapeCmdArg)].join(' ')}"`;
    }
    if (/\.ps1$/i.test(cmd)) {
      return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${cmd} ${args
        .map(escapeCmdArg)
        .join(' ')}`;
    }
    return [cmd, ...args.map(escapeCmdArg)].join(' ');
  }

  runProgram(
    command: string,
    args: string[],
    registerChild: (child: ChildProcess) => void = () => undefined,
  ): Promise<void> {
    const line = this.commandLine(command, args);
    return new Promise((resolve, reject) => {
      const cmd = command.trim().replace(/^"+|"+$/g, '');
      const isCmdScript = /\.(bat|cmd)$/i.test(cmd);
      const isPsScript = /\.ps1$/i.test(cmd);
      // .bat/.cmd: the whole line is wrapped in quotes, and /s removes the
      // outer pair, leaving each argument a separate quoted token. .ps1:
      // arguments go as individual argv elements, without a shell and
      // without interpretation.
      const child = isCmdScript
        ? spawn(
            'cmd.exe',
            ['/d', '/s', '/c', `"${[escapeCmdArg(cmd), ...args.map(escapeCmdArg)].join(' ')}"`],
            { windowsHide: true, windowsVerbatimArguments: true },
          )
        : isPsScript
          ? spawn('powershell.exe', [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              cmd,
              ...args,
            ], {
              windowsHide: true,
            })
          : spawn(cmd, args, { windowsHide: true });
      registerChild(child);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (err) =>
        reject(new Error(`Failed to start the program: ${err.message}\nCommand line: ${line}`)),
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(programFailureMessage(code, line, stdout, stderr)));
      });
    });
  }

  killTree(child: ChildProcess): void {
    // Not started yet (spawn failed) or already exited — nothing to kill.
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    // taskkill /F /T kills the whole process tree — the cmd.exe /
    // powershell.exe wrapper AND the real generator behind it. The direct
    // child must stay ALIVE until taskkill has walked the tree: killing it
    // first removes the tree root and taskkill then cannot find the
    // grandchildren — they survive holding the inherited stdio pipes, so the
    // "close" event (and the job) never settles.
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    killer.unref();
    killer.on('close', (code) => {
      if (code === 0) return; // the tree is gone; "close" fires on its own
      // Fallback (the tree walk failed): terminate the direct child at least.
      try {
        child.kill();
      } catch {
        // already gone
      }
    });
  }
}
