import { ImageJobResult } from "./ImageJobResult";

export interface ImageJob {
  // Resolves when the generation finishes (ok / failed / cancelled).
  readonly result: Promise<ImageJobResult>;
  // Cancels the run in flight. A job that has not started yet is dropped.
  cancel(): void;
}
