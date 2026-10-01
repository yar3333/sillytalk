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
import { ChatStore } from '../services/chat-store';
import { ConfigStore } from '../services/config-store';
import {
  chatLabelOf,
  chatTimeOf,
  chatUserLabelOf,
  messageCountLabel,
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
    mediaUrl: (chatId: string, name: string) =>
      `http://localhost:3000/api/chats/${chatId}/files/${name}`,
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
  const mediaUrl = (chatId: string, name: string) =>
    `http://localhost:3000/api/chats/${chatId}/files/${name}`;
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
      characterIds: ['c1'],
      userId: 'u1',
      modelId: 'm1',
      messages: [message],
    });
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('startEdit substitutes the text into the field and resolves the image preview', async () => {
    const { fixture, el } = fixtureWith({
      id: 'msg-1',
      role: 'user',
      text: 'Hello with an image',
      images: ['img-1.png'],
      timestamp: 1,
    });

    store.startEdit(store.chat()!.messages[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('Hello with an image');
    const img = el.querySelector('.pending img') as HTMLImageElement;
    expect(img.src).toBe(mediaUrl('chat-1', 'img-1.png'));
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
    fixture.detectChanges();
    await fixture.whenStable();

    const ta = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('hello');
    expect(store.pendingImages()).toEqual(['img-1.png']);

    store.cancelEdit();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(ta.value).toBe('');
    expect(store.pendingImages()).toEqual([]);
    expect(el.querySelector('[data-testid=edit-bar]')).toBeNull();
  });
});

describe('ChatStore — empty send ("another message from the AI")', () => {
  const baseChat: Chat = {
    id: 'chat-1',
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
