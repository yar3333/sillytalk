import http from 'http';
import zlib from 'zlib';

// The shared e2e mocks: a deterministic OpenAI-compatible LLM (with a
// controllable delay) and a mock ComfyUI server. Both suites (app.spec.ts and
// ux-explore.spec.ts) use them, so the runs are fast and do not depend on the
// user's real models or on a real ComfyUI.
//
// The mock LLM reads the character name from the system prompt ("You are
// <name> …") and answers "Mock reply from <name>." — enough for the suite
// assertions (non-empty text, no [SILENT]/⚠️, the author is one of the chat
// participants). A responder (MockLlmOptions.customReplies) may answer with any
// text, which is how a test makes a character END ITS LINE with a picture
// marker — [IMAGE_BY_ID …] / [IMAGE_BY_PROMPT …]. The side calls of the pipeline
// are answered by their own branches: the prompt translation ("Translate …"),
// the TWO stages a picture is planned in — stage one, where the model says what
// the next picture of the conversation should show ("You decide what picture …",
// the 📷 button), and stage two, where a description becomes the generator's
// prompt plus its reference set ("You turn a description of one picture …", used
// by 📷, the 🎨 dialog, the [IMAGE_BY_PROMPT] marker and the editor's "Prompt and
// references") — the second getting the strict JSON plan the service parses,
// plus the editor's "Make it English" and "Describe the
// picture".
//
// The mock ComfyUI server speaks the part of the API the app uses — the
// workflow converter, the input upload, the queue and history and the picture
// download — and what a job does is decided by the prompt text the app
// substituted into the workflow: a "fail" prompt fails on the server, a "slow"
// one takes 5 s, anything else is drawn at once. The picture it hands out is a
// real PNG built in process, so the browser shows it.

// ------------------------------------------------------------------ helpers
// A small valid PNG built in-process (truecolor, one solid color).
export function makePng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    let c = 0xffffffff;
    for (const byte of Buffer.concat([t, data])) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;

// ------------------------------------------------------------------ the LLM
function lastUserText(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p: Record<string, unknown>) => p.type === 'text')
        .map((p: Record<string, unknown>) => String(p.text))
        .join(' ');
    }
  }
  return '';
}

export interface MockLlm {
  baseUrl: string;
  port: number;
  setDelay(ms: number): Promise<void>;
  // Stage two: the plan a description is turned into (the prompt, the reference
  // numbers, the cast). null = the model answers with prose, which the app has
  // to survive as a broken picture.
  setImagePlan(plan: MockImagePlan | null): Promise<void>;
  // Stage one: the sentence the model says the next picture of the conversation
  // should show — it becomes that picture's caption. null = it says nothing,
  // which is the other way a 📷 card can break.
  setPictureDescription(text: string | null): Promise<void>;
  // What the stage-two call last asked for (null — none yet): the system prompt
  // and the user text, so a test can see what the model was told about the
  // people and the pictures of the chat. One call serves the 📷 button, the 🎨
  // dialog, a character's [IMAGE_BY_PROMPT] marker and the editor's "Prompt and
  // references" — the description is the only thing that differs.
  lastPlanRequest(): { system: string; text: string } | null;
  // The same for stage one: what the model was shown when it had to decide what
  // the next picture should be about.
  lastDescriptionRequest(): { system: string; text: string } | null;
  close(): void;
}

// The plan the mock returns for the picture-planning call of the user's turn
// (the POST /chats/:id/auto-image flow). `refs` are the 1-based numbers of the
// pictures listed in that request; `cast` are the ids of the people the picture
// shows and `subjects` the noun phrase the prompt uses for each of them.
export interface MockImagePlan {
  name: string;
  description: string;
  prompt: string;
  refs: number[];
  cast?: string[];
  subjects?: Array<{ id: string; noun: string }>;
}

const DEFAULT_IMAGE_PLAN: MockImagePlan = {
  name: 'red circle sketch',
  description: 'A red circle on a white background',
  prompt: 'a red circle on a white background',
  refs: [],
  cast: [],
  subjects: [],
};

// What stage one says by default. It is the picture's CAPTION, so a test that
// cares about the caption sets its own sentence and reads it back in the card.
const DEFAULT_PICTURE_DESCRIPTION = 'A red circle on a white background';

// When set, the mock calls it for a normal (non-translate, non-planning) reply
// and uses the returned text (when not null) instead of the default "Mock
// reply from <name>." — the suites use it to answer with specific wording.
export type MockLlmResponder = (args: {
  system: string;
  text: string;
  name: string;
}) => string | null;

export interface MockLlmOptions {
  customReplies?: MockLlmResponder;
}

// Starts a mock OpenAI-compatible /chat/completions server. The delay before
// answering is controllable at runtime (setDelay) — the tests use it to make
// the "typing…" / cancel / regenerate flows deterministic.
export async function startMockLlm(
  initialDelayMs = 300,
  opts: MockLlmOptions = {},
): Promise<MockLlm> {
  let delay = initialDelayMs;
  let imagePlan: MockImagePlan | null = { ...DEFAULT_IMAGE_PLAN };
  // The last picture-planning request the app made (the app's own system prompt
  // + the dialogue/pictures/cast it was given) — a test reads it to check what
  // the model was actually told.
  let planRequest: { system: string; text: string } | null = null;
  // Stage one: the same for the call that decides WHAT the next picture of the
  // conversation should show, and the sentence it answers with (the caption).
  let descriptionRequest: { system: string; text: string } | null = null;
  let pictureDescription: string | null = DEFAULT_PICTURE_DESCRIPTION;
  const responder = opts.customReplies;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as {
          messages?: Array<Record<string, unknown>>;
          reasoning_effort?: string;
          reasoning?: { effort?: string };
        };
        const messages = parsed.messages ?? [];
        const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
        const text = lastUserText(messages);
        // The reasoning level the provider received (the config -> payload
        // wiring check): reasoning_effort (OpenAI/llama.cpp) or
        // reasoning.effort (OpenRouter).
        const effort =
          typeof parsed.reasoning_effort === 'string' && parsed.reasoning_effort
            ? parsed.reasoning_effort
            : parsed.reasoning?.effort;
        const reasoningNote = effort ? ` (reasoning: ${effort})` : '';
        let content: string;
        if (system.startsWith('Translate')) {
          // translatePrompt: the words survive into the generator prompt and
          // steer the mock generator script.
          if (/fail/i.test(text)) content = 'mock failure requested';
          else if (/slow/i.test(text)) content = 'a slow scenic painting';
          else content = 'a red circle on a white background';
        } else if (system.startsWith('You decide what picture')) {
          // Stage one of the 📷 picture: the model reads the dialogue and the
          // catalogue and says what the next picture should show. The answer is
          // the picture's caption, so a test that wants to read it back sets its
          // own sentence; null makes the model say nothing, which the app has to
          // turn into a broken card instead of a pending one.
          descriptionRequest = { system, text };
          content = pictureDescription ?? '';
        } else if (system.startsWith('You turn a description of one picture')) {
          // Stage two: a description becomes the generator's prompt plus the
          // pictures it draws the faces and places from. One branch serves the
          // 📷 button, the 🎨 dialog, a character's [IMAGE_BY_PROMPT] marker and
          // the editor's "Prompt and references" — they all ask the same thing.
          // null means the model "refused" — it answers with prose instead, which
          // the backend has to survive.
          planRequest = { system, text };
          content = imagePlan
            ? JSON.stringify(imagePlan)
            : 'I am not sure what to draw here, sorry.';
        } else if (system.startsWith('You prepare an image generation prompt')) {
          // tunePrompt: the picture editor's "Make it English" button — the
          // words survive into the generator prompt like the translation.
          content = /fail/i.test(text) ? 'mock failure requested' : 'a red circle on a white background';
        } else if (system.startsWith('You describe pictures')) {
          // describePicture: the picture editor's "Describe the picture".
          content = 'A red circle on a white background, described by the mock model.';
        } else {
          const who = /^You are ([A-Za-z]+)/.exec(system)?.[1] ?? 'Model';
          content =
            (responder?.({ system, text, name: who }) ?? `Mock reply from ${who}.`) +
            reasoningNote;
        }
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        }, delay);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    setDelay(ms: number) {
      delay = ms;
      return Promise.resolve();
    },
    setImagePlan(plan: MockImagePlan | null) {
      imagePlan = plan ? { ...DEFAULT_IMAGE_PLAN, ...plan } : null;
      return Promise.resolve();
    },
    setPictureDescription(text: string | null) {
      pictureDescription = text;
      return Promise.resolve();
    },
    lastPlanRequest() {
      return planRequest;
    },
    lastDescriptionRequest() {
      return descriptionRequest;
    },
    close() {
      server.close();
    },
  };
}

// ------------------------------------------------------------------ the generator
// A stand-in for a ComfyUI server running the comfyui-sillytalk plugin, carrying
// the routes the app drives:
//
//   GET  /system_stats            — is the server there
//   GET  /sillytalk/models        — the availability probe and the model pick
//   GET  /sillytalk/health        — the plugin's own account of its cards
//   POST /sillytalk/generate      — the job: prompt, size, reference pictures
//   GET  /sillytalk/jobs/{id}     — what the app polls until the job is terminal
//   GET  /sillytalk/jobs/{id}/image — the finished picture, as bytes
//   DELETE /sillytalk/jobs/{id}   — the app asks to drop a cancelled job
//
// What a job does follows the prompt text the app sent: "fail" — the server
// fails it, "slow" — it takes 5 s, anything else is drawn after a short pause.
// One imageGenerators entry of the config — the same shape the app reads from
// /api/config (the suites PUT it there before each test). No pixel numbers: the
// app asks for a shape and this server answers with the size of its own.
export interface MockComfyGenerator {
  kind: 'comfyui';
  url: string;
  model: string;
  orientation: MockOrientation;
  enabled: boolean;
}

export type MockOrientation = 'square' | 'portrait' | 'landscape';

// The pixels this mock turns each shape into. They are deliberately not square
// and not equal, so a run that mixed them up would be caught by the size of the
// picture the app saved.
export const MOCK_SIZES: Record<MockOrientation, [number, number]> = {
  square: [96, 96],
  portrait: [72, 96],
  landscape: [96, 72],
};

export interface MockComfy {
  url: string;
  // the imageGenerators entry that points at this server
  generator: MockComfyGenerator;
  // What the app actually sent: the prompt of every submitted job and the name
  // of every reference picture that came with one. A test reads them to check
  // the prompt the generator really saw and which pictures went with it.
  prompts(): string[];
  uploads(): string[];
  // The shape, the model file and the LoRAs of every job, as the server read
  // them from the request.
  requests(): { orientation: string; modelFile: string; loras: string }[];
  close(): void;
}

interface MockComfyJob {
  id: string;
  prompt: string;
  orientation: MockOrientation;
  finishesAt: number;
  fails: boolean;
  cancelled: boolean;
}

export async function startMockComfy(model = 'qwen-image-2.1'): Promise<MockComfy> {
  const jobs: MockComfyJob[] = [];
  // What the app sent: the prompt of every job, the name of every uploaded
  // reference picture, and the shape/file/LoRAs each job asked for.
  const promptLog: string[] = [];
  const uploadLog: string[] = [];
  const requestLog: { orientation: string; modelFile: string; loras: string }[] = [];
  let nextId = 1;

  // The text fields of a multipart request, and the names of its file parts.
  const fieldOf = (raw: Buffer, name: string): string =>
    new RegExp(`name="${name}"\r\n\r\n([^\r]*)`).exec(raw.toString('utf-8'))?.[1] ?? '';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://comfy.test');
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const route = `${req.method} ${url.pathname}`;
      try {
        if (route === 'GET /system_stats') return send(200, { mock: true });

        if (route === 'GET /sillytalk/models') {
          return send(200, {
            models: [
              {
                code: model,
                label: 'Mock model',
                max_refs: 2,
                orientation: 'square',
                sizes: MOCK_SIZES,
                model_file: 'mock_model.safetensors',
                model_files: {
                  folder: 'diffusion_models',
                  options: [
                    { name: 'mock_model.safetensors', mb: 6919 },
                    { name: 'mock_model_derivative.safetensors', mb: 12000 },
                  ],
                },
                loras: {
                  max: 5,
                  options: [
                    { name: 'mock_style_a.safetensors', mb: 200 },
                    { name: 'mock_style_b.safetensors', mb: 200 },
                  ],
                },
              },
            ],
          });
        }

        if (route === 'GET /sillytalk/health') {
          return send(200, {
            name: 'comfyui-sillytalk',
            version: '1.1.0-mock',
            comfyui_version: '0.44.2-mock',
            workflow_dir: '/mock/workflows',
            models: [model],
            broken_workflows: [],
            devices: [{ device: 'cuda:0', name: 'Mock Card', vram_total_mb: 24000, vram_free_mb: 23000 }],
            resident_models: [],
          });
        }

        if (route === 'POST /sillytalk/generate') {
          const prompt = fieldOf(raw, 'prompt');
          const sent = fieldOf(raw, 'model');
          if (sent !== model) return send(400, { error: `no workflow named '${sent}' in this server's catalogue` });
          const orientation = (fieldOf(raw, 'orientation') || 'square') as MockOrientation;
          requestLog.push({
            orientation,
            modelFile: fieldOf(raw, 'model_file'),
            loras: fieldOf(raw, 'loras'),
          });
          for (const part of raw.toString('binary').matchAll(/filename="([^"]*)"/g)) uploadLog.push(part[1]);
          const id = `mock-${nextId++}`;
          promptLog.push(prompt);
          jobs.push({
            id,
            prompt,
            orientation: MOCK_SIZES[orientation] ? orientation : 'square',
            finishesAt: Date.now() + (/slow/i.test(prompt) ? 5000 : 400),
            fails: /fail/i.test(prompt),
            cancelled: false,
          });
          return send(202, { job_id: id, model: sent, status: 'queued' });
        }

        if (req.method === 'DELETE' && /^\/sillytalk\/jobs\/[^/]+$/.test(url.pathname)) {
          const id = decodeURIComponent(url.pathname.slice('/sillytalk/jobs/'.length));
          const job = jobs.find((j) => j.id === id);
          if (job) job.cancelled = true;
          return send(200, { job_id: id, status: 'cancelled' });
        }

        const jobRoute = /^\/sillytalk\/jobs\/([^/]+)(\/image)?$/.exec(url.pathname);
        if (jobRoute) {
          const id = decodeURIComponent(jobRoute[1]);
          const job = jobs.find((j) => j.id === id);
          if (!job) return send(404, { error: 'no such job on this server' });
          if (jobRoute[2]) {
            if (job.fails || job.cancelled) return send(410, { error: 'the job has no picture to send' });
            if (Date.now() < job.finishesAt) return send(409, { error: 'the job is still running' });
            const [w, h] = MOCK_SIZES[job.orientation];
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(makePng(w, h, 210, 60, 60));
            return;
          }
          if (job.cancelled) return send(200, { job_id: id, status: 'cancelled' });
          if (job.fails) {
            return send(200, { job_id: id, status: 'failed', error: 'the mock ComfyUI failed on purpose' });
          }
          if (Date.now() < job.finishesAt) return send(200, { job_id: id, status: 'running' });
          const [w, h] = MOCK_SIZES[job.orientation];
          return send(200, {
            job_id: id,
            status: 'succeeded',
            seconds: 0.4,
            orientation: job.orientation,
            width: w,
            height: h,
            model_file: 'mock_model.safetensors',
            loras: [],
            placements: [{ node: '1', class: 'UNETLoaderMultiGPU', device: 'cuda:0', mb: 12000 }],
          });
        }

        return send(404, { error: `the mock ComfyUI has no ${route} route` });
      } catch (err) {
        return send(500, { error: String(err) });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    generator: {
      kind: 'comfyui',
      url,
      model,
      orientation: 'square',
      enabled: true,
    },
    // what the app sent this server: the prompt of every job (in the order the
    // jobs arrived) and the name of every reference it sent with them
    prompts() {
      return [...promptLog];
    },
    uploads() {
      return [...uploadLog];
    },
    requests() {
      return [...requestLog];
    },
    close() {
      server.close();
    },
  };
}
