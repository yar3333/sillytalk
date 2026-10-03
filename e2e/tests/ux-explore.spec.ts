import fs from 'fs';
import path from 'path';
import { test, expect, Page } from '@playwright/test';
import {
  MockLlm,
  dataUrl,
  makePng,
  setupMockGenerator,
  startMockLlm,
} from '../helpers/mocks';

// The UX exploration suite. Unlike a real-model run it uses the shared mocks
// (helpers/mocks.ts): a deterministic OpenAI-compatible LLM (with a
// controllable delay) and a mock local-program image generator, so every
// scenario is fast and does not depend on the user's real models. Each test
// records a video (test-results/) and screenshots (screenshots/); findings are
// printed as [UX-ISSUE] lines in the reporter output.

const API = 'http://localhost:3211/api';
const SHOTS = 'screenshots';
const DATA = path.resolve(__dirname, '..', 'test-data');
const ASSETS = path.join(DATA, 'ux-assets');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

test.use({ video: 'on' });

let llm: MockLlm | null = null;

// ------------------------------------------------------------- helpers
let issues: string[] = [];
const issue = (text: string) => {
  issues.push(text);
  console.log(`[UX-ISSUE] ${text}`);
};
const step = (label: string, ms: number) => console.log(`[UX] ${label}: ${ms} ms`);

async function api(p: string, method = 'GET', body?: unknown): Promise<unknown> {
  const res = await fetch(API + p, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
  return res.json();
}

async function setDelay(ms: number): Promise<void> {
  if (llm) await llm.setDelay(ms);
}

async function clearChats(): Promise<void> {
  const chats = (await api('/chats')) as Array<{ id: string }>;
  await Promise.all(chats.map((c) => api(`/chats/${c.id}`, 'DELETE')));
}

async function setupCatalog(): Promise<void> {
  await api('/users', 'PUT', {
    users: [
      { id: 'carol', name: 'Carol', description: 'A regular user.' },
      { id: 'dave', name: 'Dave', description: 'A second persona.' },
    ],
  });
  await api('/characters', 'PUT', {
    characters: [
      { id: 'alice', name: 'Alice', description: 'A friendly companion.' },
      { id: 'bob', name: 'Bob', description: 'A talkative friend.' },
    ],
  });
  const cfg = (await api('/config')) as Record<string, unknown>;
  const gen = setupMockGenerator(ASSETS);
  await api('/config', 'PUT', {
    ...cfg,
    llmModels: {
      'mock model': {
        id: 'mock',
        baseUrl: llm?.baseUrl ?? 'http://127.0.0.1:0/v1',
        contextSize: 8192,
        supportsImages: true,
      },
    },
    imageGenerators: [gen.generator],
  });
  // Avatars and a character photo: written/uploaded directly, the catalog
  // sync keeps existing folders.
  const photo = makePng(320, 240, 40, 80, 200);
  fs.mkdirSync(path.join(DATA, 'characters', 'alice', 'photos'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'characters', 'alice', 'photos', 'photo1.png'), photo);
  await api('/users/carol/avatar', 'POST', { data: dataUrl(makePng(64, 64, 140, 60, 160)) });
  await api('/characters/alice/avatar', 'POST', { data: dataUrl(makePng(64, 64, 60, 140, 60)) });
  await api('/characters/bob/avatar', 'POST', { data: dataUrl(makePng(64, 64, 180, 120, 40)) });
}

// Seeds a conversation through the API (fast — the mock delay is respected,
// so set delay 0 before seeding many rounds). Returns the chat id.
async function seedChat(rounds: number, charIds: string[] = ['alice']): Promise<string> {
  const chat = (await api('/chats', 'POST', {
    characterIds: charIds,
    modelId: 'mock model',
    userId: 'carol',
  })) as { id: string };
  for (let i = 0; i < rounds; i++) {
    await api(`/chats/${chat.id}/messages`, 'POST', {
      text: `Message ${i + 1}`,
      images: [],
    });
    await api(`/chats/${chat.id}/reply`, 'POST', { characterId: charIds[0] });
  }
  return chat.id;
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();
}

const assistantMsgs = (page: Page) => page.locator('.msg:not(.user):not(.error)');
const allMsgs = (page: Page) => page.locator('[data-testid=message]');

// The model-initiated image tags: when the user asks the model to draw, it
// inserts an [IMG:...] tag; when it should show a photo, a [PHOTO:1] tag.
// Everything else — the default "Mock reply from <name>.".
function drawReplies(args: { text: string; name: string }): string | null {
  if (/draw|picture/i.test(args.text)) {
    return 'Here, I made this for you.\n[IMG:a small red circle on a white background]';
  }
  if (/photo|show me/i.test(args.text)) {
    return 'Of course, here you go.\n[PHOTO:1]';
  }
  return null;
}

// ------------------------------------------------------------------ setup
test.beforeAll(async () => {
  issues = [];
  llm = await startMockLlm(300, { drawReplies });
});

test.afterAll(() => {
  llm?.close();
  llm = null;
});

test.beforeEach(async () => {
  issues = [];
  await setDelay(300);
  await setupCatalog();
  await clearChats();
});

// ------------------------------------------------------------------ tests

test('UX 01: empty state + empty-send error banner', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.empty')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-01a-empty.png` });
  await page.getByTestId('send').click();
  await expect(page.getByTestId('error-banner')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-01b-empty-send-banner.png` });
});

test('UX 02: baseline send — typing indicator, cancel button, reply', async ({ page }) => {
  await setDelay(1200);
  await openApp(page);
  await page.getByTestId('input').fill('Hello Alice!');
  const t0 = Date.now();
  await page.getByTestId('send').click();
  await expect(page.locator('.msg.user').first()).toBeVisible();
  step('02 user message shown', Date.now() - t0);
  await expect(page.getByTestId('typing')).toBeVisible();
  await expect(page.getByTestId('send')).toHaveText('✕');
  await page.screenshot({ path: `${SHOTS}/ux-02a-typing.png` });
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 20000 });
  step('02 reply total (delay 1200)', Date.now() - t0);
  await expect(page.getByTestId('typing')).toBeHidden();
  await expect(page.getByTestId('send')).toHaveText('➤');
  await page.screenshot({ path: `${SHOTS}/ux-02b-reply.png` });
});

test('UX 03: regenerate — in-place border wave on the old message', async ({ page }) => {
  await setDelay(400);
  await openApp(page);
  await page.getByTestId('input').fill('Hello Alice!');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('typing')).toBeHidden();

  await setDelay(2000);
  const regen = page.locator('.msg-edit.regen');
  // The action buttons are display:none until the bubble is hovered.
  await assistantMsgs(page).last().hover();
  const t0 = Date.now();
  await regen.click();
  // The old message stays visible (dimmed) with an in-place "Regenerating…"
  // state — a wave of brightness runs around the bubble's border.
  await expect(assistantMsgs(page)).toHaveCount(1);
  await expect(page.locator('.msg.regenerating')).toBeVisible();
  // No separate "typing" row below.
  await expect(page.getByTestId('typing')).toBeHidden();
  step('03 in-place indicator appeared after ↻', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-03a-regen-inplace.png` });
  await expect(page.locator('.msg.regenerating')).toBeHidden({ timeout: 20000 });
  step('03 regenerate total (delay 2000)', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-03b-regen-done.png` });
});

test('UX 04: cancel during regeneration keeps the original reply', async ({ page }) => {
  await setDelay(300);
  await openApp(page);
  await page.getByTestId('input').fill('Hello Alice!');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  const originalText = await assistantMsgs(page).first().locator('.msg-text').textContent();
  await expect(page.getByTestId('typing')).toBeHidden();

  await setDelay(5000);
  const regen = page.locator('.msg-edit.regen');
  await assistantMsgs(page).last().hover();
  await regen.click();
  await expect(page.locator('.msg.regenerating')).toBeVisible();
  // The user changes their mind — cancel (the ✕ send button).
  await page.getByTestId('send').click();
  await expect(page.locator('.msg.regenerating')).toBeHidden({ timeout: 10000 });
  // The original reply is kept (the backend removes it only after the new
  // one is saved; a cancel never reaches that point).
  await expect(assistantMsgs(page)).toHaveCount(1);
  await expect(assistantMsgs(page).first().locator('.msg-text')).toHaveText(originalText?.trim() ?? '');
  await page.screenshot({ path: `${SHOTS}/ux-04-regen-cancel-kept.png` });
});

test('UX 05: delete — single (arm, two clicks) and tail (confirm)', async ({
  page,
}) => {
  await setDelay(0);
  await seedChat(4); // 8 messages
  await openApp(page);
  await expect(allMsgs(page)).toHaveCount(8);

  // One dialog handler for the whole test, with a mode flag.
  let dialogMode: 'dismiss' | 'accept' = 'dismiss';
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    if (dialogMode === 'accept') d.accept();
    else d.dismiss();
  });

  // ---- Single delete (🗑): the FIRST click only ARMS the button (it turns
  // red) — nothing is removed and no dialog appears. The SECOND click within
  // the ~2 s window deletes the row (optimistic removal). ----
  dialogMode = 'dismiss';
  const last = allMsgs(page).last();
  await last.hover();
  const delBtn = last.locator('.msg-edit.del');
  await delBtn.click();
  await expect(delBtn).toHaveClass(/armed/);
  await expect(allMsgs(page)).toHaveCount(8); // armed, not deleted yet
  expect(dialogs).toBe(0); // no confirm for the single delete
  const t0 = Date.now();
  await delBtn.click(); // confirm
  await expect(allMsgs(page)).toHaveCount(7);
  step('05 single delete (two clicks) -> DOM updated', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-05a-delete-single.png` });

  // A single delete of a MIDDLE message removes only that row — the messages
  // that follow it are kept (unlike the tail delete).
  const midDel = allMsgs(page).nth(3);
  await midDel.hover();
  const midDelBtn = midDel.locator('.msg-edit.del');
  await midDelBtn.click(); // arm
  await midDelBtn.click(); // confirm
  await expect(allMsgs(page)).toHaveCount(6);
  await expect(allMsgs(page).filter({ hasText: 'Message 3' })).toHaveCount(1);
  step('05 single delete (middle) keeps the later messages', 1);

  // The armed state disarms on its own after the ~2 s window — a lone first
  // click never deletes the message.
  const next = allMsgs(page).last();
  await next.hover();
  const delBtn2 = next.locator('.msg-edit.del');
  await delBtn2.click();
  await expect(delBtn2).toHaveClass(/armed/);
  await page.waitForTimeout(2500);
  await expect(delBtn2).not.toHaveClass(/armed/);
  await expect(allMsgs(page)).toHaveCount(6); // nothing removed by the lone click
  step('05 armed state disarms after the window', 1);

  // ---- Tail delete (🧹): a confirm() dialog; accepting it removes the
  // message and everything after it at once. ----
  dialogMode = 'accept';
  dialogs = 0;
  const first = allMsgs(page).first();
  await first.hover();
  await first.locator('.msg-edit.del-more').click();
  await expect(allMsgs(page)).toHaveCount(0);
  expect(dialogs).toBe(1); // the confirm was shown
  await page.screenshot({ path: `${SHOTS}/ux-05b-delete-truncated-all.png` });

  // Dismissing the confirm keeps everything.
  await seedChat(3); // 6 messages
  await page.goto('/');
  await expect(allMsgs(page)).toHaveCount(6);
  dialogs = 0;
  dialogMode = 'dismiss';
  const mid = allMsgs(page).nth(1);
  await mid.hover();
  await mid.locator('.msg-edit.del-more').click();
  await page.waitForTimeout(300);
  expect(dialogs).toBe(1); // the confirm was shown
  await expect(allMsgs(page)).toHaveCount(6); // nothing removed
});

test('UX 06: delete in a long chat (60 messages) — latency', async ({ page }) => {
  await setDelay(0);
  await seedChat(30); // 60 messages
  await openApp(page);
  await expect(allMsgs(page)).toHaveCount(60);
  const last = allMsgs(page).last();
  await last.hover();
  const delBtn = last.locator('.msg-edit.del');
  await delBtn.click(); // arm
  const t0 = Date.now();
  await delBtn.click(); // confirm -> optimistic removal
  await expect(allMsgs(page)).toHaveCount(59);
  step('06 delete in a 60-message chat -> DOM updated', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-06-delete-long-chat.png` });
});

test('UX 07: Enter while generating cancels the reply and keeps the typed text', async ({
  page,
}) => {
  await setDelay(3000);
  await openApp(page);
  // Accept the "cancel the generation?" confirm (a typed message + Enter
  // must not silently abort the in-flight reply).
  page.on('dialog', (d) => d.accept());
  await page.getByTestId('input').fill('Hi Alice!');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('typing')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('input').fill('my next message');
  await page.keyboard.press('Enter');
  // The confirm is shown and, when accepted, the generation is cancelled and
  // the typed text stays in the field (not sent, not queued).
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 10000 });
  await expect(page.getByTestId('send')).toHaveText('➤');
  const kept = await page.getByTestId('input').inputValue();
  expect(kept).toBe('my next message');
  await page.screenshot({ path: `${SHOTS}/ux-07-enter-cancels.png` });
});

test('UX 08: edit flow — focus, edit bar, save and cancel', async ({ page }) => {
  await setDelay(0);
  await seedChat(2);
  await openApp(page);
  await expect(allMsgs(page)).toHaveCount(4);
  const firstUser = page.locator('.msg.user').first();
  await firstUser.hover();
  await firstUser.locator('.msg-edit.edit').click();
  await expect(page.getByTestId('edit-bar')).toBeVisible();
  await expect(page.getByTestId('input')).toHaveValue('Message 1');
  const focused = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA');
  step('08 textarea focused after ✎ (1 = yes)', focused ? 1 : 0);
  if (!focused) issue('edit: the input field is not focused when editing starts');
  await page.screenshot({ path: `${SHOTS}/ux-08a-editing.png` });
  await page.getByTestId('input').fill('Edited first message');
  await page.getByTestId('send').click();
  await expect(firstUser.locator('.msg-text')).toContainText('Edited first', { timeout: 15000 });
  await expect(page.getByTestId('edit-bar')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/ux-08b-edited.png` });
  // Cancel the edit: the field is cleared back to the empty compose state.
  const second = allMsgs(page).nth(2);
  await second.hover();
  await second.locator('.msg-edit.edit').click();
  await expect(page.getByTestId('edit-bar')).toBeVisible();
  await page.locator('[data-testid=edit-bar] .icon-btn').click();
  await expect(page.getByTestId('edit-bar')).toBeHidden();
  await expect(page.getByTestId('input')).toHaveValue('');
});

test('UX 09: attachments — preview, remove, send with an image', async ({ page }) => {
  const attach = path.join(ASSETS, 'attach.png');
  fs.writeFileSync(attach, makePng(240, 160, 200, 120, 40));
  await setDelay(300);
  await openApp(page);
  await page.setInputFiles('[data-testid=attach] input', attach);
  await expect(page.locator('.pending-thumb')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-09a-attached.png` });
  await page.locator('.thumb-x').click();
  await expect(page.locator('.pending-thumb')).toHaveCount(0);
  // Re-attach and send.
  await page.setInputFiles('[data-testid=attach] input', attach);
  await page.getByTestId('input').fill('Look at this picture');
  await page.getByTestId('send').click();
  await expect(page.locator('.msg.user').first()).toBeVisible();
  await expect(page.locator('.msg.user .msg-images img').first()).toBeVisible({
    timeout: 15000,
  });
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/ux-09b-image-sent.png` });
});

test('UX 10: gen mode — draw, pending, ready; cancel -> broken; fail', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('gen-toggle')).toBeVisible();
  await page.getByTestId('gen-toggle').click();
  await expect(page.locator('.gen-bar')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-10a-gen-mode.png` });

  // Draw: the placeholder appears in an assistant message right away…
  await page.getByTestId('input').fill('a red circle');
  const t0 = Date.now();
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  step('10 pending placeholder after Draw', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-10b-pending.png` });
  // …the chat is NOT blocked while the image generates in the background.
  await expect(page.getByTestId('send')).toHaveText('➤');
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 20000 });
  await expect(page.locator('.msg-images img').first()).toBeVisible();
  step('10 image ready total', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-10c-ready.png` });

  // Slow draw, then cancel -> the "cancelled" placeholder (not an error) with Regenerate.
  await page.getByTestId('gen-toggle').click();
  await page.getByTestId('input').fill('slow scene');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('img-cancel').click();
  await expect(page.getByTestId('img-cancelled')).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/ux-10d-cancelled.png` });
  await expect(page.getByTestId('img-regen')).toBeVisible();

  // Regenerate the cancelled one -> pending -> ready.
  await page.getByTestId('img-regen').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 20000 });

  // A failing generator -> the broken placeholder carries the error text.
  await page.getByTestId('gen-toggle').click();
  await page.getByTestId('input').fill('fail please');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-broken').last()).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/ux-10e-failed.png` });
});

test('UX 11: model-initiated [IMG] and [PHOTO:1]', async ({ page }) => {
  await setDelay(400);
  await openApp(page);
  await page.getByTestId('input').fill('please draw a picture for me');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  // The [IMG] tag became a pending placeholder INSIDE the reply message.
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/ux-11a-img-tag-pending.png` });
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 25000 });
  await expect(page.locator('.msg-images img').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-11b-img-tag-ready.png` });

  await page.getByTestId('input').fill('show me a photo');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page)).toHaveCount(2, { timeout: 15000 });
  // The [PHOTO:1] attaches the character photo with no pending state.
  await expect(page.locator('.msg-images img').nth(1)).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/ux-11c-photo-tag.png` });
});

test('UX 12: model failure -> red error bubble', async ({ page }) => {
  const cfg = (await api('/config')) as {
    llmModels: Record<string, unknown>;
    [key: string]: unknown;
  };
  cfg.llmModels['broken model'] = {
    id: 'broken',
    baseUrl: 'http://127.0.0.1:9/v1',
    contextSize: 1024,
    supportsImages: false,
  };
  await api('/config', 'PUT', cfg);
  await api('/chats', 'POST', {
    characterIds: ['alice'],
    modelId: 'broken model',
    userId: 'carol',
  });
  await openApp(page);
  await page.getByTestId('input').fill('Hi!');
  await page.getByTestId('send').click();
  await expect(page.locator('.msg.error')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('typing')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/ux-12-error-bubble.png` });
});

test('UX 13: reading up is not yanked to the bottom by a new message', async ({
  page,
}) => {
  await setDelay(0);
  await seedChat(12); // 24 messages
  await setDelay(600);
  await openApp(page);
  await expect(allMsgs(page)).toHaveCount(24);
  // Scroll up and dispatch a real wheel event so the app notices the user is
  // no longer at the bottom (the auto-scroll only follows when at the bottom).
  await page.evaluate(() => {
    const h = document.querySelector('[data-testid=history]');
    if (h) {
      h.scrollTop = 0;
      h.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    }
  });
  await page.waitForTimeout(200);
  const before = await page.evaluate(
    () => document.querySelector('[data-testid=history]')?.scrollTop ?? -1,
  );
  await page.getByTestId('input').fill('Hello again');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page)).toHaveCount(13, { timeout: 15000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(
    () => document.querySelector('[data-testid=history]')?.scrollTop ?? -1,
  );
  step(`13 history scrollTop before=${before} after=${after}`, after - before);
  expect(after).toBeLessThan(before + 200); // the reading position is kept
  await page.screenshot({ path: `${SHOTS}/ux-13-scroll-kept.png` });
});

test('UX 14: long word / long text overflow', async ({ page }) => {
  await setDelay(0);
  const chatId = await seedChat(1);
  await api(`/chats/${chatId}/messages`, 'POST', {
    text: 'X'.repeat(300) + ' end of the long word',
    images: [],
  });
  await openApp(page);
  await page.waitForTimeout(300);
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const historyOverflow = await page.evaluate(() => {
    const h = document.querySelector('[data-testid=history]');
    return h ? h.scrollWidth - h.clientWidth : -1;
  });
  step(`14 overflow page=${pageOverflow}px history=${historyOverflow}px`, pageOverflow);
  if (pageOverflow > 2) issue(`long words overflow the page by ${pageOverflow}px (horizontal scroll)`);
  if (historyOverflow > 2) issue(`long words overflow the history container by ${historyOverflow}px`);
  await page.screenshot({ path: `${SHOTS}/ux-14-overflow.png` });
});

test('UX 15: mobile — layout, message actions without hover, menus', async ({ page }) => {
  await setDelay(0);
  await seedChat(2);
  await openApp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (pageOverflow > 2) issue(`mobile: the page is ${pageOverflow}px wider than the viewport`);
  await page.screenshot({ path: `${SHOTS}/ux-15a-mobile.png` });

  // Message action buttons: on real touch devices (@media (hover:none)) they
  // are always visible (compact, at the top of the bubble) so a tap never hits
  // an invisible button. This Chromium emulates hover, so the buttons stay
  // hidden until a hover — we only check they are reachable via hover here.
  const msg = allMsgs(page).first();
  await msg.hover();
  const delVisible = await msg.locator('.msg-edit.del').isVisible();
  step(`15 message actions visible on hover = ${delVisible}`, 0);
  expect(delVisible).toBe(true);
  await page.screenshot({ path: `${SHOTS}/ux-15b-mobile-message-actions.png` });

  // The participants/persona menus: on a narrow screen the names may collapse
  // to zero width — then their menus are unreachable on a phone.
  const charNameVisible = await page.getByTestId('char-name').isVisible();
  const userNameVisible = await page.getByTestId('user-name').isVisible();
  step(`15 mobile header: char-name visible = ${charNameVisible}, user-name visible = ${userNameVisible}`, 0);
  if (!charNameVisible || !userNameVisible) {
    issue(
      'mobile: the participant and persona names in the header collapse to zero width ' +
        `char=${charNameVisible} / user=${userNameVisible} — their menus (participants, persona switch) are unreachable on a phone`,
    );
  }
  if (charNameVisible) {
    await page.getByTestId('char-name').click();
    await expect(page.getByTestId('char-option').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ux-15c-mobile-participants.png` });
    await page.mouse.click(10, 400);
  }
  if (userNameVisible) {
    await page.getByTestId('user-name').click();
    await expect(page.getByTestId('user-option').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ux-15d-mobile-persona.png` });
    await page.mouse.click(10, 400);
  }
  await page.getByTestId('model-chip').click();
  await expect(page.getByTestId('model-option').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-15e-mobile-model.png` });
  await page.mouse.click(10, 400);
  await page.getByTestId('chat-date').click();
  await expect(page.getByTestId('new-chat')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-15f-mobile-chat-menu.png` });
  await page.mouse.click(10, 400);
  await page.getByTestId('menu').click();
  await page.getByTestId('settings').click();
  await expect(page.locator('.settings-body')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-15g-mobile-settings.png` });
});

test('UX 16: clicking a chat image adds a gen reference silently (no lightbox)', async ({
  page,
}) => {
  await setDelay(200);
  await openApp(page);
  await page.getByTestId('input').fill('please draw a picture');
  await page.getByTestId('send').click();
  await expect(page.locator('.msg-images img').first()).toBeVisible({ timeout: 30000 });
  // Click the image: it opens the lightbox (enlarged) AND adds a generation
  // reference — the action is now visible, no longer silent.
  await page.locator('.msg-images img').first().click();
  await expect(page.getByTestId('lightbox')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: `${SHOTS}/ux-16-lightbox.png` });
  // The reference is really there: opening the gen mode shows the chip.
  await page.getByTestId('lightbox-close').click();
  await expect(page.getByTestId('lightbox')).toBeHidden();
  await page.getByTestId('gen-toggle').click();
  await expect(page.locator('.gen-bar .chip')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-16-ref-chip.png` });
});

// The collected issues are attached to every test run as a JSON artifact.
test.afterEach(async ({ page }, testInfo) => {
  if (issues.length > 0) {
    await testInfo.attach('ux-issues.json', {
      body: JSON.stringify(issues, null, 2),
      contentType: 'application/json',
    });
  }
  void page;
});
