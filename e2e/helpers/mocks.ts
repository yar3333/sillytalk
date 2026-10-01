import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';

// The shared e2e mocks: a deterministic OpenAI-compatible LLM (with a
// controllable delay) and a mock local-program image generator. Both suites
// (app.spec.ts and ux-explore.spec.ts) use them, so the runs are fast and do
// not depend on the user's real models.
//
// The mock LLM reads the character name from the system prompt ("You are
// <name> …") and answers "Mock reply from <name>." — enough for the suite
// assertions (non-empty text, no [SILENT]/[IMG:]/⚠️, the author is one of the
// chat participants).
//
// The mock generator is a bash script that sleeps (5 s for prompts containing
// "slow"), copies a template PNG to the output path, or fails when the prompt
// contains "fail". The backend runs it via the configured imageGenerators
// entry (command: "bash", args: [script, template, '{absolutePathToOutputImage}', '{prompt}']).

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
  close(): void;
}

// When set, the mock calls it for a normal (non-Translate) reply and uses the
// returned text (when not null) instead of the default "Mock reply from
// <name>.". The ux-explore suite uses this to test the model-initiated
// [IMG:...] / [PHOTO:1] tags.
export type MockLlmResponder = (args: {
  system: string;
  text: string;
  name: string;
}) => string | null;

export interface MockLlmOptions {
  drawReplies?: MockLlmResponder;
}

// Starts a mock OpenAI-compatible /chat/completions server. The delay before
// answering is controllable at runtime (setDelay) — the tests use it to make
// the "typing…" / cancel / regenerate flows deterministic.
export async function startMockLlm(
  initialDelayMs = 300,
  opts: MockLlmOptions = {},
): Promise<MockLlm> {
  let delay = initialDelayMs;
  const responder = opts.drawReplies;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { messages?: Array<Record<string, unknown>> };
        const messages = parsed.messages ?? [];
        const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
        const text = lastUserText(messages);
        let content: string;
        if (system.startsWith('Translate')) {
          // translatePrompt: the words survive into the generator prompt and
          // steer the mock generator script.
          if (/fail/i.test(text)) content = 'mock failure requested';
          else if (/slow/i.test(text)) content = 'a slow scenic painting';
          else content = 'a red circle on a white background';
        } else {
          const who = /^You are ([A-Za-z]+)/.exec(system)?.[1] ?? 'Model';
          content =
            responder?.({ system, text, name: who }) ?? `Mock reply from ${who}.`;
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
    close() {
      server.close();
    },
  };
}

// ------------------------------------------------------------------ the generator
// Writes the mock generator script + a template PNG into dir and returns the
// config entry (imageGenerators[0]) and the script/template paths.
export interface MockGenSetup {
  generator: {
    command: string;
    args: string[];
    maxInputImages: number;
  };
  script: string;
  template: string;
}

export function setupMockGenerator(dir: string): MockGenSetup {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'mock-gen.sh');
  const template = path.join(dir, 'template.png');
  fs.writeFileSync(template, makePng(96, 96, 210, 60, 60));
  fs.writeFileSync(
    script,
    [
      '#!/bin/bash',
      'TEMPLATE="$1"; OUT="$2"; PROMPT="$3"',
      'case "$PROMPT" in *fail*) echo "mock generator: intentional failure" >&2; exit 1;; esac',
      'case "$PROMPT" in *slow*) sleep 5;; *) sleep 1.2;; esac',
      'cp "$TEMPLATE" "$OUT"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(script, 0o755);
  return {
    generator: {
      command: 'bash',
      args: [script, template, '{absolutePathToOutputImage}', '{prompt}'],
      maxInputImages: 2,
    },
    script,
    template,
  };
}
