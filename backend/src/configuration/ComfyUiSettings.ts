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
  // The size to ask for. The GPU is NOT configured here: the plugin puts every
  // model loader of a run on the card that has room for it at submit time,
  // which is the only moment that can know.
  width: number;
  height: number;
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};
