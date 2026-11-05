// What a sidecar *.json next to an image says about it: a human-readable
// description of what is on the image plus everything needed to reproduce it
// (the generation prompt and the reference images it was drawn from).
//
// The file is meant to be hand-editable, so every field is optional and the
// unknown keys a user adds are kept on write (see ImageMetaFile.write). The
// refs are image identifiers — paths relative to the data folder, exactly as
// the chat messages store them.
export type ImageMeta = {
  // The human-readable English name the generated image was saved under
  // ("a sunset over the sea"); the file name is derived from it.
  name?: string;
  // What is visible on the image — the caption shown under it and handed to
  // the model as the text of an image message.
  description?: string;
  // The prompt the image was generated with (English). Absent for an image the
  // user uploaded — an upload has no generation data.
  prompt?: string;
  negativePrompt?: string;
  // The images the generation used as references (ids, in the order they were
  // passed to the generator).
  refs?: string[];
  // How the image got here: uploaded by the user, drawn on request (the 🎨
  // mode), or drawn automatically for the user's turn.
  source?: "upload" | "manual" | "auto";
  // The generator that produced it (the driver key: a local program command or
  // an SD API URL) and the model that wrote the prompt (an llmModels key).
  generator?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  // ISO timestamps of the first write and the last change.
  createdAt?: string;
  updatedAt?: string;
  // Anything a user adds by hand survives the read/write round trip.
  [key: string]: unknown;
};

// The sidecar keys that describe how the picture was made. The picture editor
// removes exactly these when the user says the card is just a file — the
// description and the timestamps are not part of the generation data.
export const IMAGE_GENERATION_KEYS = [
  "prompt",
  "negativePrompt",
  "refs",
  "source",
  "generator",
  "model",
  "width",
  "height",
  "steps",
] as const;

// The generator settings worth remembering about a run (stored into the
// sidecar when the generator reports them).
export type ImageGenerationRecord = {
  prompt: string;
  refs?: string[];
  negativePrompt?: string;
  source?: ImageMeta["source"];
  generator?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
};
