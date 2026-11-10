import http from 'http';
import { test, expect } from '@playwright/test';
import { MockComfy, MockLlm, startMockComfy, startMockLlm } from '../helpers/mocks';

// The server is started by the webServer from playwright.config.ts on
// isolated data (SILLYTALK_DATA_DIR); the real chats and catalogs are
// not touched. The model calls go to the shared mock LLM (helpers/mocks.ts)
// and the image generation to a mock ComfyUI server, so the run is fast and
// does not depend on the user's real models.
const API = 'http://localhost:3211/api';
const SHOTS = 'screenshots';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let llm: MockLlm | null = null;
let comfy: MockComfy | null = null;

test.beforeAll(async () => {
  llm = await startMockLlm(300, {
    // A user message containing "SHORT" gets a two-letter reply — the
    // "hover buttons of a short message" test needs an assistant bubble
    // narrower than the action panel. The other tests do not use the marker.
    customReplies: ({ text }) => (text.includes('SHORT') ? 'Ok.' : null),
  });
  comfy = await startMockComfy();
});

test.afterAll(async () => {
  // A test that ends while its model call is still in flight must not have the
  // mock closed under it: the backend's provider request then dies on a dead
  // port (ECONNRESET) and the backend answers ITSELF with a "⚠️ Error: fetch
  // failed" bubble in that chat — a row the next test reads as its own. An
  // in-flight reply takes the mock's delay (300 ms), so a short grace period
  // here makes the leftover call harmless instead of polluting the suite.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  llm?.close();
  llm = null;
  comfy?.close();
  comfy = null;
});

// The characters and the personas are created by the tests in the isolated
// catalog — the real data is not used. The catalog is written one card at a
// time (there is no list-wide PUT), and the e2e data dir survives between runs,
// so the setup first deletes what an earlier run left (the per-item DELETE takes
// the folder with it).
async function putCard(path: string, card: { id: string; name: string; description: string }) {
  await fetch(`${API}${path}/${card.id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: card.name, description: card.description }),
  });
}

async function setupCatalog(): Promise<void> {
  const catalog = async (path: string, cards: Array<{ id: string; name: string; description: string }>) => {
    const existing = (await (await fetch(`${API}${path}`)).json()) as Array<{ id: string }>;
    for (const card of existing) {
      await fetch(`${API}${path}/${card.id}`, { method: 'DELETE' });
    }
    for (const card of cards) await putCard(path, card);
  };
  await catalog('/persons', [
    { id: 'carol', name: 'Carol', description: 'A regular user.' },
    { id: 'dave', name: 'Dave', description: 'A second persona for the tests.' },
  ]);
  await catalog('/characters', [
    { id: 'alice', name: 'Alice', description: 'A friendly companion, replies briefly.' },
    { id: 'bob', name: 'Bob', description: 'A talkative friend, replies briefly.' },
  ]);
}

// The chats are cleared before each test so the app opens a fresh empty chat.
async function clearChats(): Promise<void> {
  const res = await fetch(`${API}/chats`);
  if (!res.ok) return;
  const chats = (await res.json()) as { id: string }[];
  await Promise.all(chats.map((c) => fetch(`${API}/chats/${c.id}`, { method: 'DELETE' })));
}

test.beforeEach(async () => {
  await setupCatalog();
  // Point the config at the mock LLM and the mock image generator so every
  // model-backed test is deterministic and fast. The hanging-model test adds
  // its own model on top (and restores the mock afterwards).
  if (llm) {
    const cfg = (await (await fetch(`${API}/config`)).json()) as Record<string, unknown>;
    await fetch(`${API}/config`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...cfg,
        llmModels: {
          'mock model': {
            id: 'mock',
            baseUrl: llm.baseUrl,
            contextSize: 8192,
            supportsImages: true,
          },
        },
        imageGenerators: comfy ? [comfy.generator] : [],
      }),
    });
  }
  await clearChats();
});

test('the empty state and the basic UI', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  await expect(page.getByTestId('model-chip')).toBeVisible();
  await expect(page.getByTestId('input')).toBeVisible();
  await expect(page.getByTestId('send')).toBeVisible();
  await expect(page.locator('.empty')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-empty-desktop.png` });
});

test('sending a message and the model reply', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();
  await page.getByTestId('input').fill('Reply with one word: ready?');
  await page.getByTestId('send').click();
  // The user message appears right away
  await expect(page.locator('.msg.user').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02a-sent-waiting.png` });
  // The model reply (not user, not error) arrives with a real delay
  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 60000 });
  const text = (await assistant.first().locator('.msg-text').textContent())?.trim() ?? '';
  expect(text.length).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/02b-conversation-desktop.png` });
});

// The hover action panel spans 168 px from the bubble's right edge. For the
// assistant messages the bubble's LEFT edge is fixed in the row (the avatar +
// the gap), so a short reply used to push the left buttons (✎ / ↻) past the
// bubble's left edge — over the avatar and out of the history's scroll box,
// where the overflow clipped them and they could not be reached. The bubble
// carries a min-width (message-row.scss) that keeps the whole panel inside.
test('the hover buttons of a short message stay inside and are clickable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();
  await page.getByTestId('input').fill('SHORT');
  await page.getByTestId('send').click();
  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 60000 });
  const msg = assistant.first();
  await expect(msg.locator('.msg-text')).toHaveText('Ok.');
  // All four buttons (the last assistant reply) must lie fully inside the
  // history's box — the left ones used to be clipped there.
  const historyBox = (await page.getByTestId('history').boundingBox())!;
  await msg.hover();
  const clipped: string[] = [];
  for (const cls of ['regen', 'edit', 'del', 'del-more']) {
    const box = await msg.locator(`.msg-edit.${cls}`).boundingBox();
    if (
      !box ||
      box.x < historyBox.x - 1 ||
      box.x + box.width > historyBox.x + historyBox.width + 1
    ) {
      clipped.push(cls);
    }
  }
  expect(clipped).toEqual([]);
  // The leftmost button (↻) is not only visible — it is clickable: the
  // regeneration runs and the short reply comes back.
  await msg.locator('.msg-edit.regen').click();
  await expect(assistant.first().locator('.msg-text')).toHaveText('Ok.', { timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/02c-short-message-buttons.png` });
});

// The model's reasoning level from the config (reasoning / reasoningLevels)
// reaches the provider: the mock LLM echoes the received level in its reply.
test('the model reasoning level is passed to the provider', async ({ page }) => {
  const cfg = (await (await fetch(`${API}/config`)).json()) as Record<string, unknown>;
  const llmModels = cfg.llmModels as Record<string, Record<string, unknown>>;
  llmModels['mock model'] = {
    ...llmModels['mock model'],
    reasoning: 'high',
    reasoningLevels: ['low', 'high'],
  };
  await fetch(`${API}/config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(cfg),
  });
  await page.goto('/');
  await page.getByTestId('input').fill('Think about it');
  await page.getByTestId('send').click();
  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 60000 });
  const text = (await assistant.first().locator('.msg-text').textContent())?.trim() ?? '';
  expect(text).toContain('(reasoning: high)');
});

// The send button turns into the cancel (✕) while a reply is generating.
// A "hanging" model (accepts the connection, never answers) makes the cancel
// deterministic: the reply stays "generating" until it is aborted, the abort
// is visible on the server side, and no message is saved for the cancelled
// reply. Does not depend on the real models at all.
test('the send button becomes the cancel while a reply is generating', async ({ page }) => {
  let abortedConnections = 0;
  const hanging = http.createServer((req) => {
    // Never write a response; count the connections that get aborted.
    req.socket.on('close', () => {
      abortedConnections += 1;
    });
  });
  await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r));
  const port = (hanging.address() as { port: number }).port;

  // Add the hanging model and make it the app's chat model.
  const cfg = (await (await fetch(`${API}/config`)).json()) as {
    llmModels: Record<string, unknown>;
    [key: string]: unknown;
  };
  await fetch(`${API}/config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...cfg,
      llmModels: {
        ...cfg.llmModels,
        'hanging model': {
          id: 'hanging',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          contextSize: 8192,
          supportsImages: false,
        },
      },
      chatModel: 'hanging model',
    }),
  });
  await fetch(`${API}/chats`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      characterIds: ['alice'],
      userId: 'carol',
    }),
  });

  try {
    await page.goto('/');
    await expect(page.getByTestId('input')).toBeVisible();
    await page.getByTestId('input').fill('Write a long story about a cat');
    await page.getByTestId('send').click();
    await expect(page.locator('.msg.user').first()).toBeVisible();
    // The reply is generating — the send button is the cancel (✕).
    await expect(page.getByTestId('typing')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('send')).toHaveText('✕');
    await page.screenshot({ path: `${SHOTS}/12a-cancel-button.png` });

    await page.getByTestId('send').click();
    // The generation is over right away.
    await expect(page.getByTestId('typing')).toBeHidden();
    await expect(page.getByTestId('send')).toHaveText('➤');
    // No assistant message (and no error message) was saved.
    await expect(page.locator('.msg:not(.user):not(.error)')).toHaveCount(0);
    await expect(page.locator('.msg.error')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/12b-cancelled.png` });

    // The server aborted the model call (the hanging connection closed).
    await expect.poll(() => abortedConnections, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  } finally {
    // Restore the config (the other tests use the real models) and stop the
    // hanging server.
    const restored = (await (await fetch(`${API}/config`)).json()) as {
      llmModels: Record<string, unknown>;
      [key: string]: unknown;
    };
    delete restored.llmModels['hanging model'];
    delete restored.chatModel;
    await fetch(`${API}/config`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(restored),
    });
    hanging.close();
  }
});

test('adding and removing a participant via the characters menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  const before = (await page.getByTestId('char-name').textContent())?.trim() ?? '';
  await page.getByTestId('chat-date').click();
  await expect(page.getByTestId('new-chat')).toBeVisible();
  // Open the participants menu and add the first character outside the chat (○).
  // A click on the name does NOT close the menu — the participant can be removed
  // with a repeated click.
  await page.getByTestId('char-name').click();
  const options = page.getByTestId('char-option');
  const total = await options.count();
  for (let i = 0; i < total; i++) {
    const opt = options.nth(i);
    const mark = (await opt.locator('.opt-mark').textContent()) ?? '';
    if (mark.includes('○')) {
      const name =
        (await opt.locator('.opt-toggle').textContent())?.replace(/[○●]/g, '').trim() ?? '';
      await opt.locator('.opt-toggle').click();
      await expect(page.getByTestId('char-name')).toContainText(name, { timeout: 15000 });
      // The menu is still open — remove the participant back
      await expect(options.nth(i).locator('.opt-toggle')).toBeVisible();
      await options.nth(i).locator('.opt-toggle').click();
      await expect(page.getByTestId('char-name')).not.toContainText(name, { timeout: 15000 });
      break;
    }
  }
  await page.screenshot({ path: `${SHOTS}/03-character-alice.png` });
  expect(before.length).toBeGreaterThan(0);
});

test('the model menu and the settings dialog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('model-chip')).toBeVisible();
  // The model pick — the menu on the model chip in the header
  await page.getByTestId('model-chip').click();
  await expect(page.getByTestId('model-option').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04a-model-menu.png` });
  // Close with a click on the empty area and open the settings
  await page.mouse.click(10, 300);
  await page.getByTestId('menu').click();
  await page.getByTestId('settings').click();
  await expect(page.locator('.settings-body')).toBeVisible();
  // The language of the picture descriptions is the backend's list (the model is
  // told a language NAME, so the pick cannot be a second copy of it).
  await expect(
    page.getByTestId('settings-picture-language').locator('option', { hasText: 'Russian' }),
  ).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/04b-settings.png` });
});

test('a new chat from the menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  await page.getByTestId('chat-date').click();
  await page.getByTestId('new-chat').click();
  // The new chat dialog: pick the persona and the character, confirm
  await expect(page.getByTestId('new-chat-dialog')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05a-new-chat-dialog.png` });
  const userOpt = page.getByTestId('new-user-option').first();
  if ((await userOpt.count()) > 0) await userOpt.click();
  const charOpt = page.getByTestId('new-char-option').first();
  if ((await charOpt.count()) > 0) await charOpt.click();
  await page.getByTestId('new-chat-confirm').click();
  // After the new chat the history is empty
  await expect(page.locator('.empty')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/05-new-chat.png` });
});

test('a group chat: two characters reply in turn', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  await page.getByTestId('chat-date').click();
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('new-chat-dialog')).toBeVisible();
  const charOpts = page.getByTestId('new-char-option');
  test.skip((await charOpts.count()) < 2, 'at least two characters are needed');
  // The first character is preselected, add the second (the order = the priority)
  const name1 = (await charOpts.nth(0).textContent())?.replace(/[○●]/g, '').trim() ?? '';
  const name2 = (await charOpts.nth(1).textContent())?.replace(/[○●]/g, '').trim() ?? '';
  await charOpts.nth(1).click();
  await page.getByTestId('new-chat-confirm').click();
  // In the header — both participants, comma separated
  await expect(page.getByTestId('char-name')).toContainText(name1, { timeout: 15000 });
  await expect(page.getByTestId('char-name')).toContainText(name2);
  await page.screenshot({ path: `${SHOTS}/07a-group-created.png` });

  await page.getByTestId('input').fill('Reply with one short sentence: ready?');
  await page.getByTestId('send').click();
  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 90000 });
  // The first replier — one of the participants; wait for the end of the queue
  // (the second one may have stayed silent with the [SILENT] tag) — the
  // "typing…" indicator must go out.
  const sender1 = (await assistant.first().locator('.msg-sender').textContent())?.trim() ?? '';
  expect([name1, name2]).toContain(sender1);
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 120000 });
  await page.screenshot({ path: `${SHOTS}/07b-group-replies.png` });
});

test('switching the active persona keeps the authors of the old messages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();
  const userOpts = page.getByTestId('user-option');
  await page.getByTestId('user-name').click();
  // Wait for the menu to render (zoneless): without the wait count() races
  await expect(userOpts.first()).toBeVisible({ timeout: 5000 });
  test.skip((await userOpts.count()) < 2, 'at least two personas are needed');
  // Close the menu with a click away (the clicks bubble to document)
  await page.mouse.click(10, 300);

  // The first message from the active persona
  const persona1 = (await page.getByTestId('user-name').textContent())?.trim() ?? '';
  await page.getByTestId('input').fill('Reply with one word: ready?');
  await page.getByTestId('send').click();
  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 120000 });
  const userMsgs = page.locator('.msg.user .msg-sender');
  const sender1 = (await userMsgs.first().textContent())?.trim() ?? '';
  expect(sender1).toBe(persona1);

  // Switch the persona to another one (the active row carries .active)
  await page.getByTestId('user-name').click();
  await expect(userOpts.first()).toBeVisible({ timeout: 5000 });
  let persona2 = '';
  for (let i = 0; i < (await userOpts.count()); i++) {
    const cls = (await userOpts.nth(i).getAttribute('class')) ?? '';
    if (!cls.includes('active')) {
      persona2 = (await userOpts.nth(i).textContent())?.trim() ?? '';
      await userOpts.nth(i).click();
      break;
    }
  }
  await expect(page.getByTestId('user-name')).toHaveText(persona2, { timeout: 15000 });
  // The old message is left under the first persona
  await expect(userMsgs.first()).toHaveText(sender1);
  await page.screenshot({ path: `${SHOTS}/08a-persona-switched.png` });

  // The new message goes from the second persona; the wait is for the SECOND
  // reply itself, never for the typing indicator alone: right after the click
  // the indicator is not visible yet, so a hidden-check there passes at once
  // and the test would end with the model call still in flight — the worker
  // teardown would then close the mock under it (see the afterAll note).
  await page.getByTestId('input').fill('Now reply with one word: ready?');
  await page.getByTestId('send').click();
  await expect(assistant).toHaveCount(2, { timeout: 120000 });
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 120000 });
  await expect(userMsgs.last()).toHaveText(persona2, { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/08b-persona-second-message.png` });
});

test('the mobile version with a conversation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();
  await page.getByTestId('input').fill('Hi!');
  await page.getByTestId('send').click();
  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: `${SHOTS}/06-conversation-mobile.png` });
});

// The big scenario: a group chat, the priority by the name mention,
// the sanity of the replies and the editing of the old messages.
test('a group chat with the editing of the old messages', async ({ page }) => {
  test.setTimeout(240000);
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  await page.getByTestId('chat-date').click();
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('new-chat-dialog')).toBeVisible();
  const charOpts = page.getByTestId('new-char-option');
  test.skip((await charOpts.count()) < 2, 'at least two characters are needed');
  const name1 = (await charOpts.nth(0).textContent())?.replace(/[○●]/g, '').trim() ?? '';
  const name2 = (await charOpts.nth(1).textContent())?.replace(/[○●]/g, '').trim() ?? '';
  await charOpts.nth(1).click();
  await page.getByTestId('new-chat-confirm').click();
  await expect(page.getByTestId('char-name')).toContainText(name1, { timeout: 15000 });
  await expect(page.getByTestId('char-name')).toContainText(name2);

  // Address the SECOND character by name — the reply queue must start
  // with it, not with the first participant.
  await page.getByTestId('input').fill(`${name2}, reply with one short sentence: ready?`);
  await page.getByTestId('send').click();

  const assistant = page.locator('.msg:not(.user):not(.error)');
  await expect(assistant.first()).toBeVisible({ timeout: 90000 });
  const sender1 = (await assistant.first().locator('.msg-sender').textContent())?.trim() ?? '';
  expect(sender1).toBe(name2); // the name mention = the reply priority
  await page.screenshot({ path: `${SHOTS}/09a-group-mention-first.png` });

  // Wait for the end of the reply queue
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 180000 });

  // Sanity: the replies are from the chat participants, meaningful, without
  // the service tags and the errors.
  const errCount = await page.locator('.msg.error').count();
  expect(errCount).toBe(0);
  const n = await assistant.count();
  expect(n).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < n; i++) {
    const sender = (await assistant.nth(i).locator('.msg-sender').textContent())?.trim() ?? '';
    expect([name1, name2]).toContain(sender);
    const text = (await assistant.nth(i).locator('.msg-text').textContent())?.trim() ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('[SILENT]');
    expect(text).not.toContain('⚠️');
  }
  await page.screenshot({ path: `${SHOTS}/09b-group-replies.png` });

  // Editing the OLD user message: hover the first message, press ✎,
  // change the text, save.
  const firstUser = page.locator('.msg.user').first();
  await firstUser.hover();
  await firstUser.locator('.msg-edit.edit').click();
  await expect(page.getByTestId('edit-bar')).toBeVisible();
  await expect(page.getByTestId('input')).toHaveValue(/ready/);
  await page.getByTestId('input').fill('Edited text of the first message.');
  await page.getByTestId('send').click();
  await expect(firstUser.locator('.msg-text')).toContainText('Edited text', { timeout: 15000 });
  await expect(page.getByTestId('edit-bar')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/09c-user-message-edited.png` });

  // Editing the old character reply
  const firstAssistant = assistant.first();
  await firstAssistant.hover();
  await firstAssistant.locator('.msg-edit.edit').click();
  await expect(page.getByTestId('edit-bar')).toBeVisible();
  await page.getByTestId('input').fill('A test edit of the reply.');
  await page.getByTestId('send').click();
  await expect(firstAssistant.locator('.msg-text')).toContainText('A test edit of the reply', {
    timeout: 15000,
  });

  // "Another message from the AI": the empty send continues the conversation
  const beforeCount = n;
  await page.getByTestId('input').fill('');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('typing')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 180000 });
  expect(await assistant.count()).toBeGreaterThan(beforeCount);
  const lastText = (await assistant.last().locator('.msg-text').textContent())?.trim() ?? '';
  expect(lastText.length).toBeGreaterThan(0);
  expect(lastText).not.toContain('⚠️');
  await page.screenshot({ path: `${SHOTS}/09d-continued-after-edit.png` });
});

// Deleting a message while the next reply is generating: the in-flight reply
// is saved into a chat re-read from disk, so the deletion survives the reply
// landing (the request-time snapshot must not clobber it and resurrect the
// deleted line).
test('deleting a message while the next reply is generating keeps it deleted', async ({
  page,
}) => {
  await llm?.setDelay(3000);
  try {
    await fetch(`${API}/chats`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ characterIds: ['alice', 'bob'], userId: 'carol' }),
    });
    await page.goto('/');
    await expect(page.getByTestId('input')).toBeVisible();
    await page.getByTestId('input').fill('Hello both of you');
    await page.getByTestId('send').click();
    // Alice answers; Bob is typing now.
    const assistant = page.locator('.msg:not(.user):not(.error)');
    await expect(assistant.first()).toBeVisible({ timeout: 30000 });
    // Delete Alice's line (the last message) while Bob's reply is in flight.
    const aliceLine = assistant.first();
    await aliceLine.hover();
    const del = aliceLine.locator('.msg-edit.del');
    await del.click(); // arm
    await del.click(); // confirm
    await expect(page.locator('[data-testid=message]')).toHaveCount(1, { timeout: 10000 });
    // Bob's reply lands — Alice's line must stay deleted.
    await expect(page.getByTestId('typing')).toBeHidden({ timeout: 30000 });
    await expect(assistant).toHaveCount(1, { timeout: 10000 });
    const sender = (await assistant.first().locator('.msg-sender').textContent())?.trim() ?? '';
    expect(sender).toBe('Bob');
    await page.screenshot({ path: `${SHOTS}/09e-delete-during-generation.png` });
  } finally {
    await llm?.setDelay(300);
  }
});

// The entity edit dialogs (character / persona / model) from the top-bar
// menus: the edit icon per item, the "New" button, and Delete + Clone inside
// the dialogs. No model calls — pure catalog management.
test('the entity dialogs: edit, create, clone and delete', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  // The confirm() of the Delete buttons: accept.
  page.on('dialog', (d) => d.accept());

  // ---- character: edit the first one (the name is saved) ----
  await page.getByTestId('char-name').click();
  const charRows = page.getByTestId('char-option');
  await expect(charRows.first()).toBeVisible();
  const charName =
    ((await charRows.first().locator('.opt-toggle').textContent()) ?? '').replace(/[○●]/g, '').trim();
  await charRows.first().getByTestId('char-edit').click();
  await expect(page.getByTestId('character-dialog')).toBeVisible();
  await expect(page.getByTestId('char-name-input')).toHaveValue(charName);
  await page.getByTestId('char-name-input').fill(charName + ' (edited)');
  await page.getByTestId('char-save').click();
  await expect(page.getByTestId('character-dialog')).toBeHidden();
  await page.getByTestId('char-name').click();
  await expect(charRows.first()).toContainText(charName + ' (edited)');

  // ---- character: clone the edited one (the copy gets the " (copy)" suffix);
  // the Clone button switches the dialog to the copy instead of closing ----
  await charRows.first().getByTestId('char-edit').click();
  await expect(page.getByTestId('character-dialog')).toBeVisible();
  await page.getByTestId('char-clone').click();
  await expect(page.getByTestId('char-name-input')).toHaveValue(charName + ' (edited) (copy)');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('character-dialog')).toBeHidden();
  await page.getByTestId('char-name').click();
  const charCopy = page.getByTestId('char-option').filter({ hasText: charName + ' (edited) (copy)' });
  await expect(charCopy).toBeVisible();

  // ---- character: delete the clone ----
  await charCopy.getByTestId('char-edit').click();
  await expect(page.getByTestId('character-dialog')).toBeVisible();
  await page.getByTestId('char-delete').click();
  await expect(page.getByTestId('character-dialog')).toBeHidden();
  await page.getByTestId('char-name').click();
  await expect(page.getByTestId('char-option').filter({ hasText: ' (copy)' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/10a-character-dialogs.png` });

  // ---- persona: create a new one ----
  await page.getByTestId('user-name').click();
  await page.getByTestId('new-persona').click();
  await expect(page.getByTestId('user-dialog')).toBeVisible();
  await page.getByTestId('user-name-input').fill('Eve');
  await page.getByTestId('user-save').click();
  await expect(page.getByTestId('user-dialog')).toBeHidden();
  await page.getByTestId('user-name').click();
  await expect(page.getByTestId('user-option').filter({ hasText: 'Eve' })).toBeVisible();

  // ---- persona: clone + delete the clone ----
  await page
    .getByTestId('user-option-row')
    .filter({ hasText: 'Eve' })
    .first()
    .getByTestId('user-edit')
    .click();
  await expect(page.getByTestId('user-dialog')).toBeVisible();
  await page.getByTestId('user-clone').click();
  await expect(page.getByTestId('user-name-input')).toHaveValue('Eve (copy)');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('user-dialog')).toBeHidden();
  await page.getByTestId('user-name').click();
  const eveCopy = page.getByTestId('user-option-row').filter({ hasText: 'Eve (copy)' });
  await expect(eveCopy).toBeVisible();
  await eveCopy.getByTestId('user-edit').click();
  await expect(page.getByTestId('user-dialog')).toBeVisible();
  await page.getByTestId('user-delete').click();
  await expect(page.getByTestId('user-dialog')).toBeHidden();
  await page.getByTestId('user-name').click();
  await expect(page.getByTestId('user-option-row').filter({ hasText: 'Eve (copy)' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/10b-persona-dialogs.png` });

  // ---- model: create a new one from the chip menu ----
  await page.getByTestId('model-chip').click();
  await page.getByTestId('new-model').click();
  await expect(page.getByTestId('model-dialog')).toBeVisible();
  await page.getByTestId('model-name-input').fill('test model');
  await page.getByTestId('model-id-input').fill('test-model-id');
  await page.getByTestId('model-save').click();
  await expect(page.getByTestId('model-dialog')).toBeHidden();
  await page.getByTestId('model-chip').click();
  await expect(page.getByTestId('model-option-row').filter({ hasText: 'test model' })).toBeVisible();

  // ---- model: clone + delete the clone and the original ----
  await page
    .getByTestId('model-option-row')
    .filter({ hasText: 'test model' })
    .first()
    .getByTestId('model-edit')
    .click();
  await expect(page.getByTestId('model-dialog')).toBeVisible();
  await page.getByTestId('model-clone').click();
  await expect(page.getByTestId('model-dialog')).toBeHidden();
  await page.getByTestId('model-chip').click();
  await expect(page
    .getByTestId('model-option-row')
    .filter({ hasText: 'test model copy' })
  ).toBeVisible();
  await page
    .getByTestId('model-option-row')
    .filter({ hasText: 'test model copy' })
    .first()
    .getByTestId('model-edit')
    .click();
  await expect(page.getByTestId('model-dialog')).toBeVisible();
  await page.getByTestId('model-delete').click();
  await expect(page.getByTestId('model-dialog')).toBeHidden();
  await page.getByTestId('model-chip').click();
  await page
    .getByTestId('model-option-row')
    .filter({ hasText: 'test model' })
    .first()
    .getByTestId('model-edit')
    .click();
  await expect(page.getByTestId('model-dialog')).toBeVisible();
  await page.getByTestId('model-delete').click();
  await expect(page.getByTestId('model-dialog')).toBeHidden();
  await page.getByTestId('model-chip').click();
  await expect(page.getByTestId('model-option-row').filter({ hasText: 'test model' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/10c-model-dialogs.png` });
});

// The ID of a character is the name of its folder, and a chat names its
// participants and the author of every line by that ID. So the ID the user types
// when creating one is what the server must store, and renaming it afterwards
// has to take the open conversation along — the participant in the header and
// the name over the lines she already said.
test('the ID of a character: written at creation, renamed with the chat following', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();

  // ---- create: the ID field suggests one from the name, the user overwrites it ----
  await page.getByTestId('char-name').click();
  await page.getByTestId('new-character').click();
  await expect(page.getByTestId('character-dialog')).toBeVisible();
  const idField = page.getByTestId('char-id-input');
  await page.getByTestId('char-name-input').fill('Mira of the North');
  await expect(idField).toHaveValue('mira-of-the-north');
  await idField.fill('mira-north');
  await page.getByTestId('char-save').click();
  await expect(page.getByTestId('character-dialog')).toBeHidden();
  // stored under exactly the ID the user wrote (an ID is the folder name)
  const catalog = (await (await fetch(`${API}/characters`)).json()) as Array<{
    id: string;
    name: string;
  }>;
  expect(catalog.find((c) => c.name === 'Mira of the North')?.id).toBe('mira-north');
  await page.screenshot({ path: `${SHOTS}/10d-character-id-creation.png` });

  // ---- a conversation she takes part in, so the rename has something to follow ----
  await page.getByTestId('char-name').click();
  const miraRow = page.getByTestId('char-option').filter({ hasText: 'Mira of the North' });
  await expect(miraRow).toHaveCount(1);
  await miraRow.locator('.opt-toggle').click();
  await page.mouse.click(10, 300);
  await expect(page.getByTestId('char-name')).toContainText('Mira of the North');
  await page.getByTestId('input').fill('Say hello to both of us.');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('typing')).toBeHidden({ timeout: 120000 });
  const senders = page.locator('.msg-sender');
  await expect(senders.filter({ hasText: 'Mira of the North' }).first()).toBeVisible();

  // ---- rename the ID: the field shows the current one, Rename is dead until it
  // says another folder name, and Save alone does not move anything ----
  await page.getByTestId('char-name').click();
  await miraRow.getByTestId('char-edit').click();
  await expect(page.getByTestId('character-dialog')).toBeVisible();
  const rename = page.getByTestId('char-rename');
  await expect(page.getByTestId('char-id-input')).toHaveValue('mira-north');
  await expect(rename).toBeDisabled();
  await page.getByTestId('char-id-input').fill('the-north-mira');
  await expect(rename).toBeEnabled();
  await rename.click();
  // the dialog switches to the renamed character instead of closing on a folder
  // that does not exist any more (the same path Clone takes)
  await expect(page.getByTestId('char-id-input')).toHaveValue('the-north-mira');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('character-dialog')).toBeHidden();

  // the folder really moved
  const after = (await (await fetch(`${API}/characters`)).json()) as Array<{ id: string; name: string }>;
  expect(after.find((c) => c.name === 'Mira of the North')?.id).toBe('the-north-mira');

  // ---- the chat followed: the same participant in the header, the same name
  // over the lines she already said — and on the server, where the chat stores
  // the ID: her id in the participant list and in the author of her line, while
  // the other participant's id and the persona of the chat are untouched ----
  await expect(page.getByTestId('char-name')).toContainText('Mira of the North');
  await expect(senders.filter({ hasText: 'Mira of the North' }).first()).toBeVisible();
  // the app keeps the open chat in the store, not in the URL — the id comes
  // from the chat list (newest first)
  const chats = (await (await fetch(`${API}/chats`)).json()) as Array<{ id: string }>;
  const stored = (await (await fetch(`${API}/chats/${chats[0].id}`)).json()) as {
    characterIds: string[];
    userId: string;
    messages: Array<{ characterId?: string }>;
  };
  expect([...stored.characterIds].sort()).toEqual(['alice', 'the-north-mira']);
  expect(stored.userId).toBe('carol');
  expect(stored.messages.map((m) => m.characterId).filter(Boolean).sort()).toEqual([
    'alice',
    'the-north-mira',
  ]);
  await page.screenshot({ path: `${SHOTS}/10e-character-id-renamed.png` });
});

// The ID of a chat names its folder AND prefixes every picture id of the chat
// (chats/<id>/…), so a new chat is born under a name that reads — its
// creation moment, not a UUID — and the Rename in the chat settings is the same
// kind of move a character rename is: the folder and the picture ids of the
// chat follow the new name.
test('the ID of a chat: the creation date by default, renamed with its pictures following', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();

  // A drawn picture gives the rename a file and a row to move.
  await page.getByTestId('gen-toggle').click();
  await page.getByTestId('input').fill('a red circle');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('img-pending')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('img-pending')).toBeHidden({ timeout: 20000 });

  // The open chat is named by its creation moment, not a UUID.
  const list0 = (await (await fetch(`${API}/chats`)).json()) as Array<{ id: string }>;
  expect(list0.length).toBe(1);
  const oldId = list0[0].id;
  expect(oldId).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$/);
  const before = (await (await fetch(`${API}/chats/${oldId}`)).json()) as {
    messages: Array<{ kind: string; images: string[] }>;
  };
  const cardBefore = before.messages.find((m) => m.kind === 'image')!;
  expect(cardBefore.images[0].startsWith(`chats/${oldId}/`)).toBe(true);
  const fileName = cardBefore.images[0].split('/').pop()!;

  // ---- the chat settings dialog carries the ID; Rename is dead until the
  // field says another folder name, and Save alone does not move anything ----
  await page.getByTestId('chat-dots').click();
  await page.getByTestId('chat-settings').click();
  const idField = page.getByTestId('chat-id-input');
  await expect(idField).toHaveValue(oldId);
  const rename = page.getByTestId('chat-rename');
  await expect(rename).toBeDisabled();
  await idField.fill('harbour-talk');
  await expect(rename).toBeEnabled();
  await page.getByTestId('chat-settings-save').click();
  await expect(page.getByTestId('chat-settings-dialog')).toBeHidden();
  const listSaved = (await (await fetch(`${API}/chats`)).json()) as Array<{ id: string }>;
  expect(listSaved.map((c) => c.id)).toEqual([oldId]);

  // ---- the explicit Rename: the folder move ----
  await page.getByTestId('chat-dots').click();
  await page.getByTestId('chat-settings').click();
  await expect(idField).toHaveValue(oldId);
  await idField.fill('harbour-talk');
  await rename.click();
  // the dialog keeps working on the new name instead of the folder that is gone
  await expect(idField).toHaveValue('harbour-talk');
  await expect(rename).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('chat-settings-dialog')).toBeHidden();

  // the chat reads under the new id only, and its card names the moved file
  const list1 = (await (await fetch(`${API}/chats`)).json()) as Array<{ id: string }>;
  expect(list1.map((c) => c.id)).toEqual(['harbour-talk']);
  const after = (await (await fetch(`${API}/chats/harbour-talk`)).json()) as {
    messages: Array<{ kind: string; images: string[] }>;
  };
  const cardAfter = after.messages.find((m) => m.kind === 'image')!;
  expect(cardAfter.images[0]).toBe(`chats/harbour-talk/${fileName}`);
  // the file itself travels: the media route serves it at the new id
  const media = await fetch(`${API}/media?path=${encodeURIComponent(cardAfter.images[0])}`);
  expect(media.status).toBe(200);
  // and its row of the images table moved with it — the picture browser knows
  // the picture under the new path
  const pictures = (await (await fetch(`${API}/pictures`)).json()) as { pictures: Array<{ id: string }> };
  expect(pictures.pictures.some((p) => p.id === cardAfter.images[0])).toBe(true);
  await page.screenshot({ path: `${SHOTS}/10f-chat-id-renamed.png` });
});

// The header menus: opening one closes the others, the model pick via the
// chip menu and "+ New character" (the create-mode dialog). No model calls.
test('the header menus: exclusivity, the model pick, the new character', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();

  // Opening one menu closes the others
  await page.getByTestId('char-name').click();
  await expect(page.getByTestId('char-option').first()).toBeVisible();
  await page.getByTestId('model-chip').click();
  await expect(page.getByTestId('model-option').first()).toBeVisible();
  await expect(page.getByTestId('char-option')).toHaveCount(0);
  await page.getByTestId('user-name').click();
  await expect(page.getByTestId('user-option').first()).toBeVisible();
  await expect(page.getByTestId('model-option')).toHaveCount(0);
  await page.mouse.click(10, 400);
  await expect(page.getByTestId('user-option')).toHaveCount(0);

  // The model switch via the chip menu (a second model is needed)
  await page.getByTestId('model-chip').click();
  const modelOptions = page.getByTestId('model-option');
  if ((await modelOptions.count()) >= 2) {
    let target = '';
    for (let i = 0; i < (await modelOptions.count()); i++) {
      const cls = (await modelOptions.nth(i).getAttribute('class')) ?? '';
      if (!cls.includes('active')) {
        target = ((await modelOptions.nth(i).textContent()) ?? '')
          .replace('(👁)', '')
          .trim();
        await modelOptions.nth(i).click();
        break;
      }
    }
    if (target) {
      await expect(page.getByTestId('model-chip')).toHaveText(target, { timeout: 15000 });
    }
  }
  await page.mouse.click(10, 400);

  // "+ New character" — the dialog in the create mode (no Delete/Clone there)
  await page.getByTestId('char-name').click();
  await page.getByTestId('new-character').click();
  await expect(page.getByTestId('character-dialog')).toBeVisible();
  await expect(page.getByTestId('char-delete')).toHaveCount(0);
  await expect(page.getByTestId('char-clone')).toHaveCount(0);
  await page.getByTestId('char-name-input').fill('Zoe');
  await page.getByTestId('char-save').click();
  await expect(page.getByTestId('character-dialog')).toBeHidden();
  await page.getByTestId('char-name').click();
  await expect(page.getByTestId('char-option').filter({ hasText: 'Zoe' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11a-header-menus.png` });
});

// The participants menu: the ↑/↓ arrows change the reply priority — the
// order in the header flips. No model calls.
test('the participants menu: the reorder arrows', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('char-name')).toBeVisible();
  // a group chat: the preselected first character + the second one
  await page.getByTestId('chat-date').click();
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('new-chat-dialog')).toBeVisible();
  const charOpts = page.getByTestId('new-char-option');
  test.skip((await charOpts.count()) < 2, 'at least two characters are needed');
  const name1 = (await charOpts.nth(0).textContent())?.replace(/[○●]/g, '').trim() ?? '';
  const name2 = (await charOpts.nth(1).textContent())?.replace(/[○●]/g, '').trim() ?? '';
  await charOpts.nth(1).click();
  await page.getByTestId('new-chat-confirm').click();
  await expect(page.getByTestId('char-name')).toContainText(name1, { timeout: 15000 });
  await expect(page.getByTestId('char-name')).toContainText(name2);

  // ↓ on the first participant — the order flips (the order = the priority)
  await page.getByTestId('char-name').click();
  const row1 = page.getByTestId('char-option').filter({ hasText: name1 });
  await expect(row1).toBeVisible();
  await row1.locator('.opt-move').nth(1).click(); // the second arrow is ↓
  await expect(page.getByTestId('char-name')).toHaveText(`${name2}, ${name1}`, { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/11b-participant-order.png` });
});

// Mobile: the "Chat: <date>" label (the chat-menu trigger) and the model
// chip are both visible; the chip is the model picker (and dialog entry).
test('the model chip on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('input')).toBeVisible();
  await expect(page.getByTestId('model-chip')).toBeVisible();
  await expect(page.locator('.chat-date')).toBeVisible();
  await page.getByTestId('model-chip').click();
  await expect(page.getByTestId('model-option').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11c-mobile-model-chip.png` });
});

// The media route serves pictures and nothing else. A picture is addressed by a
// path relative to the data folder, so "it stays inside the data folder" is not
// enough of a guard: the config (a literal provider key), the user's ComfyUI
// workflow files and the chats database all live in that folder too. Two rules
// answer for it — the id must point inside a folder pictures live in, and the
// name must be a picture format (any JSON beside a picture stays unserved too) —
// so the refusals come as 400 and as 404 respectively.
test('GET /api/media serves a picture of a chat and nothing else', async () => {
  const created = (await (
    await fetch(`${API}/chats`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ characterIds: ['alice'], userId: 'carol' }),
    })
  ).json()) as { id: string };

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const sent = (await (
    await fetch(`${API}/chats/${created.id}/messages`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        text: 'A picture of a pixel',
        images: [`data:image/png;base64,${png.toString('base64')}`],
      }),
    })
  ).json()) as { chat: { messages: { kind?: string; images?: string[] }[] } };
  const imageId = sent.chat.messages.find((m) => m.kind === 'image')?.images?.[0];
  expect(imageId, 'the attached picture became a card with an image id').toBeTruthy();

  const media = await fetch(`${API}/media?path=${encodeURIComponent(imageId as string)}`);
  expect(media.status).toBe(200);
  expect(media.headers.get('content-type')).toBe('image/png');
  expect((await media.arrayBuffer()).byteLength).toBe(png.byteLength);

  const refused: [number, string][] = [
    [400, 'config.json'],
    [400, 'comfyui/qwen-image-2.1.json'],
    [400, '../../../Windows/win.ini'],
    [400, 'C:/Windows/win.ini'],
    [404, 'chats/chats.db'],
    [404, `${imageId}.json`],
  ];
  for (const [status, id] of refused) {
    const res = await fetch(`${API}/media?path=${encodeURIComponent(id)}`);
    expect(res.status, `GET /api/media?path=${id}`).toBe(status);
  }
});
