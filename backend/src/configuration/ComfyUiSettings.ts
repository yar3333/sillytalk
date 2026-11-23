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
  // The shape to draw is NOT configured here: it is a property of each picture,
  // decided when its description becomes a prompt (see shared/ImageMeta.ts).
  // The diffusion file to load instead of the one the workflow names — any file
  // of the server's models/diffusion_models/, which is how a derivative of the
  // model gets drawn with. Absent means the workflow's own default.
  modelFile?: string;
  // LoRAs from the server's models/loras/, applied in this order.
  loras?: ComfyUiLora[];
  // How many steps the picture is drawn with. Absent means the number the
  // workflow's own sampler wires; the server validates the range it published
  // and answers the job with the count it actually ran.
  steps?: number;
  // The GPU is NOT configured here: the plugin puts every model loader of a run
  // on the card that has room for it at submit time, which is the only moment
  // that can know.
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};
