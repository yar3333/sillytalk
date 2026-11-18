// Which way a picture stands. The pixel numbers behind it belong to the server
// that draws it (its model was trained at particular sizes), so the app sends an
// orientation and the plugin answers with the size it used.
export type ComfyUiOrientation = "square" | "portrait" | "landscape";

// One LoRA of the server's `models/loras/` folder, with how hard to apply it.
export type ComfyUiLora = {
  name: string;
  strength?: number; // absent = 1.0
};

// A ComfyUI server the app draws on, through its comfyui-sillytalk plugin. One
// entry runs ONE model of that server's catalogue, so a server that serves two
// models is configured as two generators.
export type ComfyUiSettings = {
  kind: "comfyui";
  url: string;
  // The model this generator asks the server for: a code the plugin's
  // /sillytalk/models lists. A code the server does not offer makes the
  // generator unavailable.
  model: string;
  orientation: ComfyUiOrientation;
  // The diffusion file to load instead of the one the workflow names — any file
  // of the server's models/diffusion_models/, which is how a derivative of the
  // model gets drawn with. Absent means the workflow's own default.
  modelFile?: string;
  // LoRAs from the server's models/loras/, applied in this order.
  loras?: ComfyUiLora[];
  // The GPU is NOT configured here: the plugin puts every model loader of a run
  // on the card that has room for it at submit time, which is the only moment
  // that can know.
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};
