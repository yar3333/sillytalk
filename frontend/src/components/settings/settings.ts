import { Component, OnInit, inject, signal } from '@angular/core';
import {
  AppConfig,
  ComfyUiFileOption,
  ComfyUiFit,
  ComfyUiOrientation,
  ComfyUiPluginModel,
  ComfyUiSettings,
  ImageGenerator,
  PictureLanguage,
  SdApiSettings,
  isComfyUiGenerator,
} from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { UiStore } from '../../services/ui-store';

// The shapes a picture can be asked for, in the order the pick lists them when
// a server's catalogue says nothing about its own.
const ORIENTATIONS: ComfyUiOrientation[] = ['square', 'portrait', 'landscape'];

// The "Settings" modal: the listen address and the image generators. The
// models, characters and personas are managed by their own edit dialogs
// (opened from the top-bar menus) — the sections were removed from here.
@Component({
  selector: 'app-settings',
  template: `
    @if (m()) {
      <div class="settings-body">
        <label class="field">
          <span>Address (host:port)</span>
          <input [value]="m()!.listen" (input)="setListen($event)" />
        </label>

        <div class="hint">
          Models, characters and personas are edited in the menus on the header (the name or the
          model chip) — with per-item dialogs.
        </div>

        <h3>Picture descriptions</h3>
        <label class="field">
          <span>Language</span>
          <!-- The list comes from the backend (it is the one that tells the
               model to write in that language), and [selected] goes on the
               option — [value] on the <select> would be set before the @for
               options exist and silently fail. -->
          <select data-testid="settings-picture-language" (change)="setPictureLanguage($event)">
            @for (lang of languages(); track lang.code) {
              <option [value]="lang.code" [selected]="lang.code === pictureLanguage()">
                {{ lang.name }}
              </option>
            }
          </select>
        </label>
        <div class="hint">
          The language of a picture's DESCRIPTION: the vision model's "Describe the picture", the
          caption of an attached picture and the caption the 📷 plan gives its own picture. The
          generation PROMPT is always English — that is what the generators read.
        </div>

        <h3>Picture prompt model</h3>
        <label class="field">
          <span>Prompt model</span>
          <!-- [selected] on the option: [value] on the <select> would be set
               before the @for options exist and silently fail. -->
          <select data-testid="settings-prompt-model" (change)="setPromptModel($event)">
            <option value="" [selected]="!m()!.imagePromptModel">Default (the chat model)</option>
            @for (model of configStore.models(); track model.name) {
              <option [value]="model.name" [selected]="model.name === m()!.imagePromptModel">
                {{ model.name }}
              </option>
            }
          </select>
        </label>
        <div class="hint">
          The model that plans the picture prompts — the 📷 "picture of my turn" and the editor's
          "From the chat". Leave it on Default to use the app's chat model (the model chip in the
          header); pick a strong one here to plan with it instead. Replies and picture captions use
          the chat model and the vision chip.
        </div>

        <h3>Image generation</h3>
        <div class="hint">
          Every enabled and available generator works in parallel — the jobs of one server are
          queued (one run at a time). A ComfyUI server running two models is two generators, one
          per model.
        </div>
        @for (g of generators(); track $index; let i = $index) {
          <div class="block">
            <div class="row">
              <span>{{ genKind(g) }}</span>
              <label class="chk">
                <input type="checkbox" [checked]="g.enabled !== false" (change)="setGenEnabled(i, $event)" />
                enabled
              </label>
              <button class="btn danger" (click)="removeGenerator(i)" style="margin-left: auto">✕</button>
            </div>
            @if (isComfy(g)) {
              <input class="full" placeholder="ComfyUI URL (http://127.0.0.1:8188)" [value]="g.url" (input)="setGenStr(i, 'url', $event)" />
              <div class="row">
                <label class="grow">
                  <span>model</span>
                  <!-- [selected] on the option: [value] on the <select> would be set
                       before the @for options exist and silently fail. -->
                  <select data-testid="settings-comfy-model" (change)="setComfyModel(i, $event)">
                    @for (m of comfyModels(g); track m.code) {
                      <option [value]="m.code" [selected]="m.code === g.model">{{ m.code }}</option>
                    }
                  </select>
                </label>
                <label class="grow">
                  <span>orientation</span>
                  <select data-testid="settings-comfy-orientation" (change)="setGenStr(i, 'orientation', $event)">
                    @for (o of comfyOrientations(g); track o) {
                      <option [value]="o" [selected]="o === g.orientation">{{ o }} — {{ comfySize(g, o) }}</option>
                    }
                  </select>
                </label>
              </div>
              @if (comfyFiles(g).length) {
                <label class="field">
                  <span>model file</span>
                  <select data-testid="settings-comfy-file" (change)="setComfyFile(i, $event)">
                    <option value="" [selected]="!g.modelFile">the workflow's own{{ comfyOwnFile(g) ? ' — ' + comfyOwnFile(g) : '' }}</option>
                    @for (f of comfyFiles(g); track f.name) {
                      <option [value]="f.name" [selected]="f.name === g.modelFile">{{ f.name }}{{ f.mb ? ' · ' + f.mb + ' MB' : '' }}</option>
                    }
                  </select>
                </label>
              }
              @if (comfyLoras(g).length) {
                <div class="hint">
                  LoRA — {{ comfySlots(g) }} slot(s) wired into its workflow,
                  {{ comfyLoras(g).length }} file(s) in models/loras/ of the server
                </div>
                @for (f of comfyLoras(g); track f.name) {
                  <div class="row" [class.dim]="loraFit(g, f)?.fits === 'no'">
                    <label class="chk">
                      <input
                        type="checkbox"
                        data-testid="settings-comfy-lora"
                        [checked]="loraOn(g, f.name)"
                        [disabled]="loraBlocked(g, f)"
                        (change)="toggleLora(i, f.name, $event)"
                      />
                      {{ f.name }}{{ f.mb ? ' · ' + f.mb + ' MB' : '' }}
                    </label>
                    @if (loraOn(g, f.name)) {
                      <label class="grow">
                        <span>strength</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          [value]="loraStrength(g, f.name)"
                          (input)="setLoraStrength(i, f.name, $event)"
                        />
                        {{ loraStrength(g, f.name) }}
                      </label>
                    }
                  </div>
                  @if (loraReason(g, f); as why) {
                    <div class="why" data-testid="settings-comfy-lora-why">{{ why }}</div>
                  }
                }
              }
              <div class="hint">
                The server draws {{ g.model }} with its own plugin (comfyui-sillytalk): it turns the
                orientation into the pixels that model was trained at, and picks the GPU from the
                memory free when the job arrives. Drop a file of your own into its
                models/diffusion_models/ or models/loras/ and it appears in these lists.
              </div>
            } @else {
              <input class="full" placeholder="URL (http://127.0.0.1:7860)" [value]="g.url" (input)="setGenStr(i, 'url', $event)" />
              <div class="row">
                <label><span>steps</span> <input type="number" [value]="g.steps" (input)="setGenNum(i, 'steps', $event)" /></label>
                <label><span>width</span> <input type="number" [value]="g.width" (input)="setGenNum(i, 'width', $event)" /></label>
                <label><span>height</span> <input type="number" [value]="g.height" (input)="setGenNum(i, 'height', $event)" /></label>
              </div>
              <label class="row"><span>denoising</span> <input type="number" step="0.05" [value]="g.denoisingStrength" (input)="setGenNum(i, 'denoisingStrength', $event)" /></label>
              <input class="full" placeholder="Negative prompt" [value]="g.negativePrompt" (input)="setGenStr(i, 'negativePrompt', $event)" />
            }
          </div>
        }
        <div class="row">
          <button class="btn" (click)="addComfyUi()">+ ComfyUI</button>
          <button class="btn" (click)="addSdApi()">+ SD API</button>
        </div>

        <div class="row actions">
          <button class="btn primary" (click)="save()">Save</button>
          <button class="btn" (click)="onCancel()">Cancel</button>
        </div>
      </div>
    }
  `,
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  // The config — from ConfigStore (editingConfig — a copy of the config).
  // The error banner — UiStore.
  readonly configStore = inject(ConfigStore);
  readonly ui = inject(UiStore);

  m = signal<AppConfig | null>(null);

  ngOnInit(): void {
    // editingConfig — a copy of the config made in configStore.openSettings().
    const cfg = this.configStore.editingConfig();
    if (cfg) {
      this.m.set(JSON.parse(JSON.stringify(cfg)) as AppConfig);
    }
  }

  // Handlers: casts and Number cannot be written in the template — done in TS.
  private setListen(e: Event): void {
    const c = this.m()!;
    c.listen = (e.target as HTMLInputElement).value;
    this.m.set({ ...c });
  }

  // The global picture-prompt model. An empty pick is a real choice — the chat's
  // own model plans again — so the field is dropped rather than stored empty.
  private setPromptModel(e: Event): void {
    const c = this.m()!;
    const name = (e.target as HTMLSelectElement).value;
    if (name) c.imagePromptModel = name;
    else delete c.imagePromptModel;
    this.m.set({ ...c });
  }

  // ---- picture descriptions (the language of the captions) ----
  // The languages the backend can ask a model to write in; the pick stores the
  // code, and the name travels with it, so the prompt and the list cannot
  // disagree.
  languages(): PictureLanguage[] {
    return this.configStore.pictureLanguages();
  }
  // English is what a config without the field means.
  pictureLanguage(): string {
    return this.m()?.pictureLanguage || 'en';
  }
  private setPictureLanguage(e: Event): void {
    const c = this.m();
    if (!c) return;
    c.pictureLanguage = (e.target as HTMLSelectElement).value;
    this.m.set({ ...c });
  }

  // ---- image generators (imageGenerators: ImageGenerator[]) ----
  generators(): ImageGenerator[] {
    return this.m()?.imageGenerators ?? [];
  }
  genKind(g: ImageGenerator): string {
    return isComfyUiGenerator(g) ? `ComfyUI — ${g.model}` : 'SD API';
  }
  // Type guards must be component methods: narrowing imported functions
  // in the template does not work.
  private isComfy(g: ImageGenerator): g is ComfyUiSettings {
    return isComfyUiGenerator(g);
  }
  // An <input> and a <select> both hand over their value the same way, so one
  // setter covers the text fields and the model pick.
  private setGenStr(i: number, key: string, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i] as unknown as Record<string, unknown>;
    if (!gen) return;
    gen[key] = (e.target as HTMLInputElement).value;
    this.m.set({ ...c });
  }
  private setGenNum(i: number, key: string, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i] as unknown as Record<string, unknown>;
    if (!gen) return;
    gen[key] = Number((e.target as HTMLInputElement).value);
    this.m.set({ ...c });
  }
  private setGenEnabled(i: number, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!gen) return;
    gen.enabled = (e.target as HTMLInputElement).checked;
    this.m.set({ ...c });
  }
  private removeGenerator(i: number): void {
    const c = this.m()!;
    const imageGenerators = [...c.imageGenerators];
    imageGenerators.splice(i, 1);
    this.m.set({ ...c, imageGenerators });
  }
  // ---- a ComfyUI generator, read off the catalogue of ITS server ----
  //
  // Everything a generator can be pointed at — its models, the file a model
  // loads, the LoRAs it can merge — is a file of that server, so every list
  // below is what the backend read from that server. Nothing here is typed by
  // hand: the user drops a file into models/diffusion_models/ or models/loras/
  // and it shows up.

  /** The models one server address published. */
  private comfyCatalogue(url: string): ComfyUiPluginModel[] {
    const want = (url ?? '').trim().replace(/\/+$/, '');
    return this.configStore.comfyUi().find((c) => (c.url ?? '').replace(/\/+$/, '') === want)?.models ?? [];
  }

  /** The models this generator's server offers. */
  comfyModels(g: ComfyUiSettings): ComfyUiPluginModel[] {
    const models = this.comfyCatalogue(g.url);
    // A model the config names that the server does not answer with stays in the
    // list — otherwise opening the dialog would silently rewrite the pick, and
    // saving it would lose the generator.
    if (g.model && !models.some((m) => m.code === g.model)) {
      return [{ code: g.model, max_refs: 0 }, ...models];
    }
    return models;
  }

  private comfyModel(g: ComfyUiSettings): ComfyUiPluginModel | undefined {
    return this.comfyModels(g).find((m) => m.code === g.model);
  }

  /** The shapes that model draws — exactly the ones its server lists sizes for. */
  comfyOrientations(g: ComfyUiSettings): ComfyUiOrientation[] {
    const sizes = Object.keys(this.comfyModel(g)?.sizes ?? {}) as ComfyUiOrientation[];
    return sizes.length ? sizes.filter((o) => ORIENTATIONS.includes(o)) : [...ORIENTATIONS];
  }

  /** The pixels the server turns a shape into — the hint beside the pick. */
  comfySize(g: ComfyUiSettings, o: ComfyUiOrientation): string {
    const wh = this.comfyModel(g)?.sizes?.[o];
    return wh ? `${wh[0]}×${wh[1]}` : 'its own';
  }

  /** The files of the server this model could load instead of its own. Its own
      is not repeated here — the first option of the pick is that file. */
  comfyFiles(g: ComfyUiSettings): ComfyUiFileOption[] {
    const model = this.comfyModel(g);
    return (model?.model_files?.options ?? []).filter((f) => f.name !== model?.model_file);
  }

  /** The file its workflow loads when the pick is left on "its own". */
  comfyOwnFile(g: ComfyUiSettings): string {
    return (this.comfyModel(g)?.model_file ?? '').split('/').pop() ?? '';
  }

  /** The files of the server's models/loras/. */
  comfyLoras(g: ComfyUiSettings): ComfyUiFileOption[] {
    return this.comfyModel(g)?.loras?.options ?? [];
  }

  /** How many LoRAs the workflow of this model has room for. */
  comfySlots(g: ComfyUiSettings): number {
    return this.comfyModel(g)?.loras?.max ?? 0;
  }

  /** The file a run of this generator loads: the pick, or the one its workflow names. */
  private comfyFileNow(g: ComfyUiSettings): string {
    return g.modelFile || this.comfyModel(g)?.model_file || '';
  }

  /** What the server says about this LoRA and the file that would be loaded now. */
  loraFit(g: ComfyUiSettings, f: ComfyUiFileOption): ComfyUiFit | undefined {
    return f.fits?.[this.comfyFileNow(g)];
  }

  /** A LoRA the server proved would merge into nothing is not a choice to make;
      a full set of slots is, for the LoRAs that are not already in it. */
  loraBlocked(g: ComfyUiSettings, f: ComfyUiFileOption): boolean {
    if (this.loraFit(g, f)?.fits === 'no') return true;
    return !this.loraOn(g, f.name) && (g.loras?.length ?? 0) >= this.comfySlots(g);
  }

  /** Why a row is grey, or — for a LoRA the server could not place — why it may
      do nothing. Empty when there is nothing to warn about. */
  loraReason(g: ComfyUiSettings, f: ComfyUiFileOption): string {
    const fit = this.loraFit(g, f);
    return fit && fit.fits !== 'yes' ? (fit.reason ?? '') : '';
  }

  loraOn(g: ComfyUiSettings, name: string): boolean {
    return (g.loras ?? []).some((l) => l.name === name);
  }

  loraStrength(g: ComfyUiSettings, name: string): number {
    return (g.loras ?? []).find((l) => l.name === name)?.strength ?? 1;
  }

  // Another model is another workflow: the file and the LoRAs picked for the
  // previous one are dropped when it cannot load them, and an orientation it has
  // no size for would only be answered by an error.
  private setComfyModel(i: number, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!isComfyUiGenerator(gen)) return;
    gen.model = (e.target as HTMLSelectElement).value;
    const model = this.comfyModel(gen);
    if (!model?.model_files?.options.some((f) => f.name === gen.modelFile)) delete gen.modelFile;
    this.keepFittingLoras(gen);
    if (model?.sizes && !(gen.orientation in model.sizes)) {
      gen.orientation = model.orientation ?? 'square';
    }
    this.m.set({ ...c });
  }

  // A checked LoRA the file about to be loaded cannot take would be answered by a
  // 400 from the server, so changing the file drops it the same way changing the
  // model does. The row stays visible and grey with the reason, ready for the
  // file it does fit.
  private keepFittingLoras(gen: ComfyUiSettings): void {
    const loras = (gen.loras ?? []).filter((l) => {
      const option = this.comfyModel(gen)?.loras?.options.find((f) => f.name === l.name);
      return option !== undefined && this.loraFit(gen, option)?.fits !== 'no';
    });
    if (loras.length) gen.loras = loras.slice(0, this.comfySlots(gen));
    else delete gen.loras;
  }

  // "The workflow's own" is a real choice, not an empty field: the file stays
  // out of the request and the plugin answers with the one its graph names.
  private setComfyFile(i: number, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!isComfyUiGenerator(gen)) return;
    const name = (e.target as HTMLSelectElement).value;
    if (name) gen.modelFile = name;
    else delete gen.modelFile;
    this.keepFittingLoras(gen);
    this.m.set({ ...c });
  }

  private toggleLora(i: number, name: string, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!isComfyUiGenerator(gen)) return;
    const loras = [...(gen.loras ?? [])];
    if ((e.target as HTMLInputElement).checked) {
      if (!loras.some((l) => l.name === name)) loras.push({ name, strength: 1 });
    } else {
      const at = loras.findIndex((l) => l.name === name);
      if (at >= 0) loras.splice(at, 1);
    }
    if (loras.length) gen.loras = loras;
    else delete gen.loras;
    this.m.set({ ...c });
  }

  private setLoraStrength(i: number, name: string, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!isComfyUiGenerator(gen)) return;
    const strength = Number((e.target as HTMLInputElement).value);
    gen.loras = (gen.loras ?? []).map((l) => (l.name === name ? { ...l, strength } : l));
    this.m.set({ ...c });
  }

  private addComfyUi(): void {
    const c = this.m()!;
    const url = 'http://127.0.0.1:8188';
    const g: ComfyUiSettings = {
      kind: 'comfyui',
      url,
      // the first model that server offers; the pick lists the rest
      model: this.comfyCatalogue(url)[0]?.code ?? '',
      orientation: 'square',
      enabled: true,
    };
    this.m.set({ ...c, imageGenerators: [...c.imageGenerators, g] });
  }
  private addSdApi(): void {
    const c = this.m()!;
    const g: SdApiSettings = {
      kind: 'sdapi',
      url: 'http://127.0.0.1:7860',
      steps: 30,
      width: 768,
      height: 768,
      denoisingStrength: 0.75,
      negativePrompt: '',
      enabled: true,
    };
    this.m.set({ ...c, imageGenerators: [...c.imageGenerators, g] });
  }

  save(): void {
    if (this.m()) {
      this.configStore.saveSettings(this.m()!);
    }
  }

  onCancel(): void {
    this.configStore.settingsOpen.set(false);
  }
}
