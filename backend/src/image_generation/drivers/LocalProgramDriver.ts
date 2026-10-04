import fs from "fs";
import { ChildProcess } from "child_process";
import { LocalProgramSettings } from "../../types";
import { expandPath } from "../../config";
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
    this.key = `cmd:${expandPath(cfg.command ?? "")}`;
  }

  // Available if a command is set. If the command looks like an absolute
  // path to a file — check that the file exists.
  available(): Promise<boolean> {
    const cmd = expandPath(this.cfg.command ?? "").trim();
    if (!cmd) return Promise.resolve(false);
    if (/^[a-zA-Z]:[\\/]/.test(cmd) || cmd.startsWith("\\\\") || cmd.startsWith("/")) {
      return Promise.resolve(fs.existsSync(cmd));
    }
    return Promise.resolve(true);
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
    const command = expandPath(this.cfg.command);
    await this.machine.runProgram(command, args, registerChild);
    if (!fs.existsSync(outPath)) {
      throw new Error(
        `The program did not create the file ${outPath}\nCommand line: ${this.machine.commandLine(command, args)}`,
      );
    }
  }
}
