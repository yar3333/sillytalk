import fs from "fs";
import { ChildProcess } from "child_process";
import { LocalProgramSettings } from "../../configuration/LocalProgramSettings";
import { PathHelper } from "../../shared/PathHelper";
import { IMachineService } from "../../machine/IMachineService";
import { IImageGeneratorDriver } from "../IImageGeneratorDriver";

// The local-program backend: the configured program writes the PNG itself
// (the output path is substituted into {absolutePathToOutputImage}); the
// backend only checks that the file appeared. The OS-specific launch/kill
// lives in the MachineService (injected).
export class LocalProgramDriver implements IImageGeneratorDriver {
  readonly key: string;

  constructor(
    private readonly cfg: LocalProgramSettings,
    private readonly machine: IMachineService,
  ) {
    this.key = `cmd:${PathHelper.expandPath(cfg.command ?? "")}`;
  }

  // Available if a command is set; and, when the command names a script or
  // executable FILE (an absolute path, a relative path, or a bare name with a
  // script/executable extension), that file must actually exist — a generator
  // pointed at a missing script is filtered out here, before it is ever
  // selected. A bare program name (e.g. `python`, resolved through PATH by the
  // OS) cannot be narrowed to a file, so it stays available.
  available(): Promise<boolean> {
    const cmd = LocalProgramDriver.programPath(this.cfg.command);
    if (!cmd) return Promise.resolve(false);
    if (LocalProgramDriver.namesAFile(cmd)) {
      return Promise.resolve(fs.existsSync(cmd));
    }
    return Promise.resolve(true);
  }

  // The path the machine service would actually launch: surrounding quotes
  // are stripped (runProgram does the same before spawning) and `~`/`~/` are
  // expanded — so the existence check matches what gets spawned.
  private static programPath(command: string | null | undefined): string {
    const unquoted = (command ?? "").trim().replace(/^"+|"+$/g, "").trim();
    return PathHelper.expandPath(unquoted);
  }

  private static namesAFile(cmd: string): boolean {
    // An absolute path (Windows drive, UNC, or POSIX root) always names a file.
    if (/^[a-zA-Z]:[\\/]/.test(cmd) || cmd.startsWith("\\\\") || cmd.startsWith("/")) return true;
    // A relative path with a separator, or a name with a script/executable
    // extension, also names a file (e.g. `scripts\\gen.py`, `gen.cmd`).
    return /[\\/]/.test(cmd) || /\.(bat|cmd|ps1|py|exe|com|sh|pl|cgi)$/i.test(cmd);
  }

  async run(
    prompt: string,
    refPaths: string[],
    outPath: string,
    registerChild?: (child: ChildProcess) => void,
    _registerAbort?: (ctrl: AbortController) => void,
  ): Promise<void> {
    if (this.cfg.maxInputImages > 0 && refPaths.length > this.cfg.maxInputImages) {
      throw new Error(
        `The generator supports at most ${this.cfg.maxInputImages} reference images (${refPaths.length} provided)`,
      );
    }
    if (!this.cfg.command) throw new Error("The local generator program command is not set");
    // A single program run; the backend places the output file itself —
    // the tool must write the PNG by absolute path.
    // {prompt} — the prompt text; {absolutePathsToInputImages} — comma-joined
    // absolute reference paths (empty when there are none);
    // {absolutePathToOutputImage} — the absolute output file path.
    const args = this.cfg.args.map((arg) =>
      arg
        .replaceAll("{prompt}", prompt)
        .replaceAll("{absolutePathsToInputImages}", refPaths.join(","))
        .replaceAll("{absolutePathToOutputImage}", outPath),
    );
    const command = PathHelper.expandPath(this.cfg.command);
    await this.machine.runProgram(command, args, registerChild);
    if (!fs.existsSync(outPath)) {
      throw new Error(
        `The program did not create the file ${outPath}\nCommand line: ${this.machine.commandLine(command, args)}`,
      );
    }
  }
}
