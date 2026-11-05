// A ComfyUI server the app draws on. One entry runs ONE model of the app's
// catalogue (the workflows are shipped with the app — see
// image_generation/comfyui/ComfyUiWorkflows.ts), so a server that serves two
// models is configured as two generators.
export type ComfyUiSettings = {
  kind: "comfyui";
  url: string;
  // The model this generator runs: a name of that catalogue. A name the app
  // has no workflow for makes the generator unavailable.
  model: string;
  // The GPU the model loaders of the workflow are pinned to ("cuda:0"). A
  // server with several cards runs one generator per card this way.
  device: string;
  width: number;
  height: number;
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};
