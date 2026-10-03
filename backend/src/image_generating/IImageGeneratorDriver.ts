import { ChildProcess } from "child_process";

// The common shape of every generation backend (SD API, local program).
// The top-level service drives all backends through this interface only —
// adding a backend means adding one implementation, nothing else changes.

export interface IImageGeneratorDriver {
  // Stable identity for the per-generator queue: the program command or the
  // API URL (two config entries pointing at the same program share a queue).
  readonly key: string;
  // Is the backend up right now (reachable / the command exists)?
  available(): Promise<boolean>;
  // Runs one generation and writes the produced image to outPath (absolute).
  // registerChild / registerAbort let a caller cancel a run in flight (a
  // background job); both are optional.
  run(
    prompt: string,
    refPaths: string[],
    outPath: string,
    registerChild?: (child: ChildProcess) => void,
    registerAbort?: (ctrl: AbortController) => void,
  ): Promise<void>;
}
