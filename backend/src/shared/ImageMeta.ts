// What the app knows about a picture: a human-readable description of what is
// on it plus everything needed to reproduce it (the generation prompt and the
// reference images it was drawn from).
//
// One of these is one ROW of the global images table (images/ImageMetaService.ts),
// keyed by the image id — the path of the picture relative to the data folder.
// The table is the one source of this data: an image card of a chat reads its
// caption, its prompt and its cast from there, so a card and its picture cannot
// drift apart. (The *.json sidecar files this used to live in are the old
// format: not supported, not read and not migrated.)
//
// The type is also the patch shape the writers hand to the service, which is
// why it stays open at the bottom: a field given as `undefined` removes that
// field from the row, and a merge never has to know the fields in advance.
//
// The refs are image identifiers — paths relative to the data folder, exactly
// as the chat messages store them.
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
  // Who is visible on the picture: cast refs ("char:alice", "user:carol") of
  // the people in it. The picture planner offers such a picture as the look
  // reference of those people, so the next one keeps the same face.
  depicts?: string[];
  // The generator that produced it (the driver key: an SD API URL or a
  // ComfyUI server + model) and the model that wrote the prompt (an llmModels
  // key).
  generator?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  // ISO timestamps of the first write and the last change.
  createdAt?: string;
  updatedAt?: string;
  // Facts about the FILE on disk, kept by the library's disk sync
  // (PictureLibraryService.sync, run at startup and whenever the picture
  // browser opens): the size, the modification time (ms) and the sha256 hex of
  // the content. The row of every picture on disk carries them — which is also
  // how a picture renamed OUTSIDE the app is recognised again: a file nobody's
  // row points at, whose extension, size and hash match a row whose file is
  // gone, is that same picture at a new path, and the row (and every card and
  // reference list naming the old path) follows it.
  fileSize?: number;
  fileModifiedAt?: number;
  fileHash?: string;
  // The patch semantics above: a key set to undefined is dropped from the row.
  [key: string]: unknown;
};

// The fields that describe how the picture was made. The picture editor clears
// exactly these when the user says the card is just a file — the description
// and the timestamps are not part of the generation data.
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

// The generator settings worth remembering about a run (written into the row of
// the picture when the generator reports them).
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
