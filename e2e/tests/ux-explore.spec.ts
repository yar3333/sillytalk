import fs from 'fs';
import path from 'path';
import { test, expect, Page } from '@playwright/test';
import {
  MockComfy,
  MockLlm,
  dataUrl,
  makePng,
  startMockComfy,
  startMockLlm,
} from '../helpers/mocks';

// The UX exploration suite. Unlike a real-model run it uses the shared mocks
// (helpers/mocks.ts): a deterministic OpenAI-compatible LLM (with a
// controllable delay) and a mock ComfyUI server, so every scenario is fast and
// does not depend on the user's real models or on a running ComfyUI. Each test
// records a video (test-results/) and screenshots (screenshots/); findings are
// printed as [UX-ISSUE] lines in the reporter output.

const API = 'http://localhost:3211/api';
const SHOTS = 'screenshots';
const DATA = path.resolve(__dirname, '..', 'test-data');
const ASSETS = path.join(DATA, 'ux-assets');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

test.use({ video: 'on' });

let llm: MockLlm | null = null;
let comfy: MockComfy | null = null;

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
  await api('/persons', 'PUT', {
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
    imageGenerators: comfy ? [comfy.generator] : [],
  });
  // Avatars and a character photo: written/uploaded directly, the catalog
  // sync keeps existing folders. The character's picture lives in its folder
  // (no photos/ subfolder any more); the avatar POST picks a disk file and the
  // server keeps its id in the row.
  const photo = makePng(320, 240, 40, 80, 200);
  fs.mkdirSync(path.join(DATA, 'characters', 'alice'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'characters', 'alice', 'photo1.png'), photo);
  await api('/persons/carol/avatar', 'POST', { data: dataUrl(makePng(64, 64, 140, 60, 160)) });
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
// A picture card (the message kind that carries an image) and its ready image.
const cards = (page: Page) => page.getByTestId('image-card');
const cardImages = (page: Page) => page.locator('[data-testid=image-card] img');

// ------------------------------------------------------------------ setup
test.beforeAll(async () => {
  issues = [];
  llm = await startMockLlm(300);
  comfy = await startMockComfy();
  // The scratch folder of the attachment tests (UX 09 writes its picture here).
  fs.mkdirSync(ASSETS, { recursive: true });
});

test.afterAll(async () => {
  // The grace period before the mocks go away: a test that ends with its model
  // call still in flight would otherwise have the mock closed under that call,
  // and the backend would answer itself with a "fetch failed" error bubble in
  // the chat the next test then reads. (Same reason as in app.spec.ts.)
  await new Promise((resolve) => setTimeout(resolve, 1500));
  llm?.close();
  llm = null;
  comfy?.close();
  comfy = null;
});

// What the mock answers to the picture-planning call of the user's turn (null
// = the model does not produce a readable plan).
async function setPlan(plan: {
  name?: string;
  description?: string;
  prompt?: string;
  refs?: number[];
} | null): Promise<void> {
  if (llm) await llm.setImagePlan(plan);
}

test.beforeEach(async () => {
  issues = [];
  await setDelay(300);
  await setPlan({
    name: 'red circle on paper',
    description: 'A red circle drawn on a white paper sheet',
    prompt: 'a red circle on a white background',
    refs: [],
  });
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

test('UX 05: delete — single and tail (both armed, two clicks)', async ({
  page,
}) => {
  await setDelay(0);
  await seedChat(4); // 8 messages
  await openApp(page);
  await expect(allMsgs(page)).toHaveCount(8);

  // Neither delete button uses a dialog — the confirm is the armed state of the
  // button, so any dialog during this test is a regression (it gets dismissed).
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    d.dismiss();
  });

  // ---- Single delete (🗑): the FIRST click only ARMS the button (it turns
  // red) — nothing is removed and no dialog appears. The SECOND click within
  // the ~2 s window deletes the row (optimistic removal). ----
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

  // ---- Tail delete (🧹): armed exactly like the single delete — the first
  // click only turns the button red, the second removes the message and
  // everything after it at once. ----
  const first = allMsgs(page).first();
  await first.hover();
  const tailBtn = first.locator('.msg-edit.del-more');
  await tailBtn.click();
  await expect(tailBtn).toHaveClass(/armed/);
  await expect(allMsgs(page)).toHaveCount(6); // armed, the tail is still there
  const t1 = Date.now();
  await tailBtn.click(); // confirm
  await expect(allMsgs(page)).toHaveCount(0);
  step('05 tail delete (two clicks) -> chat truncated', Date.now() - t1);
  expect(dialogs).toBe(0); // no confirm dialog
  await page.screenshot({ path: `${SHOTS}/ux-05b-delete-truncated-all.png` });

  // A lone first click of the tail delete disarms after the ~2 s window and
  // keeps the messages.
  await seedChat(3); // 6 messages
  await page.goto('/');
  await expect(allMsgs(page)).toHaveCount(6);
  const mid = allMsgs(page).nth(1);
  await mid.hover();
  const midTail = mid.locator('.msg-edit.del-more');
  await midTail.click();
  await expect(midTail).toHaveClass(/armed/);
  await page.waitForTimeout(2500);
  await expect(midTail).not.toHaveClass(/armed/);
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

test('UX 09: attachments — preview, remove, send as a picture card', async ({ page }) => {
  const attach = path.join(ASSETS, 'attach.png');
  fs.writeFileSync(attach, makePng(240, 160, 200, 120, 40));
  await setDelay(300);
  await openApp(page);
  await page.setInputFiles('[data-testid=attach] input', attach);
  await expect(page.locator('.pending-thumb')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-09a-attached.png` });
  await page.locator('.thumb-x').click();
  await expect(page.locator('.pending-thumb')).toHaveCount(0);
  // Re-attach and send: the text and the picture become TWO user messages —
  // what was typed and a card holding the picture.
  await page.setInputFiles('[data-testid=attach] input', attach);
  await page.getByTestId('input').fill('Look at this picture');
  await page.getByTestId('send').click();
  await expect(page.locator('.msg.user').first()).toContainText('Look at this picture');
  const card = page.locator('.msg.user').filter({ has: page.getByTestId('image-card') });
  await expect(card.locator('img').first()).toBeVisible({ timeout: 15000 });
  // The vision model captions the picture by itself: the card's line is what a
  // chat model that cannot see is told about it in the history.
  await expect(card.first().getByTestId('card-caption')).toContainText(
    'described by the mock model',
    { timeout: 15000 },
  );
  await page.screenshot({ path: `${SHOTS}/ux-09b-image-sent.png` });
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 15000 });
  // A picture with no text at all is just the card. It has to wait for its
  // turn: during a generation the send button is the cancel, so the reply
  // above has to finish first.
  await page.setInputFiles('[data-testid=attach] input', attach);
  await page.getByTestId('send').click();
  await expect(cards(page)).toHaveCount(2, { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/ux-09c-picture-only.png` });
});

test('UX 10: gen mode — draw, pending, ready; cancel -> broken; fail', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('gen-toggle')).toBeVisible();
  await page.getByTestId('gen-toggle').click();
  await expect(page.locator('.gen-bar')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-10a-gen-mode.png` });

  // Draw: a placeholder card appears right away…
  await page.getByTestId('input').fill('a red circle');
  const t0 = Date.now();
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  step('10 pending placeholder after Draw', Date.now() - t0);
  await page.screenshot({ path: `${SHOTS}/ux-10b-pending.png` });
  // …the chat is NOT blocked while the image generates in the background.
  await expect(page.getByTestId('send')).toHaveText('➤');
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 20000 });
  await expect(cardImages(page).first()).toBeVisible();
  // The card says what the picture was drawn from.
  await expect(page.getByTestId('card-prompt')).toContainText('red circle');
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

test('UX 10b: the picture editor — the prompt, the description, the file kind', async ({ page }) => {
  await openApp(page);
  // Draw a picture to edit.
  await page.getByTestId('gen-toggle').click();
  await page.getByTestId('input').fill('a red circle');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  await expect(cardImages(page).first()).toBeVisible({ timeout: 20000 });
  const card = page.locator('.msg.user').filter({ has: page.getByTestId('image-card') }).last();
  await expect(card.getByTestId('card-prompt')).toContainText('a red circle');

  // The ✎ of a card opens the picture editor (not the bottom edit field).
  await card.hover();
  await card.locator('.msg-edit.edit').click();
  const dialog = page.getByTestId('picture-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('picture-kind-generated')).toBeChecked();
  await expect(page.getByTestId('picture-prompt')).toHaveValue('a red circle');
  await page.screenshot({ path: `${SHOTS}/ux-10b-editor.png` });

  // "From the chat": the model writes the prompt — and the description the
  // card never had.
  await page.getByTestId('picture-prompt-from-chat').click();
  await expect(page.getByTestId('picture-prompt')).toHaveValue('a red circle on a white background', {
    timeout: 20000,
  });
  await expect(page.getByTestId('picture-description')).toHaveValue('A red circle drawn on a white paper sheet');

  // "Make it English" rewrites a typed prompt for the generator.
  await page.getByTestId('picture-prompt').fill('круг');
  await page.getByTestId('picture-prompt-english').click();
  await expect(page.getByTestId('picture-prompt')).toHaveValue('a red circle on a white background', {
    timeout: 20000,
  });

  // "Describe the picture": the model looks at the picture and replaces the
  // description.
  await page.getByTestId('picture-describe').click();
  await expect(page.getByTestId('picture-description')).toHaveValue(/described by the mock model/, {
    timeout: 20000,
  });

  await page.getByTestId('picture-save').click();
  await expect(dialog).toBeHidden();
  await expect(card.getByTestId('card-prompt')).toContainText('a red circle on a white background');
  await expect(card.getByTestId('card-caption')).toContainText('described by the mock model');
  await page.screenshot({ path: `${SHOTS}/ux-10b-saved.png` });

  // "From a file": pick the character picture of the data folder — the card
  // points at it and stops claiming a generation (no prompt, no redraw).
  await card.hover();
  await card.locator('.msg-edit.edit').click();
  await page.getByTestId('picture-kind-file').check();
  await expect(page.getByTestId('picture-prompt')).toHaveCount(0);
  await page.getByTestId('picture-id').selectOption('characters/alice/photo1.png');
  await page.getByTestId('picture-save').click();
  await expect(dialog).toBeHidden();
  await expect(card.locator('[data-testid=image-card] img')).toHaveAttribute('src', /photo1\.png/);
  await expect(card.getByTestId('card-prompt')).toHaveCount(0);
  await expect(card.getByTestId('img-regenerate')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ux-10b-file.png` });
});

test('UX 11: the picture of the user turn (the 📷 button)', async ({ page }) => {
  await setDelay(200);
  await openApp(page);
  // The button belongs to the user turn only: an empty chat has none.
  await expect(page.getByTestId('auto-image')).toHaveCount(0);
  await page.getByTestId('input').fill('Tell me about the weather');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  // Now it is the user's turn — the 📷 appeared.
  await expect(page.getByTestId('auto-image')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-11a-turn-button.png` });

  const before = await allMsgs(page).count();
  await page.getByTestId('auto-image').click();
  // The placeholder card is in the chat right away (the plan + the drawing run
  // in the background), showing what the app is doing at the moment.
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('img-pending')).toContainText('Planning and drawing');
  expect(await allMsgs(page).count()).toBe(before + 1);
  // The user is not blocked: the input and the send button work as usual.
  await expect(page.getByTestId('send')).toHaveText('➤');
  await page.screenshot({ path: `${SHOTS}/ux-11b-placeholder.png` });

  // The placeholder turns into the planned picture with its caption.
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 25000 });
  await expect(cardImages(page).first()).toBeVisible();
  await expect(page.getByTestId('card-caption')).toContainText('red circle');
  await page.screenshot({ path: `${SHOTS}/ux-11c-planned-picture.png` });

  // The picture is the user's own message now, so it is the characters' turn:
  // the 📷 steps back until they answer.
  await expect(page.getByTestId('auto-image')).toHaveCount(0);
});

test('UX 11b: a plan the model cannot make leaves a broken card, not a dead one', async ({
  page,
}) => {
  await setDelay(100);
  await setPlan(null); // the model answers the planning call with prose
  await openApp(page);
  await page.getByTestId('input').fill('Hi!');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('auto-image').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 10000 });
  // The placeholder never hangs: it becomes the broken card with the reason
  // and a Regenerate button, and the chat keeps working.
  await expect(page.getByTestId('img-broken')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('img-error-text')).toBeVisible();
  await expect(page.getByTestId('img-regen')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-11b2-unplannable.png` });
  // Regenerating it with the same plan fails the same way, and the user can
  // still send a message meanwhile.
  await page.getByTestId('input').fill('anyway, how are you?');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page)).toHaveCount(2, { timeout: 20000 });
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

test('UX 16: clicking a card picture opens the lightbox and makes it a reference', async ({
  page,
}) => {
  await setDelay(200);
  await openApp(page);
  await page.getByTestId('input').fill('Hello Alice');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('auto-image').click();
  await expect(cardImages(page).first()).toBeVisible({ timeout: 30000 });
  // Click the picture: it opens the lightbox (enlarged) AND adds a generation
  // reference — the action is visible, not silent.
  await cardImages(page).first().click();
  await expect(page.getByTestId('lightbox')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: `${SHOTS}/ux-16-lightbox.png` });
  // The reference is really there: opening the gen mode shows the chip.
  await page.getByTestId('lightbox-close').click();
  await expect(page.getByTestId('lightbox')).toBeHidden();
  await page.getByTestId('gen-toggle').click();
  await expect(page.locator('.gen-bar .chip')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-16-ref-chip.png` });
});

// A person in a picture is a FACE the generator has never heard of: the app has
// to hand it the character's own picture and describe them in plain English,
// never write their name into the prompt.
test('UX 17: a person is drawn from their own pictures, never from their name', async ({
  page,
}) => {
  await setDelay(150);
  await setPlan({
    name: 'alice at the harbour',
    description: 'A woman standing at a harbour at sunset',
    prompt: 'a woman standing at a harbour at sunset, looking at the boats',
    refs: [],
    // the plan says who is in it and what the prompt calls her
    cast: ['char:alice'],
    subjects: [{ id: 'char:alice', noun: 'the woman in the green coat' }],
  });
  await openApp(page);
  await page.getByTestId('input').fill('What are you doing this evening?');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('auto-image').click();
  await expect(cardImages(page).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/ux-17-person-from-her-own-photo.png` });

  // What the planner was told: the cast of the conversation, with Alice in it,
  // and the rule that a name never goes into a prompt.
  const asked = llm?.lastPlanRequest();
  expect(asked?.text ?? '').toContain('char:alice');
  expect(asked?.system ?? '').toContain('NEVER write a person');

  // What the generator got: her own picture as the reference, the prompt that
  // binds it to her — and not one word that could be her name.
  const sent = comfy?.prompts() ?? [];
  const prompt = sent[sent.length - 1] ?? '';
  expect(prompt).toContain('the first reference image shows the woman in the green coat');
  expect(prompt.toLowerCase()).not.toContain('alice');
  expect((comfy?.uploads() ?? []).length).toBeGreaterThan(0);
});

// One look for the whole conversation: without it every plan picks its own
// technique and the pictures of one chat look like they came from different apps.
test('UX 18: the picture style of the chat is drawn into every picture', async ({ page }) => {
  await setDelay(150);
  await openApp(page);
  await page.getByTestId('input').fill('Hello Alice');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  const chatId = ((await api('/chats')) as Array<{ id: string }>)[0].id;
  await api(`/chats/${chatId}`, 'PATCH', { stylePrompt: 'watercolour, soft edges' });

  await page.getByTestId('auto-image').click();
  await expect(cardImages(page).first()).toBeVisible({ timeout: 30000 });
  const sent = comfy?.prompts() ?? [];
  expect(sent[sent.length - 1] ?? '').toContain('Style: watercolour, soft edges');
  await page.screenshot({ path: `${SHOTS}/ux-18-chat-style.png` });

  // A regeneration re-uses the stored prompt, which already carries the style —
  // appending it again would stack it once per redraw. (The ↻ of a ready
  // picture is a hover button, like every other action of a message.)
  const card = cards(page).last();
  await card.hover();
  const jobsBefore = (comfy?.prompts() ?? []).length;
  await card.getByTestId('img-regenerate').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 25000 });
  // the one job this redraw started, and the style in it exactly once
  const drawn = (comfy?.prompts() ?? []).slice(jobsBefore);
  expect(drawn).toHaveLength(1);
  expect(drawn[0].split('Style:').length - 1).toBe(1);
  await page.screenshot({ path: `${SHOTS}/ux-18b-regenerated-once.png` });
});

// The vision model: the chat talks with one model and lets another one look at
// pictures. The 👁 next to the model chip names the model that will really look
// (a hover hint, it has no room for a name) and its menu picks one.
test('UX 19: the vision model of the chat (the 👁 chip)', async ({ page }) => {
  // A second model that cannot see, next to the vision-capable chat model.
  const cfg = (await api('/config')) as Record<string, unknown> & {
    llmModels: Record<string, unknown>;
  };
  await api('/config', 'PUT', {
    ...cfg,
    llmModels: {
      ...cfg.llmModels,
      'blind model': {
        id: 'blind',
        baseUrl: llm?.baseUrl ?? 'http://127.0.0.1:0/v1',
        contextSize: 8192,
        supportsImages: false,
      },
    },
  });
  await setDelay(100);
  await openApp(page);

  // Nothing is picked: the chat model can see, so it does both jobs.
  const chip = page.getByTestId('vision-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', /Pictures are described by: mock model/);

  // The menu lists every llm model plus the default row.
  await chip.click();
  await expect(page.getByTestId('vision-option-default')).toBeVisible();
  const options = page.getByTestId('vision-option');
  await expect(options).toHaveText([/mock model/, /blind model/]);
  await page.screenshot({ path: `${SHOTS}/ux-19a-vision-menu.png` });

  // A model that cannot see is an explicit choice — the hint says so instead of
  // pretending the pictures will be described.
  await options.filter({ hasText: 'blind model' }).click();
  await expect(chip).toHaveAttribute('title', /blind model" cannot see pictures/);
  await expect(chip).toHaveClass(/missing/);
  await page.screenshot({ path: `${SHOTS}/ux-19b-blind-pick.png` });

  // Back to the default: the chat model looks again.
  await chip.click();
  await page.getByTestId('vision-option-default').click();
  await expect(chip).not.toHaveClass(/missing/);
  await expect(chip).toHaveAttribute('title', /mock model/);

  // The pick is stored on the chat, not in the browser.
  const chatId = ((await api('/chats')) as Array<{ id: string }>)[0]?.id;
  expect(chatId).toBeTruthy();
  const chat = (await api(`/chats/${chatId}`)) as Record<string, unknown>;
  expect(chat.visionModelId).toBeUndefined();
});

// The picture browser: the whole data folder in one dialog, where the caption
// and the name of a picture are edited OUTSIDE any chat. What proves the data
// has one source: a caption written here is the caption the chat card shows,
// and a rename — an id is a path — moves the file and the chat card follows it.
test('UX 20: the picture browser edits the picture, not a message', async ({ page }) => {
  await setDelay(100);
  await openApp(page);
  await page.getByTestId('input').fill('Hello Alice');
  await page.getByTestId('send').click();
  await expect(assistantMsgs(page).first()).toBeVisible({ timeout: 15000 });
  const chatId = ((await api('/chats')) as Array<{ id: string }>)[0].id;

  // One picture, drawn for the user's turn, ready in the chat.
  await page.getByTestId('auto-image').click();
  await expect(cardImages(page).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/ux-20a-chat-card.png` });

  // Open the browser from the ⋮ menu.
  await page.getByTestId('menu').click();
  await page.getByTestId('picture-library').click();
  const library = page.getByTestId('picture-library').last();
  await expect(library).toBeVisible();
  await expect(page.getByTestId('picture-row').first()).toBeVisible();

  // The chat's picture is listed; its path is the id field.
  const before = (await api('/pictures')) as { pictures: Array<{ id: string; exists: boolean }> };
  const id = before.pictures.find((p) => p.exists && p.id.startsWith('chats/'))!.id;
  await expect(page.getByTestId('picture-id-input')).toHaveValue(id);
  await page.screenshot({ path: `${SHOTS}/ux-20b-library.png` });

  // Edit the description and Save: it lands on the PICTURE row, and the chat
  // card of that picture is the same row, so it re-reads the new caption.
  const caption = 'the circle the user retitled';
  await page.getByTestId('picture-description').fill(caption);
  await page.getByTestId('picture-save').click();
  await expect(async () => {
    const reloaded = (await api(`/chats/${chatId}`)) as {
      messages: Array<{ kind: string; text: string }>;
    };
    const card = reloaded.messages.find((m) => m.kind === 'image');
    expect(card?.text).toBe(caption);
  }).toPass({ timeout: 10000 });

  // Rename the picture: the file moves and the chat card follows the new path.
  const newId = id.slice(0, id.lastIndexOf('/') + 1) + 'a-renamed-circle-1a2b3c.png';
  await page.getByTestId('picture-id-input').fill(newId);
  await expect(page.getByTestId('picture-rename')).toBeEnabled();
  await page.getByTestId('picture-rename').click();
  await expect(async () => {
    const after = (await api('/pictures')) as { pictures: Array<{ id: string }> };
    expect(after.pictures.some((p) => p.id === newId)).toBe(true);
    expect(after.pictures.some((p) => p.id === id)).toBe(false);
  }).toPass({ timeout: 10000 });

  const repointed = (await api(`/chats/${chatId}`)) as {
    messages: Array<{ kind: string; images?: string[] }>;
  };
  expect(repointed.messages.find((m) => m.kind === 'image')?.images).toEqual([newId]);
  await page.screenshot({ path: `${SHOTS}/ux-20c-renamed.png` });

  // The reference count: a second picture whose saved prompt names this one
  // makes the row and the line under the ID field say so — the number is counted
  // from the other rows on every read, so the browser shows it as soon as the
  // catalog is read again.
  const drawn = (await api('/image', 'POST', { chatId, prompt: 'a blue square' })) as {
    message: { images?: string[] };
  };
  const secondId = drawn.message.images?.[0];
  expect(secondId).toBeTruthy();
  await expect(async () => {
    const list = (await api('/pictures')) as { pictures: Array<{ id: string; exists: boolean }> };
    expect(list.pictures.some((p) => p.id === secondId && p.exists)).toBe(true);
  }).toPass({ timeout: 30000 });
  await api('/pictures', 'PATCH', { id: secondId, refs: [newId] });

  // Re-open the browser: the catalog is read again and the count is there.
  await page.getByTestId('picture-library-close').click();
  await page.getByTestId('menu').click();
  await page.getByTestId('picture-library').click();
  const circleRow = page.locator(`[data-testid=picture-row][title="${newId}"]`);
  await expect(circleRow.locator('.lib-refs')).toContainText('1 ref');
  // the picture used by nobody carries no badge
  await expect(page.locator(`[data-testid=picture-row][title="${secondId}"]`).locator('.lib-refs')).toHaveCount(0);
  await circleRow.click();
  await expect(page.getByTestId('picture-used-by')).toContainText('by 1 other');

  // The sort pick: "By ID" orders the list by the path — both pictures live in
  // this chat's files/, so the a-blue-square name sorts before the renamed one.
  // The filter narrows the list to this chat first: the shared test data of the
  // suite holds pictures of earlier runs, and the order is read among these two.
  await page.getByTestId('picture-filter').fill(chatId);
  await expect(page.getByTestId('picture-row')).toHaveCount(2);
  await page.getByTestId('picture-sort').selectOption('id');
  const order = await page.getByTestId('picture-row').evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('title')),
  );
  expect(order).toEqual([secondId, newId]);
  await page.screenshot({ path: `${SHOTS}/ux-20d-sorted-by-id.png` });
  await page.getByTestId('picture-sort').selectOption('newest');
  await page.getByTestId('picture-filter').fill('');

  // A name that is not a picture path is refused, and changes nothing.
  await page.getByTestId('picture-id-input').fill('config.json');
  await page.getByTestId('picture-rename').click();
  await expect(page.getByTestId('error-banner')).toBeVisible({ timeout: 10000 });
  const still = (await api('/pictures')) as { pictures: Array<{ id: string }> };
  expect(still.pictures.some((p) => p.id === newId)).toBe(true);
});

// The disk sync: the pictures are files and the user may touch them outside
// the app. Opening the browser reconciles the table with the disk — a file
// renamed in Explorer takes its row and its chat cards to the new path (the
// match is by extension + size + content hash), a file dropped into a folder
// gets a row of its own.
test('UX 20e: a picture renamed or dropped outside the app is followed by the table', async ({ page }) => {
  await setDelay(50);
  await openApp(page);
  await page.getByTestId('gen-toggle').click();
  await page.getByTestId('input').fill('a red circle');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 20000 });
  const chatId = ((await api('/chats')) as Array<{ id: string }>)[0].id;
  const card = ((await api(`/chats/${chatId}`)) as { messages: Array<{ kind: string; images: string[] }> })
    .messages.find((m) => m.kind === 'image')!;
  const id = card.images[0];

  // Let the server learn the facts of the file (this GET is a sync).
  await api('/pictures');

  // The user renames the file on disk.
  const file = path.join(DATA, ...id.split('/'));
  const moved = path.join(path.dirname(file), 'moved-by-hand.png');
  fs.renameSync(file, moved);
  const movedId = `${id.slice(0, id.lastIndexOf('/') + 1)}moved-by-hand.png`;

  // Opening the browser (any read of the catalog) finds it: the row followed
  // the file, the chat card names the new path, the media route serves it.
  await expect(async () => {
    const after = (await api('/pictures')) as { pictures: Array<{ id: string; exists: boolean }> };
    expect(after.pictures.some((p) => p.id === movedId && p.exists)).toBe(true);
    expect(after.pictures.some((p) => p.id === id)).toBe(false);
  }).toPass({ timeout: 10000 });
  const chatAfter = (await api(`/chats/${chatId}`)) as {
    messages: Array<{ kind: string; images?: string[] }>;
  };
  expect(chatAfter.messages.find((m) => m.kind === 'image')?.images).toEqual([movedId]);
  const media = await fetch(`${API}/media?path=${encodeURIComponent(movedId)}`);
  expect(media.status).toBe(200);

  // A picture dropped into a character's folder gets a row with the
  // facts of its file — the browser shows it as a picture of the library.
  const dropped = path.join(DATA, 'characters', 'bob', 'by-hand.png');
  fs.mkdirSync(path.dirname(dropped), { recursive: true });
  fs.writeFileSync(dropped, makePng(48, 48, 10, 20, 30));
  const list2 = (await api('/pictures')) as {
    pictures: Array<{ id: string; fileSize?: number; fileHash?: string }>;
  };
  const entry = list2.pictures.find((p) => p.id === 'characters/bob/by-hand.png');
  expect(entry).toBeTruthy();
  expect(entry!.fileSize).toBeGreaterThan(0);
  expect(entry!.fileHash).toMatch(/^[0-9a-f]{64}$/);
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
