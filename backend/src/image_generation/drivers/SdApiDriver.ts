import fs from "fs";
import { ChildProcess } from "child_process";
import { SdApiSettings } from "../../types";
import { IImageGeneratorDriver } from "../IImageGeneratorDriver";

// The Stable Diffusion WebUI backend (sdapi/v1): txt2img / img2img over
// HTTP. Availability is a short-timeout GET on /sd-models.
export class SdApiDriver implements IImageGeneratorDriver {
  readonly key: string;

  constructor(private readonly cfg: SdApiSettings) {
    this.key = `url:${SdApiDriver.normalizeUrl(cfg.url)}`;
  }

  // Strips the trailing slashes of an SD API base URL.
  private static normalizeUrl(url: string): string {
    return url.replace(/\/+$/, "");
  }

  async available(): Promise<boolean> {
    if (!this.cfg.url) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      try {
        const res = await fetch(`${SdApiDriver.normalizeUrl(this.cfg.url)}/sdapi/v1/sd-models`, {
          signal: ctrl.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async run(
    prompt: string,
    refPaths: string[],
    outPath: string,
    _registerChild?: (child: ChildProcess) => void,
    registerAbort?: (ctrl: AbortController) => void,
  ): Promise<void> {
    const endpoint = refPaths.length > 0 ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img";
    const payload: Record<string, unknown> = {
      prompt,
      steps: this.cfg.steps,
      width: this.cfg.width,
      height: this.cfg.height,
      negative_prompt: this.cfg.negativePrompt,
    };
    if (refPaths.length > 0) {
      payload.init_images = refPaths.map((p) => fs.readFileSync(p).toString("base64"));
      payload.denoising_strength = this.cfg.denoisingStrength;
    }

    // The AbortController is registered so a background job can cancel the
    // request in flight (the cancel-image endpoint).
    const ctrl = new AbortController();
    registerAbort?.(ctrl);
    const response = await fetch(`${SdApiDriver.normalizeUrl(this.cfg.url)}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`SD API returned ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = (await response.json()) as { images?: string[] };
    if (!data.images?.length) throw new Error("SD API returned no images");
    fs.writeFileSync(outPath, Buffer.from(data.images[0], "base64"));
  }
}
