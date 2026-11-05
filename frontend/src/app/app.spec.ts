import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { vi } from 'vitest';
import { App } from './app';
import {
  AppConfig,
  ApiService,
  Chat,
  ChatMessage,
  Character,
  ChatSummary,
  User,
} from '../services/api';
import { InputPanel } from '../components/input-panel/input-panel';
import { MessageRow } from '../components/message-row/message-row';
import { TopBar } from '../components/top-bar/top-bar';
import { ChatSettingsDialog } from '../components/chat-settings-dialog/chat-settings-dialog';
import { ChatStore } from '../services/chat-store';
import { ConfigStore } from '../services/config-store';
import { ImageStore } from '../services/image-store';
import {
  DEFAULT_REASONING_LEVELS,
  chatLabelOf,
  chatHintOf,
  chatTimeOf,
  chatTitleOf,
  chatUserLabelOf,
  messageCountLabel,
  parseReasoningLevels,
  splitNarration,
} from '../services/helpers';
import { UiStore } from '../services/ui-store';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the app root', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app')).toBeTruthy();
  });
});

describe('chat labels (helpers.ts)', () => {
  it('the message count in the chat label', () => {
    expect(messageCountLabel(0)).toBe('0 messages');
    expect(messageCountLabel(1)).toBe('1 message');
    expect(messageCountLabel(2)).toBe('2 messages');
    expect(messageCountLabel(5)).toBe('5 messages');
    expect(messageCountLabel(11)).toBe('11 messages');
    expect(messageCountLabel(21)).toBe('21 messages');
    expect(messageCountLabel(22)).toBe('22 messages');
    expect(messageCountLabel(25)).toBe('25 messages');
    expect(messageCountLabel(101)).toBe('101 messages');
  });

  it('chat labels in the list: the character, the persona and the last message date', () => {
    const characters: Character[] = [{ id: 'c1', name: 'Alice', description: '' }];
    const users: User[] = [{ id: 'u1', name: 'Bob', description: '' }];
    const cs: ChatSummary = {
      id: 'ch1',
      createdAt: 0,
      characterIds: ['c1'],
      userId: 'u1',
      modelId: 'm1',
      messageCount: 5,
      lastMessageAt: 0,
    };
    expect(chatLabelOf(characters, cs)).toBe('Alice');
    expect(chatUserLabelOf(users, cs)).toBe('Bob');
    expect(chatTimeOf(cs)).toBe('');
    cs.lastMessageAt = new Date(2026, 8, 28, 19, 46).getTime();
    expect(chatTimeOf(cs)).toContain('28/09/2026');
    // several participants — the first + "+N" (the order = the reply priority)
    expect(chatLabelOf(characters, { ...cs, characterIds: ['c1', 'c2'] })).toBe('Alice +1');
    // unknown ids — fallbacks, does not break
    expect(chatLabelOf(characters, { ...cs, characterIds: ['nope'] })).toBe('nope');
    expect(chatUserLabelOf(users, { ...cs, userId: 'nope' })).toBe('—');
  });

  it('splitNarration: the /* ... */ descriptions are highlighted, the markers are removed', () => {
    expect(splitNarration('Hello. /*I sat at the bar.*/ How are you?')).toEqual([
      { text: 'Hello. ', narration: false },
      { text: 'I sat at the bar.', narration: true },
      { text: ' How are you?', narration: false },
    ]);
  });

  it('splitNarration: an unclosed /* stays regular text', () => {
    expect(splitNarration('broken /* tag')).toEqual([
      { text: 'broken /* tag', narration: false },
    ]);
  });
});

describe('reasoning levels (helpers.ts)', () => {
  it('an empty list falls back to the default set', () => {
    expect(parseReasoningLevels('')).toEqual(DEFAULT_REASONING_LEVELS);
    expect(parseReasoningLevels(' , , ')).toEqual(DEFAULT_REASONING_LEVELS);
  });

  it('parses the comma-separated levels, trimming whitespace', () => {
    expect(parseReasoningLevels('low, medium, high')).toEqual(['low', 'medium', 'high']);
    expect(parseReasoningLevels(' low ,, max ')).toEqual(['low', 'max']);
  });
});

describe('ImageStore — the background image generation', () => {
  // The regeneration/cancel requests are controlled manually: the test feeds
  // the "pending"/"failed" chat the server returns. The chat polling (while an
  // image is pending) runs on the 1500 ms interval, advanced with fake timers.
  // ImageStore applies the server chat through ChatStore.applyChat (the
  // one-way ImageStore -> ChatStore dependency).
  let resolveRegen!: (v: { chat: Chat }) => void;
  let rejectRegen!: (err: Error) => void;
  let cancelResolve!: (v: { chat: Chat }) => void;
  let getChatCalls = 0;
  const fakeApi = {
    getConfig: () => Promise.resolve({ llmModels: {} }),
    imageStatus: () => Promise.resolve({ available: false }),
    getCharacters: () => Promise.resolve([]),
    getUsers: () => Promise.resolve([]),
    getChats: () => Promise.resolve([]),
    mediaUrl: (id: string) => `http://localhost:3000/api/media?path=${encodeURIComponent(id)}`,
    // The polling: the first read still returns the pending chat, the next
    // one — the ready one (so the timer stops).
    getChat: () => {
      getChatCalls += 1;
      return Promise.resolve(getChatCalls <= 1 ? pendingChat : readyChat);
    },
    regenerateImage: () =>
      new Promise<{ chat: Chat }>((res, rej) => {
        resolveRegen = res;
        rejectRegen = rej;
      }),
    cancelImage: () =>
      new Promise<{ chat: Chat }>((res) => {
        cancelResolve = res;
      }),
  };

  const baseChat: Chat = {
    id: 'chat-1',
    createdAt: 0,
    characterIds: ['char-1'],
    userId: 'user-1',
    modelId: 'model-1',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        text: 'an image',
        images: ['img-1.png'],
        timestamp: 1,
      },
    ],
  };
  const pendingChat: Chat = {
    ...baseChat,
    messages: [
      { ...baseChat.messages[0], imageStatus: { 'img-1.png': 'pending' as const } },
    ],
  };
  const readyChat: Chat = {
    ...baseChat,
    messages: [baseChat.messages[0]],
  };

  beforeEach(async () => {
    getChatCalls = 0;
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: ApiService, useValue: fakeApi }],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the server chat (the image becomes "pending") and polls until it is ready', async () => {
    const fixture = TestBed.createComponent(App);
    const imageStore = fixture.componentInstance.imageStore;
    const chatStore = fixture.componentInstance.chatStore;
    const imgStatus = () => chatStore.chat()?.messages[0].imageStatus?.['img-1.png'];
    chatStore.chat.set(baseChat);

    const p = imageStore.regenerateImage('msg-1', 'img-1.png');
    resolveRegen({ chat: pendingChat });
    await p;
    expect(imgStatus()).toBe('pending');

    // First poll (1500 ms) still sees the image pending.
    await vi.advanceTimersByTimeAsync(1500);
    expect(getChatCalls).toBe(1);
    expect(imgStatus()).toBe('pending');

    // Second poll picks up the ready chat and the timer stops.
    await vi.advanceTimersByTimeAsync(1500);
    expect(getChatCalls).toBe(2);
    expect(chatStore.chat()?.messages[0].imageStatus).toBeUndefined();

    // No pending images left — no further reads.
    await vi.advanceTimersByTimeAsync(3000);
    expect(getChatCalls).toBe(2);
  });

  it('cancelImage applies the server chat (the image becomes the "broken" one)', async () => {
    const fixture = TestBed.createComponent(App);
    const imageStore = fixture.componentInstance.imageStore;
    const chatStore = fixture.componentInstance.chatStore;
    const ui = TestBed.inject(UiStore);
    chatStore.chat.set(pendingChat);

    imageStore.cancelImage('msg-1', 'img-1.png');
    const failedChat: Chat = {
      ...baseChat,
      messages: [
        {
          ...baseChat.messages[0],
          imageStatus: { 'img-1.png': 'failed' as const },
          imageErrors: { 'img-1.png': 'Generation cancelled' },
        },
      ],
    };
    cancelResolve({ chat: failedChat });
    await vi.advanceTimersByTimeAsync(0);

    expect(chatStore.chat()?.messages[0].imageStatus?.['img-1.png']).toBe('failed');
    expect(chatStore.chat()?.messages[0].imageErrors?.['img-1.png']).toBe('Generation cancelled');
    expect(ui.error()).toBe('');
    // No pending images — the polling timer does not start.
    await vi.advanceTimersByTimeAsync(3000);
    expect(getChatCalls).toBe(0);
  });

  it('an image whose generation failed stays "failed" (no polling runs)', async () => {
    const fixture = TestBed.createComponent(App);
    const chatStore = fixture.componentInstance.chatStore;
    const failedChat: Chat = {
      ...baseChat,
      messages: [
        {
          ...baseChat.messages[0],
          imageStatus: { 'img-1.png': 'failed' as const },
          imageErrors: { 'img-1.png': 'boom' },
        },
      ],
    };
    chatStore.chat.set(failedChat);
    await vi.advanceTimersByTimeAsync(3000);
    expect(getChatCalls).toBe(0);
    expect(chatStore.chat()?.messages[0].imageStatus?.['img-1.png']).toBe('failed');
  });

  it('a failed regenerateImage request surfaces the error banner', async () => {
    const fixture = TestBed.createComponent(App);
    const imageStore = fixture.componentInstance.imageStore;
    const chatStore = fixture.componentInstance.chatStore;
    const ui = TestBed.inject(UiStore);
    chatStore.chat.set(baseChat);

    const p = imageStore.regenerateImage('msg-1', 'img-1.png');
    rejectRegen(new Error('boom'));
    await p;

    expect(ui.error()).toBe('boom');
  });
});

describe('InputPanel — message editing', () => {
  // An image is addressed by its id (a path relative to the data folder) and
  // served through the media route.
  const mediaUrl = (id: string) => `http://localhost:3000/api/media?path=${encodeURIComponent(id)}`;
  let store: ChatStore;

  beforeEach(async () => {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [InputPanel],
      providers: [
        {
          provide: ApiService,
          useValue: {
            getConfig: () => Promise.resolve({ llmModels: {} }),
            imageStatus: () => Promise.resolve({ available: false }),
            getCharacters: () => Promise.resolve([]),
            getUsers: () => Promise.resolve([]),
            getChats: () => Promise.resolve<ChatSummary[]>([]),
            mediaUrl,
          },
        },
      ],
    }).compileComponents();
    store = TestBed.inject(ChatStore);
  });

  function fixtureWith(
    message: ChatMessage,
  ): { fixture: ComponentFixture<InputPanel>; el: HTMLElement } {
    const fixture = TestBed.createComponent(InputPanel);
    fixture.detectChanges();
    store.chat.set({
      id: 'chat-1',
      createdAt: 0,
      characterIds: ['c1'],
      userId: 'u1',
      modelId: 'm1',
      messages: [message],
    });
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('startEdit substitutes the text only: the message picture is not re-attached', async () => {
    const { fixture, el } = fixtureWith({
      id: 'msg-1',
      role: 'user',
      kind: 'image',
      text: 'a red boat on the lake',
      images: ['chat-1/files/a-red-boat-1a2b3c.png'],
      timestamp: 1,
    });

    store.startEdit(store.chat()!.messages[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    // The field carries text: editing a card corrects its description, the
    // picture itself stays where it is (no thumbnail to re-post).
    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('a red boat on the lake');
    expect(store.pendingImages()).toEqual([]);
    expect(el.querySelector('.pending')).toBeNull();
  });

  it('an attachment is previewed: a fresh data URL as-is, an existing picture through the media route', async () => {
    const { fixture, el } = fixtureWith({
      id: 'msg-1',
      role: 'user',
      text: 'hi',
      images: [],
      timestamp: 1,
    });
    store.onImagesAdded(['data:image/png;base64,aGVsbG8=', 'chat-1/files/a-red-boat-1a2b3c.png']);
    fixture.detectChanges();
    await fixture.whenStable();

    const imgs = el.querySelectorAll<HTMLElement>('.pending .pending-thumb img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(imgs[1].getAttribute('src')).toBe(mediaUrl('chat-1/files/a-red-boat-1a2b3c.png'));
  });

  it('cancelEdit clears the field and the attached list', async () => {
    const { fixture, el } = fixtureWith({
      id: 'msg-1',
      role: 'user',
      text: 'hello',
      images: ['img-1.png'],
      timestamp: 1,
    });

    store.startEdit(store.chat()!.messages[0]);
    store.onImagesAdded(['data:image/png;base64,aGVsbG8=']);
    fixture.detectChanges();
    await fixture.whenStable();

    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('hello');
    expect(store.pendingImages()).toHaveLength(1);

    store.cancelEdit();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(ta.value).toBe('');
    expect(store.pendingImages()).toEqual([]);
    expect(el.querySelector('[data-testid=edit-bar]')).toBeNull();
  });

  // The bug this guards: while editing, an image-generation poll (or a reply)
  // re-applies the chat — the edit effect must NOT re-read the (still-unchanged)
  // message text from it and reset the field. The user keeps whatever they type.
  it('a chat refresh while editing does not reset the typed text', async () => {
    const { fixture, el } = fixtureWith({
      id: 'msg-1',
      role: 'user',
      text: 'original',
      images: [],
      timestamp: 1,
    });

    store.startEdit(store.chat()!.messages[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'edited text';
    expect(ta.value).toBe('edited text');

    // The server re-applies the chat — the message is still unedited server-side,
    // a brand-new conversation object (like an image-generation poll would return).
    store.applyChat({
      ...store.chat()!,
      messages: [{ id: 'msg-1', role: 'user', text: 'original', images: [], timestamp: 1 }],
    });
    fixture.detectChanges();
    await fixture.whenStable();

    // The field must keep the in-progress edit, not snap back to the original.
    expect(ta.value).toBe('edited text');
  });

  // The bug this guards: while a reply was generating the button was the
  // cancel (✕), so editing an existing message and pressing it aborted the
  // generation instead of saving the edit. Editing must win: the button is ✓
  // and saves (PATCH), the in-flight generation keeps running untouched.
  it('saves the edit while a reply is generating (button = ✓, no cancel)', async () => {
    const api = TestBed.inject(ApiService) as unknown as {
      patchMessage: (chatId: string, messageId: string, body: unknown) => Promise<{ chat: Chat }>;
    };
    let patched: { chatId: string; messageId: string; body: unknown } | null = null;
    api.patchMessage = (chatId: string, messageId: string, body: unknown) => {
      patched = { chatId, messageId, body };
      const c = store.chat()!;
      return Promise.resolve({
        chat: {
          ...c,
          messages: c.messages.map((m) =>
            m.id === messageId ? { ...m, ...(body as Partial<ChatMessage>) } : m,
          ),
        },
      });
    };

    const { fixture, el } = fixtureWith({
      id: 'msg-1',
      role: 'user',
      text: 'old text',
      images: [],
      timestamp: 1,
    });

    store.sending.set(true);
    store.startEdit(store.chat()!.messages[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    const btn = el.querySelector('[data-testid=send]') as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe('✓');
    expect(btn.classList.contains('cancel')).toBe(false);

    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'edited while generating';
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(patched).not.toBeNull();
    // The PATCH carries the text alone — the pictures are separate messages.
    expect(patched!.body).toEqual({ text: 'edited while generating' });
    // cancelGeneration was NOT called — the generation is still running.
    expect(store.sending()).toBe(true);
    expect(store.editTargetId()).toBeNull();
  });
});

describe('ChatStore — empty send ("another message from the AI")', () => {
  const baseChat: Chat = {
    id: 'chat-1',
    createdAt: 0,
    characterIds: ['char-1'],
    userId: 'user-1',
    modelId: 'model-1',
    messages: [{ id: 'msg-1', role: 'user', text: 'hello', images: [], timestamp: 1 }],
  };

  async function setup(nextReply: (id: string, characterId: string) => Promise<{ chat: Chat; reply: ChatMessage | null }>) {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [
        {
          provide: ApiService,
          useValue: {
            nextReply,
            getChat: () => Promise.resolve(baseChat),
            getConfig: () => Promise.resolve({ llmModels: {} }),
            imageStatus: () => Promise.resolve({ available: false }),
            getCharacters: () => Promise.resolve([]),
            getUsers: () => Promise.resolve([]),
            getChats: () => Promise.resolve([]),
          },
        },
      ],
    }).compileComponents();
    const store = TestBed.inject(ChatStore);
    store.chat.set(baseChat);
    return store;
  }

  // The "deleted the last AI reply (🗑) and pressed the empty send" scenario:
  // only the user message is left in the history — the model must
  // answer it, like on a normal send.
  it('an empty send after deleting the AI reply answers the last user message', async () => {
    let resolveNext!: (v: { chat: Chat; reply: ChatMessage | null }) => void;
    const nextReply = () =>
      new Promise<{ chat: Chat; reply: ChatMessage | null }>((res) => {
        resolveNext = res;
      });
    const store = await setup(nextReply);

    const ok = store.send('   ');
    expect(ok).toBe(true);
    expect(store.sending()).toBe(true);
    expect(store.typingCharacterId()).toBe('char-1');

    const reply: ChatMessage = {
      id: 'msg-2',
      role: 'assistant',
      text: 'continuing…',
      images: [],
      timestamp: 2,
    };
    resolveNext({
      chat: { ...baseChat, messages: [...baseChat.messages, reply] },
      reply,
    });
    // flushable: wait for the end of the reply queue.
    await new Promise((r) => setTimeout(r, 0));

    expect(store.sending()).toBe(false);
    expect(store.typingCharacterId()).toBeNull();
    expect(store.chat()?.messages[store.chat()!.messages.length - 1]).toEqual(reply);
  });

  it('an empty send in an empty chat does not start the reply queue but shows an error', async () => {
    let called = 0;
    const store = await setup(() => {
      called += 1;
      return Promise.resolve({ chat: baseChat, reply: null });
    });
    const ui = TestBed.inject(UiStore);
    store.chat.set({ ...baseChat, messages: [] });

    const ok = store.send('');
    expect(ok).toBe(false);
    expect(called).toBe(0);
    expect(ui.error()).toBe('Write something to start the conversation');
  });
});

describe('ChatStore — canceling the generation', () => {
  const baseChat: Chat = {
    id: 'chat-1',
    createdAt: 0,
    characterIds: ['char-1', 'char-2'],
    userId: 'user-1',
    modelId: 'model-1',
    messages: [{ id: 'msg-1', role: 'user', text: 'hello', images: [], timestamp: 1 }],
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function setup(
    nextReply: (
      id: string,
      characterId: string,
      signal?: AbortSignal,
    ) => Promise<{ chat: Chat; reply: ChatMessage | null }>,
  ) {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [
        {
          provide: ApiService,
          useValue: {
            nextReply,
            postMessage: () => Promise.resolve({ chat: baseChat }),
            cancelReply: () => Promise.resolve({ chat: baseChat }),
            getChat: () => Promise.resolve(baseChat),
            getConfig: () => Promise.resolve({ llmModels: {} }),
            imageStatus: () => Promise.resolve({ available: false }),
            getCharacters: () => Promise.resolve([]),
            getUsers: () => Promise.resolve([]),
            getChats: () => Promise.resolve<ChatSummary[]>([]),
          },
        },
      ],
    }).compileComponents();
    const store = TestBed.inject(ChatStore);
    store.chat.set(baseChat);
    return store;
  }

  it('cancelGeneration aborts the in-flight reply, stops the queue, no error banner', async () => {
    const signals: AbortSignal[] = [];
    const store = await setup((id, characterId, signal) => {
      if (signal) signals.push(signal);
      return new Promise(() => {}); // the reply never comes (a slow model)
    });

    expect(store.send('hello')).toBe(true);
    expect(store.sending()).toBe(true);
    await tick();
    expect(store.typingCharacterId()).toBe('char-1');
    expect(signals).toHaveLength(1);

    store.cancelGeneration();

    expect(store.sending()).toBe(false);
    expect(store.typingCharacterId()).toBeNull();
    expect(signals[0].aborted).toBe(true);

    // The queue is over: no request for the second character was started,
    // and a cancel is not an error (no banner).
    await tick();
    expect(signals).toHaveLength(1);
    expect(TestBed.inject(UiStore).error()).toBe('');
  });

  it('a send after a cancel starts a fresh generation', async () => {
    let call = 0;
    const reply: ChatMessage = {
      id: 'msg-2',
      role: 'assistant',
      characterId: 'char-1',
      text: 'hi',
      images: [],
      timestamp: 2,
    };
    const replyChat: Chat = { ...baseChat, messages: [...baseChat.messages, reply] };
    const store = await setup((id, characterId) => {
      call += 1;
      if (call === 1) return new Promise(() => {}); // the first one hangs
      // the second send: char-1 answers, char-2 stays silent — the queue ends
      return Promise.resolve({
        chat: replyChat,
        reply: characterId === 'char-1' ? reply : null,
      });
    });

    store.send('hello');
    await tick();
    expect(store.sending()).toBe(true);
    store.cancelGeneration();
    await tick();
    expect(store.sending()).toBe(false);

    expect(store.send('again')).toBe(true);
    await tick();
    // the whole queue (2 participants) is done
    expect(store.sending()).toBe(false);
    expect(store.typingCharacterId()).toBeNull();
    expect(store.chat()?.messages.at(-1)).toEqual(reply);
  });
});

describe('ConfigStore — the entity CRUD (models / characters / users)', () => {
  // The requests are recorded; the fake answers with the sent payload, so the
  // store signals mirror the last request (like the real server).
  let lastConfig: AppConfig | undefined;
  let lastCharacters: Character[] | undefined;
  let lastUsers: User[] | undefined;
  const cloneCalls: string[] = [];
  const fakeApi = {
    putConfig: (cfg: AppConfig) => {
      lastConfig = cfg;
      return Promise.resolve(cfg);
    },
    putCharacters: (chars: Character[]) => {
      lastCharacters = chars;
      return Promise.resolve(chars);
    },
    putUsers: (users: User[]) => {
      lastUsers = users;
      return Promise.resolve(users);
    },
    cloneCharacter: (id: string) => {
      cloneCalls.push('character:' + id);
      const chars = lastCharacters ?? [];
      const src = chars.find((c) => c.id === id);
      const copy: Character = {
        id: id + '-copy',
        name: (src?.name ?? '?') + ' (copy)',
        description: src?.description ?? '',
      };
      return Promise.resolve({ id: copy.id, characters: [...chars, copy] });
    },
    cloneUser: (id: string) => {
      cloneCalls.push('user:' + id);
      const users = lastUsers ?? [];
      const src = users.find((u) => u.id === id);
      const copy: User = {
        id: id + '-copy',
        name: (src?.name ?? '?') + ' (copy)',
        description: src?.description ?? '',
      };
      return Promise.resolve({ id: copy.id, users: [...users, copy] });
    },
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    lastConfig = undefined;
    lastCharacters = undefined;
    lastUsers = undefined;
    cloneCalls.length = 0;
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: fakeApi }],
    }).compileComponents();
  });

  it('model: create, rename, delete and clone (a unique " copy" name)', async () => {
    const store = TestBed.inject(ConfigStore);
    store.config.set({
      listen: '0.0.0.0:3210',
      llmModels: { old: { id: 'o', baseUrl: 'http://x', contextSize: 100, supportsImages: false } },
      imageGenerators: [],
    });

    store.saveModel(null, 'new', { id: 'n', baseUrl: 'http://y', contextSize: 200, supportsImages: true });
    await tick();
    expect(Object.keys(lastConfig!.llmModels).sort()).toEqual(['new', 'old']);

    // a name change renames the entry (the old key disappears)
    store.saveModel('old', 'renamed', { id: 'o2', baseUrl: 'http://x', contextSize: 100, supportsImages: false });
    await tick();
    expect(Object.keys(lastConfig!.llmModels).sort()).toEqual(['new', 'renamed']);

    store.deleteModel('new');
    await tick();
    expect(Object.keys(lastConfig!.llmModels)).toEqual(['renamed']);

    store.cloneModel('renamed');
    await tick();
    expect(Object.keys(lastConfig!.llmModels).sort()).toEqual(['renamed', 'renamed copy']);

    // the next clone gets the next free name
    store.cloneModel('renamed');
    await tick();
    expect(Object.keys(lastConfig!.llmModels).sort()).toEqual(['renamed', 'renamed copy', 'renamed copy 2']);
  });

  it('character: create, update, delete and clone (the full list sync)', async () => {
    const store = TestBed.inject(ConfigStore);
    store.characters.set([
      { id: 'a', name: 'A', description: '' },
      { id: 'b', name: 'B', description: '' },
    ]);

    // create: the id is generated here
    store.saveCharacter(null, 'C', 'desc');
    await tick();
    expect(lastCharacters!.map((c) => c.name).sort()).toEqual(['A', 'B', 'C']);
    const created = lastCharacters!.find((c) => c.name === 'C')!;
    expect(created.id).toMatch(/^c\d+$/);

    store.saveCharacter('a', 'A2', 'new desc');
    await tick();
    expect(lastCharacters!.find((c) => c.id === 'a')).toEqual({
      id: 'a',
      name: 'A2',
      description: 'new desc',
    });

    store.deleteCharacter('b');
    await tick();
    expect(lastCharacters!.map((c) => c.id)).toEqual(['a', created.id]);

    const cloned = store.cloneCharacter('a');
    await tick();
    expect(cloneCalls).toEqual(['character:a']);
    // resolves with the copy's id and updates the list
    expect(await cloned).toBe('a-copy');
    expect(store.characters().map((c) => c.id)).toEqual(['a', created.id, 'a-copy']);
  });

  it('user: create, delete and clone (the full list sync)', async () => {
    const store = TestBed.inject(ConfigStore);
    store.users.set([{ id: 'u1', name: 'U1', description: '' }]);

    store.saveUser(null, 'U2', '');
    await tick();
    expect(lastUsers!.map((u) => u.name).sort()).toEqual(['U1', 'U2']);
    const created = lastUsers!.find((u) => u.name === 'U2')!;
    expect(created.id).toMatch(/^u\d+$/);

    store.deleteUser('u1');
    await tick();
    expect(lastUsers!.map((u) => u.id)).toEqual([created.id]);

    const cloned = store.cloneUser(created.id);
    await tick();
    expect(cloneCalls).toEqual(['user:' + created.id]);
    // resolves with the copy's id and updates the list
    expect(await cloned).toBe(created.id + '-copy');
    expect(store.users().map((u) => u.id)).toEqual([created.id, created.id + '-copy']);
  });
});

// ---- the picture of the user's turn (the 📷 button) ----

const fakeApiForTurnButton = (overrides: Record<string, unknown> = {}) => ({
  getConfig: () => Promise.resolve({ llmModels: {} }),
  imageStatus: () => Promise.resolve({ available: true }),
  getCharacters: () => Promise.resolve([]),
  getUsers: () => Promise.resolve([]),
  getChats: () => Promise.resolve<ChatSummary[]>([]),
  mediaUrl: (id: string) => `http://localhost:3000/api/media?path=${encodeURIComponent(id)}`,
  ...overrides,
});

// A chat of the 📷 / title tests. The creation date is fixed so the default
// title is a known string ("03.08.2026, 12:00").
const CHAT_CREATED_AT = new Date(2026, 7, 3, 12, 0).getTime();
const turnChat = (messages: ChatMessage[]): Chat => ({
  id: 'chat-1',
  createdAt: CHAT_CREATED_AT,
  characterIds: ['c1'],
  userId: 'u1',
  modelId: 'm1',
  messages,
});
const assistantLine: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  kind: 'text',
  characterId: 'c1',
  text: 'a line of the character',
  images: [],
  timestamp: 2,
};
const userLine: ChatMessage = {
  id: 'u1',
  role: 'user',
  kind: 'text',
  userId: 'u1',
  text: 'mine',
  images: [],
  timestamp: 1,
};

describe('ChatStore.isUserTurn — when the 📷 button belongs', () => {
  beforeEach(async () => {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [InputPanel],
      providers: [{ provide: ApiService, useValue: fakeApiForTurnButton() }],
    }).compileComponents();
  });

  function storeWith(chat: Chat, sending = false): ChatStore {
    const store = TestBed.inject(ChatStore);
    store.chat.set(chat);
    store.sending.set(sending);
    TestBed.inject(ConfigStore).imageGenAvailable.set(true);
    return store;
  }

  it('true after the characters answered, false while they still do or the user has the last word', () => {
    const store = TestBed.inject(ChatStore);
    store.chat.set(turnChat([]));
    expect(store.isUserTurn()).toBe(false); // nothing said yet — no turn to draw for

    storeWith(turnChat([userLine, assistantLine]));
    expect(store.isUserTurn()).toBe(true);

    // the characters are still answering
    storeWith(turnChat([userLine, assistantLine]), true);
    expect(store.isUserTurn()).toBe(false);

    // the last line is the user's (their own message, or a card they attached)
    store.chat.set(turnChat([assistantLine, userLine]));
    expect(store.isUserTurn()).toBe(false);
    store.chat.set(
      turnChat([
        assistantLine,
        { id: 'card', role: 'user', kind: 'image', userId: 'u1', text: 'a picture', images: ['x.png'], timestamp: 3 },
      ]),
    );
    expect(store.isUserTurn()).toBe(false);

    // a failed reply is not "the characters had their say"
    store.chat.set(turnChat([userLine, { ...assistantLine, error: true }]));
    expect(store.isUserTurn()).toBe(false);
  });

  it('the button asks the server to draw the picture of the turn and applies the placeholder chat back', async () => {
    const api = TestBed.inject(ApiService) as unknown as {
      autoImage: (chatId: string) => Promise<{ chat: Chat }>;
    };
    let asked = '';
    const placeholderChat = turnChat([
      userLine,
      assistantLine,
      {
        id: 'card-1',
        role: 'user',
        kind: 'image',
        userId: 'u1',
        text: '',
        images: ['chat-1/files/a-picture-for-the-conversation-1a2b3c.png'],
        generation: { source: 'auto', model: 'm1' },
        imageStatus: { 'chat-1/files/a-picture-for-the-conversation-1a2b3c.png': 'pending' as const },
        timestamp: 3,
      },
    ]);
    api.autoImage = (chatId: string) => {
      asked = chatId;
      return Promise.resolve({ chat: placeholderChat });
    };

    const store = storeWith(turnChat([userLine, assistantLine]));
    const fixture = TestBed.createComponent(InputPanel);
    fixture.detectChanges();
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector('[data-testid=auto-image]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(asked).toBe('chat-1');
    // the placeholder card is in the history right away, generating in the
    // background — the input stays usable
    const messages = store.chat()!.messages;
    expect(messages[messages.length - 1].kind).toBe('image');
    expect(el.querySelector('[data-testid=input]')).toBeTruthy();
  });

  it('no 📷 when there is no generator to draw with', async () => {
    const store = storeWith(turnChat([userLine, assistantLine]));
    TestBed.inject(ConfigStore).imageGenAvailable.set(false);
    const fixture = TestBed.createComponent(InputPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid=auto-image]')).toBeNull();
    // and the action itself refuses without a chat of its own
    store.chat.set(null);
    expect(() => TestBed.inject(ImageStore).requestTurnImage()).not.toThrow();
  });
});

describe('MessageRow — the image card', () => {
  const mediaUrl = (id: string) => `http://localhost:3000/api/media?path=${encodeURIComponent(id)}`;
  const cardImage = 'chat-1/files/a-red-boat-at-dusk-1a2b3c.png';

  beforeEach(async () => {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [MessageRow],
      providers: [{ provide: ApiService, useValue: fakeApiForTurnButton() }],
    }).compileComponents();
  });

  function renderMessage(message: ChatMessage): { fixture: ComponentFixture<MessageRow>; el: HTMLElement } {
    const fixture = TestBed.createComponent(MessageRow);
    fixture.componentRef.setInput('message', message);
    fixture.componentRef.setInput('isLast', false);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows the picture by its id, its description, the prompt it was drawn from and its references', () => {
    const { el } = renderMessage({
      id: 'card-1',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: 'a red boat on a calm lake at dusk',
      images: [cardImage],
      generation: { prompt: 'a red boat, the sky orange', refs: ['chat-1/files/a-harbour-9f8e7d.png'], source: 'auto' },
      timestamp: 3,
    });

    const img = el.querySelector('.card-body img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(mediaUrl(cardImage));
    expect(el.querySelector('[data-testid=card-caption]')?.textContent?.trim()).toBe(
      'a red boat on a calm lake at dusk',
    );
    expect(el.querySelector('[data-testid=card-prompt]')?.textContent?.trim()).toBe('a red boat, the sky orange');
    expect(el.querySelector('[data-testid=card-refs]')?.textContent).toContain('references: 1');
    // a drawn picture can be redrawn and its prompt changed
    expect(el.querySelector('[data-testid=img-regenerate]')).toBeTruthy();
    expect(el.querySelector('[data-testid=img-edit-prompt]')).toBeTruthy();
    expect(el.querySelector('[data-testid=img-replace]')).toBeTruthy();
  });

  it('an uploaded photo has no prompt, so it offers no redraw — only the replace', () => {
    const { el } = renderMessage({
      id: 'card-2',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: 'my own photo',
      images: ['chat-1/files/my-photo-1a2b3c.jpg'],
      generation: { source: 'upload' },
      timestamp: 3,
    });
    expect(el.querySelector('[data-testid=card-prompt]')).toBeNull();
    expect(el.querySelector('[data-testid=card-refs]')).toBeNull();
    expect(el.querySelector('[data-testid=img-regenerate]')).toBeNull();
    expect(el.querySelector('[data-testid=img-edit-prompt]')).toBeNull();
    expect(el.querySelector('[data-testid=img-replace]')).toBeTruthy();
  });

  it('a pending auto picture says it is being planned and drawn, and can be cancelled', () => {
    const { el } = renderMessage({
      id: 'card-3',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: '',
      images: [cardImage],
      generation: { source: 'auto', model: 'm1' },
      imageStatus: { [cardImage]: 'pending' as const },
      timestamp: 3,
    });
    expect(el.querySelector('[data-testid=img-pending]')).toBeTruthy();
    expect(el.querySelector('.img-placeholder-label')?.textContent).toContain('Planning and drawing');
    expect(el.querySelector('[data-testid=img-cancel]')).toBeTruthy();
    // no caption yet — nothing was agreed about the picture
    expect(el.querySelector('[data-testid=card-caption]')).toBeNull();
  });

  it('a manual pending picture is just "generating", and a failed one offers a redraw', () => {
    const pending = renderMessage({
      id: 'card-4',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: '',
      images: [cardImage],
      generation: { prompt: 'a red fox', source: 'manual' },
      imageStatus: { [cardImage]: 'pending' as const },
      timestamp: 3,
    });
    expect(pending.el.querySelector('.img-placeholder-label')?.textContent).toContain('Generating');
    expect(pending.el.querySelector('.img-placeholder-label')?.textContent).not.toContain('Planning');

    const failed = renderMessage({
      id: 'card-5',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: '',
      images: [cardImage],
      generation: { prompt: 'a red fox', source: 'manual' },
      imageStatus: { [cardImage]: 'failed' as const },
      imageErrors: { [cardImage]: 'GPU exploded' },
      timestamp: 3,
    });
    expect(failed.el.querySelector('[data-testid=img-broken]')).toBeTruthy();
    expect(failed.el.querySelector('[data-testid=img-regen]')).toBeTruthy();
    expect(failed.el.querySelector('.img-error-text')?.textContent).toBe('GPU exploded');
  });

  it('a text message is still a plain bubble: no card, no picture buttons', () => {
    const { el } = renderMessage({
      id: 'msg-1',
      role: 'assistant',
      kind: 'text',
      characterId: 'c1',
      text: 'just words',
      images: [],
      timestamp: 1,
    });
    expect(el.querySelector('[data-testid=image-card]')).toBeNull();
    expect(el.querySelector('.msg-text')?.textContent).toContain('just words');
  });
});

// Toggling a character out of a chat is a reply-queue decision: it must not
// touch the history it already wrote.
describe('MessageRow — an author that is no longer a participant', () => {
  const alice: Character = { id: 'c1', name: 'Alice', description: '', hasAvatar: false };
  const bob: Character = { id: 'c2', name: 'Bob', description: '', hasAvatar: true };

  beforeEach(async () => {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [MessageRow],
      providers: [
        {
          provide: ApiService,
          useValue: fakeApiForTurnButton({
            getCharacters: () => Promise.resolve([alice, bob]),
            characterAvatarUrl: (id: string) => 'avatar-of-' + id,
          }),
        },
      ],
    }).compileComponents();
  });

  function renderAuthorLine(message: ChatMessage): HTMLElement {
    const chatStore = TestBed.inject(ChatStore);
    // Bob was switched out of the chat — Alice is its only participant.
    chatStore.chat.set({ ...turnChat([message]), characterIds: ['c1'] });
    TestBed.inject(ConfigStore).characters.set([alice, bob]);

    const fixture = TestBed.createComponent(MessageRow);
    fixture.componentRef.setInput('message', message);
    fixture.componentRef.setInput('isLast', false);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('keeps its name and avatar in the history', () => {
    const el = renderAuthorLine({ ...assistantLine, characterId: 'c2', text: 'a line of Bob' });
    expect(el.querySelector('[data-testid=msg-sender]')?.textContent).toBe('Bob');
    expect(el.querySelector('.avatar img')?.getAttribute('src')).toBe('avatar-of-c2');

    // the current participant is unaffected by the lookup change
    const aliceEl = renderAuthorLine({ ...assistantLine, text: 'a line of Alice' });
    expect(aliceEl.querySelector('[data-testid=msg-sender]')?.textContent).toBe('Alice');
    // no avatar file for Alice → the letter of her name, not 'M'
    expect(aliceEl.querySelector('.avatar img')).toBeNull();
    expect(aliceEl.querySelector('.avatar')?.textContent?.trim()).toBe('A');
  });

  it('the participant list still drives who answers next (only the display is catalog-wide)', () => {
    const chatStore = TestBed.inject(ChatStore);
    chatStore.chat.set({ ...turnChat([assistantLine]), characterIds: ['c1'] });
    TestBed.inject(ConfigStore).characters.set([alice, bob]);

    expect(chatStore.chatCharacters().map((c) => c.id)).toEqual(['c1']);
    expect(chatStore.characterOf('c2')?.name).toBe('Bob');
    expect(chatStore.characterNameOf('c2')).toBe('Bob');
    // a character that is gone from the catalog entirely has no name to show
    expect(chatStore.characterOf('gone')).toBeNull();
    expect(chatStore.characterNameOf('gone')).toBe('Model');
  });
});

// ---- the chat name (the header title) and cloning a chat ----

describe('chatTitleOf (helpers.ts)', () => {
  const created = new Date(2026, 7, 3, 12, 0).getTime();

  it('the name wins, the creation date is the default name', () => {
    expect(chatTitleOf({ name: 'Road trip', createdAt: created })).toBe('Road trip');
    expect(chatTitleOf({ createdAt: created })).toContain('03/08/2026');
    expect(chatTitleOf({ createdAt: created })).toContain('12:00');
  });

  it('a blank name is no name, and a row without a creation date falls back to its last message', () => {
    expect(chatTitleOf({ name: '   ', createdAt: created })).toContain('03/08/2026');
    expect(chatTitleOf({ createdAt: 0, lastMessageAt: created })).toContain('03/08/2026');
    expect(chatTitleOf({})).toBe('');
  });
});

describe('chatHintOf (helpers.ts)', () => {
  const characters: Character[] = [
    { id: 'c1', name: 'Alice', description: '' },
    { id: 'c2', name: 'Bob', description: '' },
  ];
  const users: User[] = [{ id: 'u1', name: 'Carol', description: '' }];
  const base: ChatSummary = {
    id: 'ch1',
    createdAt: 0,
    characterIds: ['c1'],
    userId: 'u1',
    modelId: 'm1',
    messageCount: 3,
    lastMessageAt: 0,
  };

  it('the characters, the persona and the last message date', () => {
    const cs = { ...base, lastMessageAt: new Date(2026, 8, 28, 19, 46).getTime() };
    expect(chatHintOf(characters, users, cs)).toBe('Alice / Carol · 28/09/2026, 19:46');
    // several participants — the first + "+N", like the label did
    expect(chatHintOf(characters, users, { ...cs, characterIds: ['c1', 'c2'] })).toContain('Alice +1 / Carol');
  });

  it('an empty chat has no date to show', () => {
    expect(chatHintOf(characters, users, base)).toBe('Alice / Carol');
  });
});

describe('The chat title and cloning a chat', () => {
  let cloneCalls: string[];
  let patchBodies: Record<string, unknown>[];
  const copyChat: Chat = {
    ...turnChat([]),
    id: 'chat-2',
    name: 'Road trip (copy)',
    createdAt: CHAT_CREATED_AT + 1000,
  };

  beforeEach(async () => {
    cloneCalls = [];
    patchBodies = [];
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [TopBar, ChatSettingsDialog],
      providers: [
        {
          provide: ApiService,
          useValue: fakeApiForTurnButton({
            cloneChat: (id: string) => {
              cloneCalls.push(id);
              return Promise.resolve(copyChat);
            },
            patchChat: (id: string, patch: Record<string, unknown>) => {
              patchBodies.push(patch);
              return Promise.resolve({ ...turnChat([]), ...patch });
            },
            getChats: () =>
              Promise.resolve<ChatSummary[]>([{ ...copyChat, messageCount: 0, lastMessageAt: 0 }]),
          }),
        },
      ],
    }).compileComponents();
  });

  function renderHeader(): { store: ChatStore; fixture: ComponentFixture<TopBar>; el: HTMLElement } {
    const store = TestBed.inject(ChatStore);
    store.chat.set(turnChat([]));
    const fixture = TestBed.createComponent(TopBar);
    fixture.detectChanges();
    return { store, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('the header shows the chat name, or the creation date while the chat has no name', () => {
    const { store, fixture, el } = renderHeader();
    const label = el.querySelector('[data-testid=chat-date]')!;
    expect(label.textContent).toContain('03/08/2026');
    expect(label.textContent).toContain('12:00');

    store.chat.set({ ...turnChat([]), name: 'Road trip' });
    fixture.detectChanges();
    expect(store.chatTitle()).toBe('Road trip');
    expect(label.textContent).toContain('Road trip');
  });

  it('the chat-actions menu has Clone chat above Delete chat and opens the copy', async () => {
    const { store, fixture, el } = renderHeader();
    (el.querySelector('[data-testid=chat-dots]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const cloneBtn = el.querySelector('[data-testid=clone-chat]') as HTMLButtonElement;
    const deleteBtn = el.querySelector('[data-testid=delete-chat]') as HTMLButtonElement;
    expect(cloneBtn).toBeTruthy();
    expect(deleteBtn).toBeTruthy();
    const items = [...el.querySelectorAll('.dropdown [data-testid]')].map((n) =>
      n.getAttribute('data-testid'),
    );
    expect(items).toEqual(['chat-settings', 'clone-chat', 'delete-chat']);

    cloneBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(cloneCalls).toEqual(['chat-1']);
    expect(store.chat()?.id).toBe('chat-2');
    expect(store.chatTitle()).toBe('Road trip (copy)');
    // the list is re-read so the copy shows up in the chat menu
    expect(store.chats().map((c) => c.id)).toEqual(['chat-2']);
  });

  it('the settings dialog carries the name and saves it trimmed', async () => {
    const store = TestBed.inject(ChatStore);
    store.chat.set({ ...turnChat([]), name: 'Road trip' });
    const fixture = TestBed.createComponent(ChatSettingsDialog);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector('[data-testid=chat-name-input]') as HTMLInputElement;
    expect(input.value).toBe('Road trip');
    // the placeholder shows the title an empty field stands for
    expect(input.getAttribute('placeholder')).toContain('03/08/2026');

    input.value = '  Evening at the harbour  ';
    input.dispatchEvent(new Event('input'));
    (el.querySelector('[data-testid=chat-settings-save]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(patchBodies[0]).toMatchObject({ name: 'Evening at the harbour' });
    expect(store.chat()?.name).toBe('Evening at the harbour');
    expect(store.chatSettingsOpen()).toBe(false);
  });

  it('clearing the name in the dialog sends an empty name (the date titles the chat again)', async () => {
    const store = TestBed.inject(ChatStore);
    store.chat.set({ ...turnChat([]), name: 'Road trip' });
    const fixture = TestBed.createComponent(ChatSettingsDialog);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector('[data-testid=chat-name-input]') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    (el.querySelector('[data-testid=chat-settings-save]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(patchBodies[0]).toMatchObject({ name: '' });
  });

  it('the chat list rows show the title and keep the characters, the persona and the last message date in the hint', () => {
    const characters: Character[] = [
      { id: 'c1', name: 'Alice', description: '' },
      { id: 'c2', name: 'Bob', description: '' },
    ];
    const users: User[] = [{ id: 'u1', name: 'Carol', description: '' }];
    TestBed.inject(ConfigStore).characters.set(characters);
    TestBed.inject(ConfigStore).users.set(users);
    const lastMessage = new Date(2026, 8, 28, 19, 46).getTime();
    const named: ChatSummary = {
      id: 'ch-named',
      name: 'Road trip',
      createdAt: CHAT_CREATED_AT,
      characterIds: ['c1', 'c2'],
      userId: 'u1',
      modelId: 'm1',
      messageCount: 7,
      lastMessageAt: lastMessage,
    };
    const nameless: ChatSummary = { ...named, id: 'ch-nameless', name: undefined };

    const store = TestBed.inject(ChatStore);
    store.chat.set(turnChat([]));
    store.chats.set([named, nameless]);
    const fixture = TestBed.createComponent(TopBar);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    // the list renders inside the chat menu
    (el.querySelector('[data-testid=chat-date]') as HTMLElement).click();
    fixture.detectChanges();

    const rows = [...el.querySelectorAll('.chat-list .opt')] as HTMLButtonElement[];
    expect(rows).toHaveLength(2);
    // a named chat: its name on the row, the rest in the hint
    expect(rows[0].textContent).toContain('Road trip');
    expect(rows[0].textContent).not.toContain('Alice');
    expect(rows[0].textContent).toContain('7 messages');
    expect(rows[0].getAttribute('title')).toBe('Alice +1 / Carol · 28/09/2026, 19:46');
    // a nameless chat is titled by its creation date; the hint is the same
    expect(rows[1].textContent).toContain('03/08/2026');
    expect(rows[1].getAttribute('title')).toBe('Alice +1 / Carol · 28/09/2026, 19:46');
  });
});
