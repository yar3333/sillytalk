// The common shape of every generation backend (a ComfyUI server, the SD
// WebUI API). The top-level service drives all backends through this interface
// only — adding a backend means adding one implementation, nothing else
// changes.

export interface IImageGeneratorDriver {
  // Stable identity of this generator entry: recorded in the sidecar next to
  // the picture and used by the hover hint (the backend kind + its address +
  // the model it runs).
  readonly key: string;
  // The identity of the queue this generator's jobs are serialized in. Two
  // entries that share one resource — the same ComfyUI server, the same SD
  // instance — share a queue even though they are different generators: a GPU
  // must not be hit by several runs at once.
  readonly queueKey: string;
  // Is the backend up right now (reachable, and set up well enough to run)?
  available(): Promise<boolean>;
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
