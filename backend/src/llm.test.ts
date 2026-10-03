import { chatCompletion, extractImageRequests, extractPhotoRequests, labelHistory, parseSilence, stripNamePrefixes, systemPromptFor, translatePrompt, trimHistory } from './llm';
import { ChatMessage, Model } from './types';

function msg(text: string, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id: Math.random().toString(36), role, text, images: [], timestamp: Date.now() };
}

const model: Model = {
  name: 'test', // llmModels key (internal ID) that the chat references
  id: 'test-model', // id sent to the provider
  baseUrl: 'http://provider.test/v1',
  contextSize: 8192,
  supportsImages: true,
};

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('systemPromptFor', () => {
  it('includes the character name and description', () => {
    const out = systemPromptFor({ name: 'Alice', description: 'A kind fairy' });
    expect(out).toContain('Alice');
    expect(out).toContain('A kind fairy');
    expect(out).toContain('2–5 sentences');
    expect(out).toContain('/* ... */');
  });

  it('adds the selected user description when present', () => {
    const out = systemPromptFor(
      { name: 'Alice', description: 'A kind fairy' },
      { name: 'Bob', description: 'Engineer, likes brevity' },
    );
    expect(out).toContain('Bob');
    expect(out).toContain('Engineer, likes brevity');
  });

  it('does not add the interlocutor block without a description', () => {
    const out = systemPromptFor(
      { name: 'Alice', description: 'A kind fairy' },
      { name: 'You', description: '   ' },
    );
    expect(out).not.toContain('talking to');
  });

  it('the [IMG:...] instruction is added only when canGenerateImages', () => {
    const base = { name: 'Alice', description: '' };
    expect(systemPromptFor(base)).not.toContain('[IMG:');
    expect(systemPromptFor(base, null, true)).toContain('[IMG:');
    expect(systemPromptFor(base, null, true)).toContain('English');
    const withInv = systemPromptFor(base, null, true, '#1 — character photo');
    expect(withInv).toContain('[IMG:description | 1,3]');
    expect(withInv).toContain('#1 — character photo');
    expect(withInv).toContain('MUST');
  });

  it('group chat: lists the other characters and allows [SILENT]', () => {
    const base = { name: 'Alice', description: 'a fairy' };
    const out = systemPromptFor(base, null, false, undefined, [
      { name: 'Bob', description: 'a knight' },
    ]);
    expect(out).toContain('Bob');
    expect(out).toContain('[SILENT]');
    expect(out).toContain('Alice'); // replies only as itself
  });

  it('the [PHOTO:...] instruction and inventory work without a generator', () => {
    const base = { name: 'Alice', description: '' };
    expect(systemPromptFor(base)).not.toContain('[PHOTO:');
    const out = systemPromptFor(base, null, false, '#1 — character photo');
    expect(out).toContain('[PHOTO:');
    expect(out).toContain('#1 — character photo');
    expect(out).not.toContain('[IMG:');
  });

  it('without other characters the [SILENT] tag is not mentioned', () => {
    expect(systemPromptFor({ name: 'Alice', description: '' })).not.toContain('[SILENT]');
  });
});

describe('parseSilence', () => {
  it('exactly [SILENT] is silence (case and whitespace do not matter)', () => {
    expect(parseSilence('[SILENT]')).toBeNull();
    expect(parseSilence('  [silent]\n')).toBeNull();
  });

  it('a tag inside text is not silence and is removed', () => {
    expect(parseSilence('Let me think… [SILENT] Okay, I will reply.')).toBe('Let me think… Okay, I will reply.');
  });
});

describe('stripNamePrefixes', () => {
  const names = ['Bob', 'Carol'];

  it('strips a single and a repeated prefix of its own name', () => {
    expect(stripNamePrefixes('Carol: Hi!', names)).toBe('Hi!');
    expect(stripNamePrefixes('Carol: Carol: Hi!', names)).toBe('Hi!');
  });

  it('strips a copy of another prefix from the history', () => {
    expect(stripNamePrefixes('Bob: Bob: /*I noticed…*/', names)).toBe('/*I noticed…*/');
  });

  it('leaves text without a prefix and a name without a colon alone', () => {
    expect(stripNamePrefixes('Hi!', names)).toBe('Hi!');
    expect(stripNamePrefixes('Bob said: hi', names)).toBe('Bob said: hi');
    expect(stripNamePrefixes('Carla: hi', names)).toBe('Carla: hi');
  });

  it('an empty name list leaves the text as-is', () => {
    expect(stripNamePrefixes('Carol: hi', [])).toBe('Carol: hi');
  });
});

describe('labelHistory', () => {
  const characterNames = { c1: 'Alice', c2: 'Bob' };
  const userNames = { u1: 'Carol', u2: 'Dave' };

  it('labels the lines with authors in a group chat', () => {
    const history = [
      { ...msg('hi'), userId: 'u2' },
      { ...msg('greetings', 'assistant'), characterId: 'c2' },
      msg('how are you?'),
    ];
    const out = labelHistory(history, characterNames, userNames, true);
    expect(out[0].text).toBe('Dave: hi');
    expect(out[1].text).toBe('Bob: greetings');
    // Unknown author — the text is not changed
    expect(out[2].text).toBe('how are you?');
  });

  it('in a single-participant chat the history is not changed', () => {
    const history = [
      { ...msg('hi'), userId: 'u1' },
      { ...msg('hello', 'assistant'), characterId: 'c1' },
    ];
    expect(labelHistory(history, characterNames, userNames, false)).toEqual(history);
  });
});

describe('extractImageRequests', () => {
  it('removes the tags and returns prompts without references', () => {
    const { text, requests } = extractImageRequests(
      'Hi!\n[IMG: a fluffy cat, sunset] Here is what I drew.\n[IMG:night city]',
    );
    expect(text).toBe('Hi!\nHere is what I drew.');
    expect(requests).toEqual([
      { prompt: 'a fluffy cat, sunset', refs: [] },
      { prompt: 'night city', refs: [] },
    ]);
  });

  it('parses reference numbers in a tag', () => {
    const { text, requests } = extractImageRequests(
      'Here you go: [IMG: the same girl on the beach | 1, 3]. Another option: [IMG:a city at night |2]',
    );
    expect(text).toBe('Here you go: . Another option:');
    expect(requests).toEqual([
      { prompt: 'the same girl on the beach', refs: [1, 3] },
      { prompt: 'a city at night', refs: [2] },
    ]);
  });

  it('text without tags passes through as-is', () => {
    const { text, requests } = extractImageRequests('Just a message');
    expect(text).toBe('Just a message');
    expect(requests).toEqual([]);
  });

  it('a bare [IMG] tag without a colon and description is not a tag', () => {
    const { text, requests } = extractImageRequests(
      'Let me see what I have in stock.\n[IMG]',
    );
    expect(text).toBe('Let me see what I have in stock.\n[IMG]');
    expect(requests).toEqual([]);
  });
});

describe('extractPhotoRequests', () => {
  it('removes the tags and returns the image numbers', () => {
    const { text, photos } = extractPhotoRequests('Here: [PHOTO:2] a photo.\n[photo: 1, 3]');
    expect(text).toBe('Here: a photo.');
    expect(photos).toEqual([2, 1, 3]);
  });

  it('text without tags passes through as-is', () => {
    const { text, photos } = extractPhotoRequests('Just a message');
    expect(text).toBe('Just a message');
    expect(photos).toEqual([]);
  });

  it('a bare [PHOTO] without a number is not a tag', () => {
    const { text, photos } = extractPhotoRequests('Here are [PHOTO] and [PHOTO:] in the text.');
    expect(text).toBe('Here are [PHOTO] and [PHOTO:] in the text.');
    expect(photos).toEqual([]);
  });

  it('does not mix with the [IMG:...] tag', () => {
    const { text, photos } = extractPhotoRequests('[IMG:cat | 1] and [PHOTO:1]');
    expect(text).toBe('[IMG:cat | 1] and');
    expect(photos).toEqual([1]);
  });
});

describe('translatePrompt', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the request with the translation system instruction and returns the answer', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: 'a fluffy cat' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    // Russian input — the case the translation is for
    const out = await translatePrompt(model, 'пушистый кот');
    expect(out).toBe('a fluffy cat');
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0].content).toContain('English');
    expect(body.messages[1].content).toBe('пушистый кот');
  });
});

describe('trimHistory', () => {
  it('always keeps the first (system) message and the latest ones', () => {
    const system = msg('system', 'assistant');
    const history = [system, ...Array.from({ length: 12 }, (_, i) => msg('x'.repeat(4000) + i))];
    const trimmed = trimHistory(history, 2000);
    expect(trimmed[0]).toBe(system);
    expect(trimmed[trimmed.length - 1]).toBe(history[history.length - 1]);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed.length).toBeGreaterThanOrEqual(2);
  });

  it('does not trim a short history', () => {
    const history = [msg('hi'), msg('hello', 'assistant')];
    expect(trimHistory(history, 8192)).toHaveLength(2);
  });

  it('accounts for images in the size estimate', () => {
    const withImage: ChatMessage = { ...msg(''), images: ['a.png', 'b.png'] };
    const history = [msg('system', 'assistant'), ...Array.from({ length: 8 }, () => ({ ...withImage }))];
    const trimmed = trimHistory(history, 2000);
    expect(trimmed.length).toBeLessThan(history.length);
  });
});

describe('chatCompletion', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('retries the request with text when the provider rejected the image', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonRes(
          { error: { code: 500, message: 'image input is not supported - hint: provide the mmproj' } },
          500,
        ),
      )
      .mockResolvedValueOnce(jsonRes({ choices: [{ message: { content: 'a reply without a photo' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = [{ ...msg('what is on the photo?'), images: ['a.png'] }];
    const reply = await chatCompletion(model, 'system', history, 'chat-test');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reply).toContain('a reply without a photo');
    expect(reply).toContain('rejected the image');
    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    expect(retryInit.body).not.toContain('image_url');
  });

  it('appends the closing reminder to the end of the last user message', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCompletion(model, 'system', [msg('hi')], 'chat-test', "The next reply is Carol's line.");
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    // system first only: the reminder rides inside the last user message
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('hi\n[The next reply is Carol\'s line.]');
  });

  it('when the history ends with an assistant reply, the reminder is a separate user line', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCompletion(model, 'system', [msg('line', 'assistant')], 'chat-test', 'reminder');
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].role).toBe('user');
    expect(body.messages[2].content).toBe('[reminder]');
  });

  it('omits the model field when the model id is empty', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCompletion({ ...model, id: '' }, 'system', [msg('hi')], 'chat-test');
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
  });

  it('sends the reasoning level in both provider formats when it is set', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCompletion({ ...model, reasoning: 'high' }, 'system', [msg('hi')], 'chat-test');
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    // reasoning_effort — OpenAI/llama.cpp, reasoning.effort — OpenRouter.
    expect(body.reasoning_effort).toBe('high');
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('does not send the reasoning fields when the level is off', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCompletion({ ...model, reasoning: false }, 'system', [msg('hi')], 'chat-test');
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('does not retry the request on an ordinary provider error', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes({ error: { message: 'boom' } }, 500));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(chatCompletion(model, 'system', [msg('hi')], 'chat-test')).rejects.toThrow(
      'boom',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the original error when the retry also failed', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonRes({ error: { message: 'image input is not supported (mmproj missing)' } }, 500),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = [{ ...msg('photo'), images: ['a.png'] }];
    await expect(chatCompletion(model, 'system', history, 'chat-test')).rejects.toThrow(
      'mmproj',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the abort signal to the provider and does not retry on cancel', async () => {
    // The provider accepts the request and never answers until it is
    // aborted — like a slow model during a user cancel.
    const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) return Promise.reject(new Error('the signal must be passed to the provider'));
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const ctrl = new AbortController();
    const pending = chatCompletion(model, 'system', [msg('hi')], 'chat-test', undefined, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // the signal reached the provider, and a cancel is not retried
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('signal', ctrl.signal);
  });
});
