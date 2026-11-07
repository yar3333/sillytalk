// The common shape of every generation backend (a ComfyUI server, the SD
// WebUI API). The top-level service drives all backends through this interface
// only — adding a backend means adding one implementation, nothing else
// changes.

export interface IImageGeneratorDriver {
  // Stable identity of this generator entry: recorded in the picture's row of
  // the images table and used by the hover hint (the backend kind + its address
  // + the model it runs).
  readonly key: string;
  // The identity of the queue this generator's jobs are serialized in. Two
  // entries that share one resource — the same ComfyUI server, the same SD
  // instance — share a queue even though they are different generators: a GPU
  // must not be hit by several runs at once.
  readonly queueKey: string;
  // Is the backend up right now (reachable, and set up well enough to run)?
  available(): Promise<boolean>;
  // How many reference images this generator can take at once. A backend that
  // has no branch for a reference answers 0 — and a generation that was told a
  // different number gets its extra references dropped rather than failing, so
  // the job still produces the picture the user asked for.
  readonly maxRefs: number;
  // Runs one generation and writes the produced image to outPath (absolute).
  // registerAbort lets a caller cancel the run in flight (a background job);
  // the driver aborts its own requests and, when the backend keeps running the
  // job without the client, tells it to stop.
  run(
    prompt: string,
    refPaths: string[],
    outPath: string,
    registerAbort?: (ctrl: AbortController) => void,
  ): Promise<void>;
}
