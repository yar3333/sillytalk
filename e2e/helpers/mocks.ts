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
// participants). The two side calls of the pipeline are answered by their own
// branches: the prompt translation ("Translate …") and the picture planning of
// the user's turn ("You write prompts for an image generator …"), which gets
// the strict JSON plan the service parses.
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
  setImagePlan(plan: MockImagePlan | null): Promise<void>;
  close(): void;
}

// The plan the mock returns for the picture-planning call of the user's turn
// (the POST /chats/:id/auto-image flow). `refs` are the 1-based numbers of the
// pictures listed in that request.
export interface MockImagePlan {
  name: string;
  description: string;
  prompt: string;
  refs: number[];
}

const DEFAULT_IMAGE_PLAN: MockImagePlan = {
  name: 'red circle sketch',
  description: 'A red circle on a white background',
  prompt: 'a red circle on a white background',
  refs: [],
};

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
        } else if (system.startsWith('You plan one picture')) {
          // composeImagePrompt: the JSON plan of the user's-turn picture. null
          // means the model "refused" — it answers with prose instead, which
          // the backend has to survive.
          content = imagePlan
            ? JSON.stringify(imagePlan)
            : 'I am not sure what to draw here, sorry.';
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
    close() {
      server.close();
    },
  };
}

// ------------------------------------------------------------------ the generator
// A stand-in for a ComfyUI server, carrying the endpoints the app drives:
//
//   GET  /system_stats    — the availability probe
//   POST /workflow/convert — the converter custom node: the UI-format template
//                            of a model becomes the API workflow (the mock
//                            answers its own tiny workflow, with the PARAM_*
//                            placeholders of the variant it was handed)
//   POST /upload/image    — a reference into the server's input/ folder
//   POST /prompt          — the job goes into the queue, the prompt id back
//   GET  /history/{id}    — what the app polls until the job is done
//   GET  /view            — the finished picture
//   POST /queue, /interrupt — the app asks to drop a cancelled job
//
// What a job does follows the prompt text the app substituted into the
// workflow: "fail" — the server fails it, "slow" — it takes 5 s, anything else
// is drawn after a short pause.
// One imageGenerators entry of the config — the same shape the app reads from
// /api/config (the suites PUT it there before each test).
export interface MockComfyGenerator {
  kind: 'comfyui';
  url: string;
  model: string;
  device: string;
  width: number;
  height: number;
  enabled: boolean;
}

export interface MockComfy {
  url: string;
  // the imageGenerators entry that points at this server
  generator: MockComfyGenerator;
  close(): void;
}

// The workflow the mock converter answers with. The placeholder of a reference
// is only in it when the template asked for references, so an unsubstituted
// PARAM_* in a submitted job means the app forgot one.
function mockApiWorkflow(variant: 'text' | 'oneImage' | 'twoImages'): Record<string, unknown> {
  const nodes: Record<string, unknown> = {
    "1": { class_type: 'UNETLoaderMultiGPU', inputs: { unet_name: 'mock.safetensors', device: 'PARAM_DEVICE' } },
    "5": { class_type: 'CLIPTextEncode', inputs: { text: 'PARAM_PROMPT' } },
    "9": {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: 'PARAM_INT_OUTPUT_IMAGE_WIDTH', height: 'PARAM_INT_OUTPUT_IMAGE_HEIGHT' },
    },
    "10": { class_type: 'KSampler', inputs: { seed: 'PARAM_SEED', steps: 4, model: ['1', 0] } },
    "13": { class_type: 'SaveImage', inputs: { filename_prefix: 'PARAM_STRING_OUTPUT_IMAGE_FILENAME' } },
  };
  if (variant !== 'text') {
    nodes['20'] = {
      class_type: 'LoadImage',
      inputs: { image: variant === 'oneImage' ? 'PARAM_STRING_INPUT_IMAGE_FILENAME' : 'PARAM_STRING_INPUT_IMAGE_FILENAME_1' },
    };
  }
  if (variant === 'twoImages') {
    nodes['21'] = { class_type: 'LoadImage', inputs: { image: 'PARAM_STRING_INPUT_IMAGE_FILENAME_2' } };
  }
  return nodes;
}

interface MockComfyJob {
  id: string;
  prompt: string;
  prefix: string;
  finishesAt: number;
  fails: boolean;
}

export async function startMockComfy(
  model = 'qwen-image-2.1',
  size: { width: number; height: number } = { width: 96, height: 96 },
): Promise<MockComfy> {
  const jobs: MockComfyJob[] = [];
  const picture = makePng(96, 96, 210, 60, 60);
  let nextId = 1;

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

        if (route === 'POST /workflow/convert') {
          const ui = raw.toString('utf-8');
          const variant = ui.includes('PARAM_STRING_INPUT_IMAGE_FILENAME_1')
            ? 'twoImages'
            : ui.includes('PARAM_STRING_INPUT_IMAGE_FILENAME')
              ? 'oneImage'
              : 'text';
          return send(200, mockApiWorkflow(variant));
        }

        if (route === 'POST /upload/image') {
          const name = /filename="([^"]+)"/.exec(raw.toString('binary'))?.[1] ?? 'reference.png';
          return send(200, { name, subfolder: '', type: 'input' });
        }

        if (route === 'POST /prompt') {
          const submitted = (
            JSON.parse(raw.toString('utf-8')) as {
              prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
            }
          ).prompt;
          const text = String(
            Object.values(submitted).find((n) => n?.class_type === 'CLIPTextEncode')?.inputs?.text ?? '',
          );
          const prefix = String(
            Object.values(submitted).find((n) => n?.class_type === 'SaveImage')?.inputs?.filename_prefix ?? '',
          );
          const id = `mock-${nextId++}`;
          jobs.push({
            id,
            prompt: text,
            prefix,
            finishesAt: Date.now() + (/slow/i.test(text) ? 5000 : 400),
            fails: /fail/i.test(text),
          });
          return send(200, { prompt_id: id, node_errors: {} });
        }

        if (url.pathname.startsWith('/history/')) {
          const id = decodeURIComponent(url.pathname.slice('/history/'.length));
          const job = jobs.find((j) => j.id === id);
          if (!job) return send(200, {});
          if (job.fails) {
            return send(200, {
              [id]: {
                status: {
                  status_str: 'error',
                  completed: false,
                  messages: [['execution_error', { exception_message: 'the mock ComfyUI failed on purpose' }]],
                },
              },
            });
          }
          if (Date.now() < job.finishesAt) {
            return send(200, { [id]: { status: { status_str: 'running', completed: false, messages: [] } } });
          }
          return send(200, {
            [id]: {
              status: { status_str: 'success', completed: true, messages: [] },
              outputs: { '13': { images: [{ filename: `${job.prefix}_00001_.png`, subfolder: '', type: 'output' }] } },
            },
          });
        }

        if (route === 'GET /view') {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          res.end(picture);
          return;
        }

        if (route === 'POST /queue' || route === 'POST /interrupt') return send(200, {});

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
      device: 'cuda:0',
      width: size.width,
      height: size.height,
      enabled: true,
    },
    close() {
      server.close();
    },
  };
}
