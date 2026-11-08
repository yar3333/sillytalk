// The read-only answers of a ComfyUI server that the app itself never needs but
// a diagnostic run does: what the server is running on (GET /system_stats) and
// what it can actually execute (GET /object_info). Both are typed loosely on
// purpose — these are the server's own reporting fields, they have changed
// between ComfyUI releases and a missing field must never break a test run, so
// every reader of them treats each field as optional.

// One GPU (or CPU) the server knows about. VRAM is in bytes.
export type ComfyUiDevice = {
  name?: string;
  type?: string;
  index?: number;
  vram_total?: number;
  vram_free?: number;
  torch_vram_total?: number;
  torch_vram_free?: number;
};

// GET /system_stats
export type ComfyUiSystemStats = {
  system?: {
    os?: string;
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    ip_version?: string;
    embedded_python?: boolean;
    ram_total?: number;
    ram_free?: number;
    devices?: ComfyUiDevice[];
  };
};

// The spec of one input of a node class: ComfyUI describes a combo (a value
// picked from a list — a checkpoint name, a sampler name) either as the list
// itself or, in newer builds, as "COMBO" with the options in the extras object.
// Anything else is a free value (a number, a string, a link to another node).
export type ComfyUiInputSpec = [unknown, Record<string, unknown>?];

// GET /object_info — node class name -> what the server knows about it.
export type ComfyUiNodeClass = {
  input?: {
    required?: Record<string, ComfyUiInputSpec>;
    optional?: Record<string, ComfyUiInputSpec>;
  };
};

export type ComfyUiObjectInfo = Record<string, ComfyUiNodeClass | undefined>;

// The combo values a node class offers for one of its inputs, or null when the
// input is not a combo. Both spellings of the newer API are read.
export function comboOptionsOf(spec: ComfyUiInputSpec | undefined): string[] | null {
  if (!Array.isArray(spec)) return null;
  const first = spec[0];
  if (Array.isArray(first)) return first.filter((v): v is string => typeof v === "string");
  if (first === "COMBO") {
    const options = spec[1]?.options;
    if (Array.isArray(options)) return options.filter((v): v is string => typeof v === "string");
  }
  return null;
}
