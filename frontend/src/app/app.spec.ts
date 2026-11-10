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
  Picture,
  User,
} from '../services/api';
import { InputPanel } from '../components/input-panel/input-panel';
import { MessageRow } from '../components/message-row/message-row';
import { TopBar } from '../components/top-bar/top-bar';
import { ChatSettingsDialog } from '../components/chat-settings-dialog/chat-settings-dialog';
import { PictureDialog } from '../components/picture-dialog/picture-dialog';
import { PictureLibraryComponent } from '../components/picture-library/picture-library';
import { ChatStore } from '../services/chat-store';
import { ConfigStore } from '../services/config-store';
import { ImageStore } from '../services/image-store';
import { PictureLibraryStore } from '../services/picture-library-store';
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
      images: ['chat-1/a-red-boat-1a2b3c.png'],
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
    store.onImagesAdded(['data:image/png;base64,aGVsbG8=', 'chat-1/a-red-boat-1a2b3c.png']);
    fixture.detectChanges();
    await fixture.whenStable();

    const imgs = el.querySelectorAll<HTMLElement>('.pending .pending-thumb img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(imgs[1].getAttribute('src')).toBe(mediaUrl('chat-1/a-red-boat-1a2b3c.png'));
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
  // The fake mirrors the SERVER catalog: one card is written or deleted per call
  // and the answer is the whole list, exactly as the per-item endpoints behave.
  // Seeding the initial catalog is the test's job (it sets the fake's list).
  let lastConfig: AppConfig | undefined;
  let serverCharacters: Character[] = [];
  let serverUsers: User[] = [];
  const cloneCalls: string[] = [];
  const fakeApi = {
    putConfig: (cfg: AppConfig) => {
      lastConfig = cfg;
      return Promise.resolve(cfg);
    },
    putCharacter: (character: Character) => {
      serverCharacters = serverCharacters.some((c) => c.id === character.id)
        ? serverCharacters.map((c) => (c.id === character.id ? character : c))
        : [...serverCharacters, character];
      return Promise.resolve(serverCharacters);
    },
    deleteCharacter: (id: string) => {
      serverCharacters = serverCharacters.filter((c) => c.id !== id);
      return Promise.resolve({ deleted: true, characters: serverCharacters });
    },
    putUser: (user: User) => {
      serverUsers = serverUsers.some((u) => u.id === user.id)
        ? serverUsers.map((u) => (u.id === user.id ? user : u))
        : [...serverUsers, user];
      return Promise.resolve(serverUsers);
    },
    deleteUser: (id: string) => {
      serverUsers = serverUsers.filter((u) => u.id !== id);
      return Promise.resolve({ deleted: true, users: serverUsers });
    },
    cloneCharacter: (id: string) => {
      cloneCalls.push('character:' + id);
      const src = serverCharacters.find((c) => c.id === id);
      const copy: Character = {
        id: id + '-copy',
        name: (src?.name ?? '?') + ' (copy)',
        description: src?.description ?? '',
      };
      return Promise.resolve({ id: copy.id, characters: [...serverCharacters, copy] });
    },
    cloneUser: (id: string) => {
      cloneCalls.push('user:' + id);
      const src = serverUsers.find((u) => u.id === id);
      const copy: User = {
        id: id + '-copy',
        name: (src?.name ?? '?') + ' (copy)',
        description: src?.description ?? '',
      };
      return Promise.resolve({ id: copy.id, users: [...serverUsers, copy] });
    },
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    lastConfig = undefined;
    serverCharacters = [];
    serverUsers = [];
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

  it('character: create, update, delete and clone (one card per request)', async () => {
    const store = TestBed.inject(ConfigStore);
    // the catalog the server holds (the store shows what the server answers)
    serverCharacters = [
      { id: 'a', name: 'A', description: '' },
      { id: 'b', name: 'B', description: '' },
    ];
    store.characters.set(serverCharacters);

    // create: the id is generated here
    store.saveCharacter(null, 'C', 'desc');
    await tick();
    expect(serverCharacters.map((c) => c.name).sort()).toEqual(['A', 'B', 'C']);
    const created = serverCharacters.find((c) => c.name === 'C')!;
    expect(created.id).toMatch(/^c\d+$/);

    store.saveCharacter('a', 'A2', 'new desc');
    await tick();
    expect(serverCharacters.find((c) => c.id === 'a')).toEqual({
      id: 'a',
      name: 'A2',
      description: 'new desc',
    });

    store.deleteCharacter('b');
    await tick();
    expect(serverCharacters.map((c) => c.id)).toEqual(['a', created.id]);
    expect(store.characters().map((c) => c.id)).toEqual(['a', created.id]);

    const cloned = store.cloneCharacter('a');
    await tick();
    expect(cloneCalls).toEqual(['character:a']);
    // resolves with the copy's id and updates the list
    expect(await cloned).toBe('a-copy');
    expect(store.characters().map((c) => c.id)).toEqual(['a', created.id, 'a-copy']);
  });

  it('user: create, update, delete and clone (one card per request)', async () => {
    const store = TestBed.inject(ConfigStore);
    serverUsers = [{ id: 'u1', name: 'U1', description: '' }];
    store.users.set(serverUsers);

    store.saveUser(null, 'U2', '');
    await tick();
    expect(serverUsers.map((u) => u.name).sort()).toEqual(['U1', 'U2']);
    const created = serverUsers.find((u) => u.name === 'U2')!;
    expect(created.id).toMatch(/^u\d+$/);

    store.saveUser('u1', 'U1 renamed', 'describes the persona');
    await tick();
    expect(serverUsers.find((u) => u.id === 'u1')).toEqual({
      id: 'u1',
      name: 'U1 renamed',
      description: 'describes the persona',
    });

    store.deleteUser('u1');
    await tick();
    expect(serverUsers.map((u) => u.id)).toEqual([created.id]);

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
        images: ['chat-1/a-picture-for-the-conversation-1a2b3c.png'],
        generation: { source: 'auto', model: 'm1' },
        imageStatus: { 'chat-1/a-picture-for-the-conversation-1a2b3c.png': 'pending' as const },
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
  const cardImage = 'chat-1/a-red-boat-at-dusk-1a2b3c.png';

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
      generation: { prompt: 'a red boat, the sky orange', refs: ['chat-1/a-harbour-9f8e7d.png'], source: 'auto' },
      timestamp: 3,
    });

    const img = el.querySelector('.card-body img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(mediaUrl(cardImage));
    expect(el.querySelector('[data-testid=card-caption]')?.textContent?.trim()).toBe(
      'a red boat on a calm lake at dusk',
    );
    expect(el.querySelector('[data-testid=card-prompt]')?.textContent?.trim()).toBe('a red boat, the sky orange');
    expect(el.querySelector('[data-testid=card-refs]')?.textContent).toContain('references: 1');
    // a drawn picture can be redrawn; everything else about it (the prompt,
    // the description, the file) lives in the picture editor dialog
    expect(el.querySelector('[data-testid=img-regenerate]')).toBeTruthy();
    expect(el.querySelector('[data-testid=img-edit-prompt]')).toBeNull();
    expect(el.querySelector('[data-testid=img-replace]')).toBeNull();
  });

  it('the ✎ of a card opens the picture editor for that card', () => {
    const imageStore = TestBed.inject(ImageStore);
    const { el } = renderMessage({
      id: 'card-6',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: 'a red boat on a calm lake',
      images: [cardImage],
      generation: { prompt: 'a red boat', source: 'manual' },
      timestamp: 3,
    });
    (el.querySelector('[data-testid=msg-edit]') as HTMLButtonElement).click();
    expect(imageStore.pictureEdit()).toEqual({ messageId: 'card-6', image: cardImage });
  });

  it('the ✎ of a text message still starts the inline edit', () => {
    const chatStore = TestBed.inject(ChatStore);
    const imageStore = TestBed.inject(ImageStore);
    const { el } = renderMessage({
      id: 'msg-2',
      role: 'user',
      kind: 'text',
      userId: 'u1',
      text: 'just words',
      images: [],
      timestamp: 3,
    });
    (el.querySelector('[data-testid=msg-edit]') as HTMLButtonElement).click();
    expect(chatStore.editTargetId()).toBe('msg-2');
    expect(imageStore.pictureEdit()).toBeNull();
  });

  it('an uploaded photo has no prompt, so it offers no redraw — only the replace', () => {
    const { el } = renderMessage({
      id: 'card-2',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: 'my own photo',
      images: ['chat-1/my-photo-1a2b3c.jpg'],
      generation: { source: 'upload' },
      timestamp: 3,
    });
    expect(el.querySelector('[data-testid=card-prompt]')).toBeNull();
    expect(el.querySelector('[data-testid=card-refs]')).toBeNull();
    expect(el.querySelector('[data-testid=img-regenerate]')).toBeNull();
    expect(el.querySelector('[data-testid=img-edit-prompt]')).toBeNull();
    expect(el.querySelector('[data-testid=img-replace]')).toBeNull();
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

describe('PictureDialog — the picture editor', () => {
  const mediaUrl = (id: string) => `http://localhost:3000/api/media?path=${encodeURIComponent(id)}`;
  const cardImage = 'chat-1/a-red-fox-1a2b3c.png';
  const otherImage = 'characters/alice/photo1.jpg';

  type Patched = { chatId: string; messageId: string; patch: Record<string, unknown> };
  let patched: Patched[];
  let replaced: Array<{ chatId: string; messageId: string; image: string; data: string }>;
  let described: Array<{ chatId: string; image?: string; data?: string }>;
  let tuned: Array<{ chatId: string; prompt: string }>;
  let planned: Array<{ chatId: string; messageId?: string }>;
  let chat: Chat;

  function card(over: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'card-1',
      role: 'user',
      kind: 'image',
      userId: 'u1',
      text: 'a fox in the snow',
      images: [cardImage],
      generation: { prompt: 'a red fox', source: 'manual' },
      timestamp: 2,
      ...over,
    };
  }

  function fakeApiForPicture() {
    return {
      mediaUrl,
      // The one catalog: ids with their row (the browser and the card editor read
      // the same list).
      listPictures: () =>
        Promise.resolve({
          pictures: [
            { id: cardImage, description: 'a fox in the snow', exists: true },
            { id: otherImage, exists: true },
          ],
        }),
      composePicturePrompt: (chatId: string, messageId?: string) => {
        planned.push({ chatId, messageId });
        return Promise.resolve({
          prompt: 'a planned prompt',
          description: 'a planned description',
          // the plan names these pictures in order, so they belong to the prompt
          refs: ['chat-1/the-fox-face-9f8e7d.png'],
        });
      },
      tunePicturePrompt: (chatId: string, prompt: string) => {
        tuned.push({ chatId, prompt });
        return Promise.resolve({ prompt: 'a tuned english prompt' });
      },
      describePicture: (chatId: string, body: { image?: string; data?: string }) => {
        described.push({ chatId, ...body });
        return Promise.resolve({ description: 'a picture the model saw' });
      },
      patchPicture: (chatId: string, messageId: string, patch: Record<string, unknown>) => {
        patched.push({ chatId, messageId, patch });
        return Promise.resolve({ chat });
      },
      replaceImage: (chatId: string, messageId: string, image: string, data: string) => {
        replaced.push({ chatId, messageId, image, data });
        return Promise.resolve({ chat });
      },
      getConfig: () => Promise.resolve({ llmModels: {} }),
      imageStatus: () => Promise.resolve({ available: false }),
      getCharacters: () => Promise.resolve([]),
      getUsers: () => Promise.resolve([]),
      getChats: () => Promise.resolve([]),
    };
  }

  async function render(
    message: ChatMessage,
  ): Promise<{ fixture: ComponentFixture<PictureDialog>; el: HTMLElement }> {
    chat = {
      id: 'chat-1',
      createdAt: 0,
      characterIds: ['c1'],
      userId: 'u1',
      messages: [message],
    };
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [PictureDialog],
      providers: [{ provide: ApiService, useValue: fakeApiForPicture() }],
    }).compileComponents();
    TestBed.inject(ChatStore).chat.set(chat);
    TestBed.inject(ImageStore).openPictureEdit(message.id, message.images[0]);
    const fixture = TestBed.createComponent(PictureDialog);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    patched = [];
    replaced = [];
    described = [];
    tuned = [];
    planned = [];
  });

  it('a generated card opens in "generated" with its prompt and description, and Save keeps it generated', async () => {
    const { el } = await render(card());
    expect((el.querySelector('[data-testid=picture-kind-generated]') as HTMLInputElement).checked).toBe(true);
    const prompt = el.querySelector('[data-testid=picture-prompt]') as HTMLTextAreaElement;
    expect(prompt.value).toBe('a red fox');
    expect((el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement).value).toBe(
      'a fox in the snow',
    );
    // the "from a file" pick is not part of this form
    expect(el.querySelector('[data-testid=picture-id]')).toBeNull();

    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();

    expect(patched).toEqual([
      {
        chatId: 'chat-1',
        messageId: 'card-1',
        patch: { description: 'a fox in the snow', kind: 'generated', prompt: 'a red fox' },
      },
    ]);
    // the dialog closes itself after a successful save
    expect(TestBed.inject(ImageStore).pictureEdit()).toBeNull();
  });

  it('"From the chat" writes the prompt from the dialogue; "Make it English" rewrites it', async () => {
    const { el } = await render(card());
    (el.querySelector('[data-testid=picture-prompt-from-chat]') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(planned).toEqual([{ chatId: 'chat-1', messageId: 'card-1' }]);
    const prompt = el.querySelector('[data-testid=picture-prompt]') as HTMLTextAreaElement;
    expect(prompt.value).toBe('a planned prompt');
    // the description was already there — the plan's own does not overwrite it
    expect((el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement).value).toBe(
      'a fox in the snow',
    );

    (el.querySelector('[data-testid=picture-prompt-english]') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(tuned).toEqual([{ chatId: 'chat-1', prompt: 'a planned prompt' }]);
    expect(prompt.value).toBe('a tuned english prompt');
  });

  it('"Describe the picture" asks the model about the card picture', async () => {
    const { el } = await render(card());
    (el.querySelector('[data-testid=picture-describe]') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(described).toEqual([{ chatId: 'chat-1', image: cardImage }]);
    expect((el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement).value).toBe(
      'a picture the model saw',
    );
  });

  it('"From the chat" also hands over the pictures its prompt names, and Save keeps them with it', async () => {
    const face = 'chat-1/the-fox-face-9f8e7d.png';
    const { fixture, el } = await render(card());
    (el.querySelector('[data-testid=picture-prompt-from-chat]') as HTMLButtonElement).click();
    await tick();
    await tick();
    fixture.detectChanges();

    // the reference set the prompt speaks about is shown under it
    const thumbs = [...el.querySelectorAll('.ref-thumb')] as HTMLImageElement[];
    expect(thumbs.map((t) => t.getAttribute('src'))).toEqual([mediaUrl(face)]);

    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();

    // a redraw reads the prompt AND the pictures it names — one without the
    // other would draw something else
    expect(patched).toEqual([
      {
        chatId: 'chat-1',
        messageId: 'card-1',
        patch: {
          description: 'a fox in the snow',
          kind: 'generated',
          prompt: 'a planned prompt',
          refs: [face],
        },
      },
    ]);
  });

  it('the "who is on this picture" chips say who the next picture may draw', async () => {
    const { fixture, el } = await render(card({ depicts: ['char:c1'] }));
    const config = TestBed.inject(ConfigStore);
    config.characters.set([{ id: 'c1', name: 'Alice', description: '' }]);
    config.users.set([{ id: 'u1', name: 'Carol', description: '' }]);
    fixture.detectChanges();

    const chips = [...el.querySelectorAll('[data-testid=picture-depicts]')] as HTMLButtonElement[];
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Alice', 'Carol']);
    // the card already says Alice; nobody else is on it
    expect(chips.map((c) => c.classList.contains('on'))).toEqual([true, false]);

    chips[1].click();
    fixture.detectChanges();
    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();

    expect(patched[0]?.patch).toMatchObject({ depicts: ['char:c1', 'user:u1'] });
  });

  it('a card nobody touched is saved without touching its people or its references', async () => {
    const { fixture, el } = await render(card({ depicts: ['char:c1'], generation: { prompt: 'a red fox', source: 'auto', refs: [otherImage] } }));
    fixture.detectChanges();
    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();

    // only what the dialog actually shows: the description and the prompt
    expect(patched[0]?.patch).toEqual({
      description: 'a fox in the snow',
      kind: 'generated',
      prompt: 'a red fox',
    });
  });

  it('an uploaded picture opens in "from a file": the catalog id pick saves the card as a file', async () => {
    const { el } = await render(card({ generation: { source: 'upload' }, text: 'my photo' }));
    expect((el.querySelector('[data-testid=picture-kind-file]') as HTMLInputElement).checked).toBe(true);
    expect(el.querySelector('[data-testid=picture-prompt]')).toBeNull();

    const select = el.querySelector('[data-testid=picture-id]') as HTMLSelectElement;
    // the catalog of the data folder, the card's own picture selected
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', cardImage, otherImage]);
    expect(select.value).toBe(cardImage);

    select.value = otherImage;
    select.dispatchEvent(new Event('change'));
    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();

    expect(patched).toEqual([
      {
        chatId: 'chat-1',
        messageId: 'card-1',
        patch: { description: 'my photo', kind: 'file', image: otherImage },
      },
    ]);
  });

  it('a file picked from disk is previewed, saved into the chat and then given the description', async () => {
    const { fixture, el } = await render(card({ generation: { source: 'upload' }, text: 'my photo' }));
    const input = el.querySelector('[data-testid=picture-file]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    // the file is read asynchronously (FileReader) — wait for the preview
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      fixture.detectChanges();
      const src = (el.querySelector('.preview img') as HTMLImageElement).getAttribute('src') ?? '';
      if (src.startsWith('data:image/png')) break;
    }

    const preview = el.querySelector('.preview img') as HTMLImageElement;
    expect(preview.getAttribute('src')?.startsWith('data:image/png')).toBe(true);

    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();
    await tick();

    expect(replaced).toHaveLength(1);
    expect(replaced[0].image).toBe(cardImage);
    expect(replaced[0].data.startsWith('data:image/png')).toBe(true);
    // the description lands on the swapped card
    expect(patched).toEqual([
      { chatId: 'chat-1', messageId: 'card-1', patch: { description: 'my photo', kind: 'file' } },
    ]);
  });
});

// The picture browser: the whole data folder in one list, each picture with the
// row that describes it, edited here rather than through a card. What matters is
// that the edit goes to the picture (the table) and not to a message, and that a
// rename — a file move — is its own action with the server's refusal shown.
describe('PictureLibrary — the picture browser', () => {
  const boat = 'chat-1/a-red-boat-1a2b3c.png';
  const anchor = 'characters/alice/photo1.jpg';
  let chat: Chat;
  let listed: Picture[];
  let edited: { id: string; patch: Record<string, unknown> }[];
  let renamed: { id: string; newId: string }[];
  let forgotten: string[];
  let describeCalls: { chatId: string; image?: string; data?: string }[];
  let renameFails: string | null;
  let reloadedChats: number;
  // How long the answer of a save takes to come back — the test of the form
  // racing its own request needs a reply that arrives late.
  let editDelayMs = 0;

  function fakeApi(): any {
    return {
      mediaUrl: (id: string) => '/api/media?path=' + encodeURIComponent(id),
      listPictures: () => Promise.resolve({ pictures: listed }),
      editPicture: (id: string, patch: Record<string, unknown>) => {
        edited.push({ id, patch });
        const row = listed.find((p) => p.id === id);
        const next = { ...(row ?? { id, exists: true }), ...patch };
        return new Promise((r) => setTimeout(() => r({ picture: next as Picture }), editDelayMs));
      },
      renamePicture: (id: string, newId: string) => {
        renamed.push({ id, newId });
        if (renameFails) return Promise.reject(new Error(renameFails));
        const row = listed.find((p) => p.id === id)!;
        listed = listed.map((p) => (p.id === id ? { ...p, id: newId } : p));
        return Promise.resolve({ picture: { ...row, id: newId } });
      },
      forgetPicture: (id: string) => {
        forgotten.push(id);
        listed = listed.filter((p) => p.id !== id);
        return Promise.resolve({ forgotten: id });
      },
      describePicture: (chatId: string, body: { image?: string; data?: string }) => {
        describeCalls.push({ chatId, ...body });
        return Promise.resolve({ description: 'a red boat at dusk, as the model sees it' });
      },
      getChat: () => {
        reloadedChats += 1;
        return Promise.resolve(chat);
      },
      getCharacters: () => Promise.resolve([]),
      getUsers: () => Promise.resolve([]),
      getChats: () => Promise.resolve([]),
    };
  }

  async function render(): Promise<{ fixture: ComponentFixture<PictureLibraryComponent>; el: HTMLElement }> {
    await TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PictureLibraryComponent],
      providers: [{ provide: ApiService, useValue: fakeApi() }],
    });
    const store = TestBed.inject(PictureLibraryStore);
    store.openLibrary();
    await new Promise((r) => setTimeout(r, 0));
    const fixture = TestBed.createComponent(PictureLibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    chat = {
      id: 'chat-1',
      createdAt: 0,
      characterIds: ['c1'],
      userId: 'u1',
      messages: [],
    };
    listed = [
      { id: boat, description: 'a red boat on a calm lake', prompt: 'a red boat at dusk', refs: [anchor], exists: true },
      { id: anchor, exists: true },
      { id: 'chat-9/gone-1a2b3c.png', description: 'a picture with no file', exists: false },
    ];
    edited = [];
    renamed = [];
    forgotten = [];
    describeCalls = [];
    renameFails = null;
    reloadedChats = 0;
    editDelayMs = 0;
  });

  it('lists every picture with its description, and the missing file is marked', async () => {
    const { el } = await render();
    const rows = [...el.querySelectorAll('[data-testid=picture-row]')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('a-red-boat-1a2b3c.png');
    expect(rows[0].textContent).toContain('a red boat on a calm lake');
    // a row whose file is gone is shown as gone, not hidden: it is a record the
    // user should be able to see and clear
    expect(rows[2].classList.contains('gone')).toBe(true);
    expect(rows[2].querySelector('.lib-thumb-gone')).not.toBeNull();
    // the first picture is selected, and its fields are filled from its row
    const description = el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement;
    expect(description.value).toBe('a red boat on a calm lake');
    expect((el.querySelector('[data-testid=picture-prompt]') as HTMLTextAreaElement).value).toBe(
      'a red boat at dusk',
    );
    expect(el.querySelectorAll('[data-testid=picture-ref-remove]')).toHaveLength(1);
    expect((el.querySelector('[data-testid=picture-id-input]') as HTMLInputElement).value).toBe(boat);
  });

  it('saving writes the picture row, not a message, and re-reads the chat that shows it', async () => {
    const { el } = await render();
    // the browser re-reads the CURRENT chat after a save — so there has to be
    // one open (a card of it may be the picture being edited)
    TestBed.inject(ChatStore).applyChat(chat);
    const description = el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement;
    description.value = 'corrected by hand';
    description.dispatchEvent(new Event('input'));
    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();

    expect(edited).toEqual([
      { id: boat, patch: { description: 'corrected by hand', prompt: 'a red boat at dusk', refs: [anchor] } },
    ]);
    // the card of a chat reads the same row, so the conversation is re-read: the
    // caption changes there without a reload
    expect(reloadedChats).toBe(1);
    // the list shows the new words right away
    expect(TestBed.inject(PictureLibraryStore).pictures()[0].description).toBe('corrected by hand');
  });

  it('a reference can be dropped and added back; the pick never offers the picture itself', async () => {
    const { fixture, el } = await render();
    const optionsOf = () =>
      [...el.querySelectorAll('[data-testid=picture-ref-add] option')].map((o) => (o as HTMLOptionElement).value).filter(Boolean);
    // the picture being edited is never its own reference and a row whose file is
    // gone is not a reference a job could read; the one picture it does use is
    // already chosen, so it is not offered either
    expect(optionsOf()).toEqual([]);
    expect(el.querySelectorAll('[data-testid=picture-ref-remove]')).toHaveLength(1);

    (el.querySelector('[data-testid=picture-ref-remove]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid=picture-ref-remove]')).toHaveLength(0);
    expect(el.querySelector('.refs-none')).not.toBeNull();
    // with the slot free, the catalog offers the picture again
    expect(optionsOf()).toEqual([anchor]);

    const add = el.querySelector('[data-testid=picture-ref-add]') as HTMLSelectElement;
    add.value = anchor;
    add.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid=picture-ref-remove]')).toHaveLength(1);
    expect(optionsOf()).toEqual([]);

    // and the restored list is what Save would send
    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();
    await tick();
    expect(edited[0].patch['refs']).toEqual([anchor]);
  });

  it('renaming is its own action: disabled until the id is edited, it sends the new path', async () => {
    const { fixture, el } = await render();
    const rename = el.querySelector('[data-testid=picture-rename]') as HTMLButtonElement;
    expect(rename.disabled).toBe(true);

    const idInput = el.querySelector('[data-testid=picture-id-input]') as HTMLInputElement;
    idInput.value = 'chat-1/a-boat-at-sunset-9z8y7x.png';
    idInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect((el.querySelector('[data-testid=picture-rename]') as HTMLButtonElement).disabled).toBe(false);

    (el.querySelector('[data-testid=picture-rename]') as HTMLButtonElement).click();
    await tick();
    await tick();

    expect(renamed).toEqual([{ id: boat, newId: 'chat-1/a-boat-at-sunset-9z8y7x.png' }]);
    // the selection follows the picture to its new path
    expect(TestBed.inject(PictureLibraryStore).selectedId()).toBe('chat-1/a-boat-at-sunset-9z8y7x.png');
  });

  it('a save that answers late does not wipe the new id being typed', async () => {
    // The user saves a caption and, without waiting for the answer, starts
    // retyping the id. The answer brings the row back and the store replaces its
    // object — refilling the form from it then would erase what is being typed
    // and leave Rename disabled forever.
    editDelayMs = 20;
    const { fixture, el } = await render();
    const description = el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement;
    description.value = 'retitled while the save is on its way';
    description.dispatchEvent(new Event('input'));
    (el.querySelector('[data-testid=picture-save]') as HTMLButtonElement).click();

    const idInput = el.querySelector('[data-testid=picture-id-input]') as HTMLInputElement;
    idInput.value = 'chat-1/a-boat-at-sunset-9z8y7x.png';
    idInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect((el.querySelector('[data-testid=picture-rename]') as HTMLButtonElement).disabled).toBe(false);

    // the answer lands and the store has a new object for the row
    await new Promise((r) => setTimeout(r, 40));
    expect(TestBed.inject(PictureLibraryStore).pictures()[0].description).toBe('retitled while the save is on its way');
    fixture.detectChanges();

    expect((el.querySelector('[data-testid=picture-id-input]') as HTMLInputElement).value).toBe(
      'chat-1/a-boat-at-sunset-9z8y7x.png',
    );
    expect((el.querySelector('[data-testid=picture-rename]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a refused name lands in the error banner and keeps the picture where it was', async () => {
    renameFails = 'There is already a file at "chat-1/x.png"';
    const { el } = await render();
    const idInput = el.querySelector('[data-testid=picture-id-input]') as HTMLInputElement;
    idInput.value = 'chat-1/x.png';
    idInput.dispatchEvent(new Event('input'));
    await tick();
    (el.querySelector('[data-testid=picture-rename]') as HTMLButtonElement).click();
    await tick();

    expect(TestBed.inject(UiStore).error()).toContain('already a file');
    expect(TestBed.inject(PictureLibraryStore).selectedId()).toBe(boat);
  });

  it('the filter narrows the list by name and by description', async () => {
    const { el } = await render();
    const filter = el.querySelector('[data-testid=picture-filter]') as HTMLInputElement;
    filter.value = 'calm lake';
    filter.dispatchEvent(new Event('input'));
    await tick();
    const rows = [...el.querySelectorAll('[data-testid=picture-row]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('a-red-boat');

    filter.value = 'photo';
    filter.dispatchEvent(new Event('input'));
    await tick();
    expect(el.querySelectorAll('[data-testid=picture-row]')).toHaveLength(1);

    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    await tick();
    expect(el.querySelectorAll('[data-testid=picture-row]')).toHaveLength(3);
  });

  it('the filter is an AND over its words, each found in the id or the description', async () => {
    const { el } = await render();
    const filter = el.querySelector('[data-testid=picture-filter]') as HTMLInputElement;
    const show = (value: string) => {
      filter.value = value;
      filter.dispatchEvent(new Event('input'));
    };
    const visible = () => [...el.querySelectorAll('[data-testid=picture-row]')];

    // one word of the id and one of the description of the SAME picture
    show('boat calm');
    await tick();
    expect(visible()).toHaveLength(1);
    expect(visible()[0].textContent).toContain('a-red-boat');

    // a word of the path filters by folder: only the picture of chat-9 is left
    show('chat-9');
    await tick();
    expect(visible()).toHaveLength(1);
    expect(visible()[0].getAttribute('title')).toBe('chat-9/gone-1a2b3c.png');

    // words that belong to two different pictures match NOTHING — every word has
    // to be found on one picture, or a filter would answer "and" with an "or"
    // ("calm" is the boat's caption, "gone" is a word of the other row's id)
    show('calm gone');
    await tick();
    expect(visible()).toHaveLength(0);
    expect(el.querySelector('[data-testid=picture-empty]')).not.toBeNull();

    // spaces around and between the words do not make an empty word that would
    // match every row
    show('   calm    lake  ');
    await tick();
    expect(visible()).toHaveLength(1);
  });

  it('the row shows the full id of the picture — the whole path it lives at', async () => {
    const { el } = await render();
    const rows = [...el.querySelectorAll('[data-testid=picture-row]')];
    const idLine = rows[0].querySelector('.lib-id')!.textContent!.trim();
    // the whole path, not a tail: the id is where the file lives, what the ID
    // field edits and what the filter matches, so the row hides nothing of it —
    // a long path wraps, it is never cut
    expect(idLine).toBe(boat);
    expect(idLine).not.toContain('…');
    expect(rows[0].getAttribute('title')).toBe(boat);
    // a character photo shows its full path too (the same row shape)
    expect(rows[1].querySelector('.lib-id')!.textContent!.trim()).toBe(anchor);
  });

  it('the list can be ordered by ID as well as by the file date', async () => {
    const { fixture, el } = await render();
    const order = () =>
      [...el.querySelectorAll('[data-testid=picture-row]')].map((r) => r.getAttribute('title'));
    // by default the order the server sends: newest file first, an orphan row last
    expect(order()).toEqual([boat, anchor, 'chat-9/gone-1a2b3c.png']);

    const sort = el.querySelector('[data-testid=picture-sort]') as HTMLSelectElement;
    sort.value = 'id';
    sort.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    // by ID the list reads alphabetically by the path — finding a picture by
    // reading its way through the folders; the orphan row sorts with the rest,
    // because the user looking for a path cannot know it lost its file
    expect(order()).toEqual([anchor, boat, 'chat-9/gone-1a2b3c.png']);

    sort.value = 'newest';
    sort.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(order()).toEqual([boat, anchor, 'chat-9/gone-1a2b3c.png']);
  });

  it('a picture used as a reference shows the count in the row and under the ID field', async () => {
    // the count is the server's (it counts the other rows' refs on every read) —
    // the browser only says the number it was given
    listed = listed.map((p) =>
      p.id === anchor ? { ...p, referencedBy: 2 } : p.id === boat ? { ...p, referencedBy: 1 } : p,
    );
    const { el } = await render();
    const rows = [...el.querySelectorAll('[data-testid=picture-row]')];
    expect(rows[0].querySelector('.lib-refs')!.textContent).toContain('1 ref');
    expect(rows[0].querySelector('.lib-refs')!.textContent).not.toContain('refs');
    expect(rows[1].querySelector('.lib-refs')!.textContent).toContain('2 refs');
    // the orphan row names nothing and is named by nobody — no badge
    expect(rows[2].querySelector('.lib-refs')).toBeNull();
    // and the editor of the selected picture states the same number in words
    expect(el.querySelector('[data-testid=picture-used-by]')!.textContent).toContain('by 1 other');
  });

  it('says when the same bytes live at another path (a copy the user or a clone made)', async () => {
    const copy = 'chat-2/a-red-boat-4d5e6f.png';
    listed = listed.map((p) => (p.id === boat ? { ...p, sameAs: [copy] } : p));
    const { el } = await render();
    const rows = [...el.querySelectorAll('[data-testid=picture-row]')];
    const badge = rows[0].querySelector('.lib-same')!;
    expect(badge.textContent!.trim()).toBe('1 copy');
    // the badge names the other file, so the user can decide which one to keep
    expect(badge.getAttribute('title')).toContain(copy);
    // a picture that is the only copy of its bytes carries no badge
    expect(rows[1].querySelector('.lib-same')).toBeNull();
  });

  it('the record of a lost picture can be forgotten, and only that record', async () => {
    const lost = 'chat-9/gone-1a2b3c.png';
    const { fixture, el } = await render();
    // the boat has its file: there is nothing to forget, and the app never
    // deletes a picture file
    expect(el.querySelector('[data-testid=picture-forget]')).toBeNull();

    const orphan = [...el.querySelectorAll('[data-testid=picture-row]')].find(
      (r) => r.getAttribute('title') === lost,
    ) as HTMLElement;
    orphan.click();
    await tick();
    const forget = el.querySelector('[data-testid=picture-forget]') as HTMLButtonElement;
    expect(forget).not.toBeNull();
    // the dialog says what it is looking at: a record whose file is gone
    expect(el.querySelector('.lib-orphan')).not.toBeNull();

    // the first click only arms the button — the same two-click confirm the
    // message deletes use — so a stray click cannot drop a description
    forget.click();
    await tick();
    fixture.detectChanges();
    expect(forgotten).toEqual([]);
    expect(forget.classList.contains('armed')).toBe(true);
    expect(forget.textContent).toContain('Click again');

    forget.click();
    await tick();

    expect(forgotten).toEqual([lost]);
    // the row is gone from the catalog and the selection moved to a picture
    expect(TestBed.inject(PictureLibraryStore).pictures().some((p) => p.id === lost)).toBe(false);
    expect(TestBed.inject(PictureLibraryStore).selectedId()).toBe(boat);
  });

  // The library's own "Describe the picture": the chat's vision model looks at
  // the selected picture and writes the caption, exactly as the card editor does
  // for a message card — the answer lands in the form, Save is what writes it.
  it('the model can write the description (the chat\'s vision model, the selected picture)', async () => {
    const { fixture, el } = await render();
    // the vision model comes from the open chat
    TestBed.inject(ChatStore).applyChat(chat);
    fixture.detectChanges();
    const button = el.querySelector('[data-testid=picture-describe]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    button.click();
    await tick();

    expect(describeCalls).toEqual([{ chatId: 'chat-1', image: boat }]);
    const description = el.querySelector('[data-testid=picture-description]') as HTMLTextAreaElement;
    expect(description.value).toBe('a red boat at dusk, as the model sees it');
    // nothing is saved by the helper: the user is still the one pressing Save
    expect(edited).toEqual([]);
  });

  it('hides the prompt of an automatically drawn picture and keeps it for a requested draw', async () => {
    listed = listed.map((p) =>
      p.id === boat
        ? { ...p, prompt: 'a plan from the dialogue', source: 'auto' as const }
        : p.id === anchor
          ? { ...p, prompt: 'a portrait in the green coat', source: 'manual' as const }
          : p,
    );
    const { el } = await render();
    // the auto picture is selected: the plan belongs to the card, so neither the
    // prompt nor the references it names are offered here
    expect(el.querySelector('[data-testid=picture-prompt]')).toBeNull();
    expect(el.querySelector('[data-testid=picture-ref-add]')).toBeNull();

    const anchorRow = [...el.querySelectorAll('[data-testid=picture-row]')].find(
      (r) => r.getAttribute('title') === anchor,
    ) as HTMLElement;
    anchorRow.click();
    await tick();
    // a draw the user asked for keeps its prompt — that text is theirs
    expect(el.querySelector('[data-testid=picture-prompt]')).not.toBeNull();
  });
});

// Toggling a character out of a chat is a reply-queue decision: it must not
// touch the history it already wrote.
describe('MessageRow — an author that is no longer a participant', () => {
  const alice: Character = { id: 'c1', name: 'Alice', description: '', avatar: null };
  const bob: Character = { id: 'c2', name: 'Bob', description: '', avatar: 'c2-av' };

  beforeEach(async () => {
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [MessageRow],
      providers: [
        {
          provide: ApiService,
          useValue: fakeApiForTurnButton({
            getCharacters: () => Promise.resolve([alice, bob]),
            mediaUrl: (id: string) => 'avatar-of-' + id,
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
    expect(el.querySelector('.avatar img')?.getAttribute('src')).toBe('avatar-of-c2-av');

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
  let renameCalls: Array<{ id: string; newId: string }>;
  // What the fake getChats answers with as the only row — the rename stub
  // moves it, so a test can see the list re-read under the new id.
  let listId: string;
  const copyChat: Chat = {
    ...turnChat([]),
    id: 'chat-2',
    name: 'Road trip (copy)',
    createdAt: CHAT_CREATED_AT + 1000,
  };

  beforeEach(async () => {
    cloneCalls = [];
    patchBodies = [];
    renameCalls = [];
    listId = 'chat-2';
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
            renameChat: (id: string, newId: string) => {
              renameCalls.push({ id, newId });
              listId = newId;
              return Promise.resolve({ id: newId, chat: { ...turnChat([]), id: newId } });
            },
            getChats: () =>
              Promise.resolve<ChatSummary[]>([
                { ...copyChat, id: listId, messageCount: 0, lastMessageAt: 0 },
              ]),
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

  it('the picture style of the chat is carried and saved with it', async () => {
    const store = TestBed.inject(ChatStore);
    store.chat.set({ ...turnChat([]), stylePrompt: 'watercolour, soft edges' });
    const fixture = TestBed.createComponent(ChatSettingsDialog);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const style = el.querySelector('[data-testid=chat-style-input]') as HTMLTextAreaElement;
    expect(style.value).toBe('watercolour, soft edges');
    style.value = 'photorealistic, 35mm, warm light';
    style.dispatchEvent(new Event('input'));
    (el.querySelector('[data-testid=chat-settings-save]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(patchBodies[0]).toMatchObject({ stylePrompt: 'photorealistic, 35mm, warm light' });
  });

  it('the dialog carries the chat ID; Rename wakes only when the field says another name, and Save alone never renames', async () => {
    const store = TestBed.inject(ChatStore);
    store.chat.set(turnChat([]));
    const fixture = TestBed.createComponent(ChatSettingsDialog);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector('[data-testid=chat-id-input]') as HTMLInputElement;
    const btn = el.querySelector('[data-testid=chat-rename]') as HTMLButtonElement;
    expect(input.value).toBe('chat-1');
    expect(btn.disabled).toBe(true);

    input.value = 'harbour-talk';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(btn.disabled).toBe(false);

    (el.querySelector('[data-testid=chat-settings-save]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    // the ID moves through the explicit Rename only — a Save keeps the folder
    expect(renameCalls).toEqual([]);
    expect(store.chat()?.id).toBe('chat-1');
  });

  it('renaming the chat ID re-opens the chat under the new id and re-reads the chat list', async () => {
    const store = TestBed.inject(ChatStore);
    store.chat.set(turnChat([]));
    const fixture = TestBed.createComponent(ChatSettingsDialog);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector('[data-testid=chat-id-input]') as HTMLInputElement;
    input.value = 'harbour-talk';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (el.querySelector('[data-testid=chat-rename]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(renameCalls).toEqual([{ id: 'chat-1', newId: 'harbour-talk' }]);
    expect(store.chat()?.id).toBe('harbour-talk');
    // the dialog stays open on the new name, and the button sleeps again
    expect((el.querySelector('[data-testid=chat-id-input]') as HTMLInputElement).value).toBe(
      'harbour-talk',
    );
    expect((el.querySelector('[data-testid=chat-rename]') as HTMLButtonElement).disabled).toBe(true);
    // the chat list is re-read — its rows are keyed by the id
    expect(store.chats().map((c) => c.id)).toEqual(['harbour-talk']);
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

describe('ChatStore — the global model picks', () => {
  // The models are settings of the whole app (like the image generators): the
  // header chips write them into the config, and a chat carries none.
  const blind = { id: 'b', baseUrl: 'http://x', contextSize: 100, supportsImages: false };
  const seer = { id: 's', baseUrl: 'http://x', contextSize: 100, supportsImages: true };
  const chat: Chat = {
    id: 'chat-1',
    createdAt: 0,
    characterIds: ['char-1'],
    userId: 'user-1',
    messages: [{ id: 'msg-1', role: 'user', text: 'hello', images: [], timestamp: 1 }],
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function setup(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const puts: Record<string, unknown>[] = [];
    const api = {
      getConfig: () =>
        Promise.resolve({
          listen: '127.0.0.1:3210',
          llmModels: { blind, seer },
          imageGenerators: [],
          ...config,
        }),
      putConfig: (cfg: Record<string, unknown>) => {
        puts.push(cfg);
        return Promise.resolve(cfg);
      },
      getChats: () => Promise.resolve([]),
      getCharacters: () => Promise.resolve([{ id: 'char-1', name: 'Alice', description: '' }]),
      getUsers: () => Promise.resolve([{ id: 'user-1', name: 'Me', description: '' }]),
      imageStatus: () => Promise.resolve({ available: false }),
      ...extra,
    };
    await TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
    const configStore = TestBed.inject(ConfigStore);
    await configStore.loadAll();
    const store = TestBed.inject(ChatStore);
    store.chat.set(chat);
    return { store, api, puts };
  }

  it('names the chat model when it can see pictures', async () => {
    const { store } = await setup({ chatModel: 'seer' });
    expect(store.currentModel()?.name).toBe('seer');
    expect(store.visionModel()?.name).toBe('seer');
    expect(store.canDescribePictures()).toBe(true);
    expect(store.visionModelTitle()).toContain('seer');
  });

  it('falls back to the first model for the chat, and to the first that can see for pictures', async () => {
    const { store } = await setup();
    expect(store.currentModel()?.name).toBe('blind');
    expect(store.visionModel()?.name).toBe('seer');
    expect(store.canDescribePictures()).toBe(true);
  });

  it('honours the vision pick, and its hint says that model cannot see', async () => {
    const { store } = await setup({ chatModel: 'blind', visionModel: 'blind' });
    expect(store.visionModel()?.name).toBe('blind');
    expect(store.canDescribePictures()).toBe(false);
    expect(store.visionModelTitle()).toContain('cannot see pictures');
  });

  it('selectModel writes the global chat model', async () => {
    const { store, puts } = await setup();
    store.selectModel('seer');
    await tick();
    expect(puts[0]).toMatchObject({ chatModel: 'seer' });
    expect(store.currentModel()?.name).toBe('seer');
  });

  it('selectVisionModel writes the global pick (an empty name is the default)', async () => {
    const { store, puts } = await setup({ chatModel: 'blind' });
    store.selectVisionModel('seer');
    await tick();
    expect(puts[0]).toMatchObject({ visionModel: 'seer' });
    store.selectVisionModel('');
    await tick();
    // the field is removed, which is what makes the default rule apply
    expect(puts[1]).not.toHaveProperty('visionModel');
  });

  it('captions an attached picture the user gave no text to', async () => {
    const card: ChatMessage = {
      id: 'msg-2',
      role: 'user',
      kind: 'image',
      text: '',
      images: ['chats/chat-1/a.png'],
      timestamp: 2,
    };
    const captioned: Chat = {
      ...chat,
      messages: [...chat.messages, { ...card, text: 'a red boat on a calm lake' }],
    };
    const captionCalls: string[] = [];
    const { store } = await setup(
      {},
      {
        postMessage: (_id: string, text: string) =>
          Promise.resolve({
            chat: { ...chat, messages: [...chat.messages, card] },
            messages: [{ ...chat.messages[0], id: 'msg-1b', text }, card],
          }),
        captionPicture: (_chatId: string, messageId: string) => {
          captionCalls.push(messageId);
          return Promise.resolve({ chat: captioned });
        },
        nextReply: () => Promise.resolve({ chat: captioned, reply: null }),
      },
    );
    store.pendingImages.set(['data:image/png;base64,aGVsbG8=']);
    expect(store.send('look')).toBe(true);
    await tick();
    await tick();
    expect(captionCalls).toEqual(['msg-2']);
    expect(store.chat()?.messages[1].text).toBe('a red boat on a calm lake');
  });

  it('does not caption anything when no model of the config can see', async () => {
    const card: ChatMessage = {
      id: 'msg-2',
      role: 'user',
      kind: 'image',
      text: '',
      images: ['chats/chat-1/a.png'],
      timestamp: 2,
    };
    const captionCalls: string[] = [];
    const { store } = await setup(
      // nothing in the config can see
      { llmModels: { blind } },
      {
        postMessage: () =>
          Promise.resolve({
            chat: { ...chat, messages: [...chat.messages, card] },
            messages: [card],
          }),
        captionPicture: (_chatId: string, messageId: string) => {
          captionCalls.push(messageId);
          return Promise.resolve({ chat });
        },
        nextReply: () => Promise.resolve({ chat, reply: null }),
      },
    );
    store.pendingImages.set(['data:image/png;base64,aGVsbG8=']);
    store.send('look');
    await tick();
    await tick();
    expect(captionCalls).toEqual([]);
  });
});
