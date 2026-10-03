export type ImageJobResult =
  | { status: "ok" }
  // hadOld — an image already existed at the name before the run, so a
  // failed/cancelled run leaves the message ready on the old file.
  | { status: "failed"; error: string; hadOld: boolean }
  | { status: "cancelled"; hadOld: boolean };
