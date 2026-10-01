# sillytalk

A web chat app for talking to **AI characters**, with first-class image support. A user chats with a
configured AI persona; the model can receive images (vision) and generate images — from text, or from
reference images (the character's "starter" photo set, or images already in the chat).

Think of it as a simpler, modern take on SillyTavern / Agnai.

## Stack

- **Backend** — Node.js, Express 5, TypeScript (CommonJS, `strict`), Jest.
- **Frontend** — Angular 22 (standalone components, signals, zoneless — **no zone.js**), SCSS.
- **E2E** — Playwright (Chromium).
- **Language convention** — code, identifiers, comments and user-facing UI strings: English.

## Repository layout

```
backend/               Express API; also serves the built frontend
  src/
    index.ts           bootstrap: API + static frontend + SPA fallback
    routes.ts          REST API (config, users, characters, chats, messages, avatars, image, files)
    llm.ts             OpenAI-compatible /chat/completions (text + image_url), history trimming
    imagegen.ts        image generation: SD API / local program, background jobs
    machine.ts         MachineService: OS-specific launch/kill of the local
                       generator program (interface + platform selection)
    machine-win32.ts   Windows impl (cmd.exe / powershell wrappers, taskkill)
    machine-posix.ts   POSIX impl (detached process groups, group kill)
    chats.ts           chat + chat-file persistence
    characters.ts      character persistence in characters/<id>/ folders
    users.ts           user persistence in users/<id>/ folders
    config.ts          config load/save, path helpers
    types.ts           shared backend types
    llm.test.ts        jest unit tests (system prompt + history trimming)
    imagegen.test.ts   jest unit tests (local program, background image jobs)
    machine.test.ts    jest unit tests (platform selection, command lines)
    characters.test.ts jest unit tests (character folders: CRUD, sync, migration)
    users.test.ts      jest unit tests (user folders: CRUD, sync)
  jest.config.js       ts-jest setup

frontend/              Angular app
  src/app/
    app.ts             root component: shell (column + modal dialogs) + bootstrap
    app.scss           app shell (.app/.column) + modal window styles only
    app.config.ts      app providers
    app.routes.ts      routing
    app.spec.ts        frontend unit tests (vitest)
  src/services/        DI services (providedIn: root)
    api.ts             HTTP client (ApiService) + frontend types (mirrors backend)
    config-store.ts    ConfigStore: config + catalogs (models/users/chars),
                       image-gen availability, settings dialog, the entity edit
                       dialogs (entityDialog + model/character/user CRUD), loadAll()
    chat-store.ts      ChatStore: current chat + chat list — messages, send
                       (send/saveEdit), the 📎 attachments (pendingImages), edit,
                       chat mgmt, new-chat dialog
    image-store.ts     ImageStore: image GENERATION — genMode/genRefs/generating,
                       draw(), cancel/regenerate of message images, the
                       background-job polling; depends ONE-WAY on ChatStore
    ui-store.ts        UiStore: cross-cutting UI state (global error banner)
    helpers.ts         pure helpers: chat labels, message counts, image hint
  src/components/      UI components, each with its own .scss (encapsulation!);
                       read state/actions via injected stores — no big input lists
    top-bar/           header: character/user menus (edit icons + "New"),
                       model chip (menu + edit icons), ⋮ menu
    message-list/      history: empty state, messages, typing indicator
    message-row/       one message: avatar, text, images (spinner/broken/ready),
                       hover buttons (image actions via ImageStore)
    input-panel/       input: error banner, gen-mode bar, 📎 attachments, send;
                       orchestrates the "what to send" decision (edit/gen/text)
    new-chat-dialog/   new chat: user + character pick (local selection state)
    character-dialog/  character edit dialog (name, description, avatar, Delete/Clone)
    user-dialog/       persona edit dialog (name, description, avatar, Delete/Clone)
    model-dialog/      model edit dialog (llmModels entry fields, Delete/Clone)
    settings/          settings modal (listen address / image generation)
  angular.json         build config (incl. style budgets)
  proxy.conf.json      dev proxy: /api -> http://localhost:3210

e2e/                   Playwright suite
  playwright.config.ts
  tests/app.spec.ts
  screenshots/         captured by the suite

~/.config/sillytalk/   runtime data (NOT in the repo)
  config.json
  chats/<chatId>/chat.json (+ files/ — uploaded/generated images)
  characters/<id>/character.json (+ photos/ — "starter" set, avatar.jpg — character avatar)
  users/<id>/user.json (+ avatar.jpg — user avatar)
  generated/
```

## Commands

Run from the repo root unless noted.

| Task | Command |
| --- | --- |
| Install all deps (root + backend + frontend) | `npm run install:all` |
| Build backend + frontend | `npm run build` |
| Run production (single server, port 3210) | `npm run start` |
| Run dev (backend :3210 + Angular :4200, `/api` proxied) | `npm run dev` |
| Backend unit tests (jest) | `cd backend && npm test` |
| Frontend unit tests (vitest via `ng test`) | `cd frontend && npm test` |
| Frontend production build | `cd frontend && npm run build` |
| E2E (auto-starts an isolated server on :3211; backend must be built) | `cd e2e && npx playwright test` |

Production: `npm run build && npm run start`, then open http://localhost:3210 — the backend serves both
the API and the built frontend.

The E2E suite does **not** start the server itself (no `webServer` in the Playwright config). Start it
first (`npm run start`, in the background), then run the suite.

## Configuration

Stored at `~/.config/sillytalk/config.json`, auto-created with examples on first run. Editable as a file
or through the in-app **Settings** dialog. Paths may use `~` (resolved by `expandPath`).

```jsonc
{
  // address the server listens on (host:port) — port is parsed from here
  "listen": "0.0.0.0:3210",
  // key = model name inside the app (displayed, chosen in the menu) AND the
  // identifier a chat references via `chat.modelId`; value field `id` is the
  // identifier actually sent to the provider.
  "llmModels": {
    "openrouter/anthropic/claude-3.5-sonnet": {
      "id": "anthropic/claude-3.5-sonnet",  // id sent to the provider (the OpenRouter model slug)
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "",                     // literal key, OR
      "envKey": "OPENROUTER_API_KEY",   // name of an env var holding the key (takes priority)
      "contextSize": 200000,
      "supportsImages": true
    }
  },
  // generation backends, tried in order at startup — first available is used
  "imageGenerators": [
    {
      "url": "http://127.0.0.1:7860",   // SD API / Stable Diffusion WebUI (has `url`)
      "steps": 30, "width": 768, "height": 768,
      "denoisingStrength": 0.75, "negativePrompt": ""
    },
    {
      "command": "",                    // local program (has `command`)
      "args": ["--prompt", "{prompt}", "--input", "{absolutePathsToInputImages}", "--output", "{absolutePathToOutputImage}"],
      "maxInputImages": 0
    }
  ]
}
```

The config is **flat**: connection settings live on each `llmModels` entry (`baseUrl`,
`apiKey`/`envKey`, `contextSize`) — there is no separate `providers` level. The **key** of
`llmModels` is both the human-visible name and the internal id a chat references
(`chat.modelId`); the entry's `id` field is the identifier actually sent to the provider
(flattened to `Model.name`/`Model.id` in `listModels()`, see `config.ts`). The API key is
resolved by `resolveApiKey()`: `envKey` (env var) wins over `apiKey` (literal).

**Environment overrides** (set before server start; used by the e2e suite for isolation):
`SILLYTALK_DATA_DIR` moves the whole data root (`config.json`, `chats/`, `characters/`,
`users/`) elsewhere; `SILLYTALK_CHATS_DIR` / `SILLYTALK_CHARACTERS_DIR` / `SILLYTALK_USERS_DIR`
override the individual folders; `SILLYTALK_LISTEN` overrides the listen address on top of
`config.json`.

- `llmModels[].supportsImages: true` — the model accepts images; sent/reference images are passed into the
  prompt as `image_url` data-URIs.
- **Image generation has no `auto` toggle anymore.** `imageGenerators` is an ordered list of
  generators (SD API by presence of `url`, local program by presence of `command`). At startup
  (`refreshActiveGenerator` in `imagegen.ts`) they are iterated in order and the first available
  one becomes the active generator (`activeGenerator`); availability of the SD API is probed via
  `GET {url}/sdapi/v1/sd-models`, a local program is available if `command` is set (and, for an
  absolute path, if that file exists). `GET /api/image/status` returns `{ available }` for the UI.
  Config changes via `PUT /api/config` recompute the active generator.
- Local-program placeholders: `{prompt}` (prompt text), `{absolutePathsToInputImages}` (comma-joined
  absolute paths of the reference images, empty when there are none — matches
  `-InputImagePath a.jpg,b.jpg` style), `{absolutePathToOutputImage}` (absolute path of the output
  PNG the program must write — the backend places it in the chat's `files/` dir; there is no
  `outputDir` config field anymore). The OS-specific launch/kill lives behind the
  `MachineService` interface (`machine.ts`, selected once at startup in `index.ts` via
  `initMachineService()` for the current OS): on **Windows** `.bat`/`.cmd` run through
  `cmd.exe /d /s /c` with quoted args, `.ps1` through `powershell.exe -NoProfile
  -ExecutionPolicy Bypass -File` (plain executables spawn directly — Node throws EINVAL on
  batch files without a shell), and cancelling kills the process TREE with `taskkill /F /T
  /PID` (a plain `child.kill()` would only terminate the wrapper); on **POSIX** programs
  spawn directly in their own process group (`detached`) and cancelling kills the whole
  group (`kill(-pid)`), while `.bat`/`.cmd` are refused with a clear error. Keep new
  OS-specific behavior in the platform impls (`machine-win32.ts` / `machine-posix.ts`), not in
  `imagegen.ts`. A generator's `maxInputImages` caps how many reference images it accepts
  (0 = unlimited; the backend rejects the request with a clear error before spawning).
- **Self-initiated image generation.** When an active generator is available, `systemPromptFor`
  adds an instruction letting the model insert `[IMG:description]` tags into its replies; it may
  also pass reference images by index: `[IMG:description | 1,3]`. The index list ("inventory") is
  built per request in `routes.ts` (`imageInventory`): the character's photos first, then every
  image already in the chat, oldest first; it is appended to the system prompt so the model knows
  what the numbers mean. The backend strips the tags (`extractImageRequests`) and resolves indices
  to files (character photos are copied into the chat via `importCharacterPhoto`).
- **Image generation runs in the BACKGROUND.** Each `[IMG:…]` (or a manual gen-mode draw, or a
  regeneration) gets a reserved file name that is stored in the message RIGHT AWAY with
  `ChatMessage.imageStatus[name] = 'pending'` (`imagePrompts`/`imageRefs` alongside), the reply is
  saved and returned to the client without waiting, and the generation runs as a background job
  (`startImageJob` in `imagegen.ts`). The job writes to a temp file and renames it to the reserved
  name only on success (so a name is never left with a partial image); jobs are **serialized**
  (one run at a time — a local program / the GPU must not be hit concurrently). When the job
  finishes, `routes.ts` updates the message: ok → the status is cleared (the image is ready);
  failed/cancelled → `imageStatus[name] = 'failed'` + `imageErrors[name]` (the "broken" image),
  UNLESS an older image existed at the name (a cancelled/failed regeneration) — then the old file
  is kept and the image stays ready. The **frontend polls** the chat (`GET /chats/:id`) on a 1.5 s
  interval while any image of the current chat is `pending` (stops when none are), so a generation
  never blocks sending messages. The UI shows a spinner placeholder with a **Cancel** button while
  pending and a broken-image placeholder with a **Regenerate** button when failed.
  `POST /api/chats/:id/messages/:messageId/cancel-image` (body `{ image }`) cancels the in-flight
  job and marks the image failed. `POST /api/chats/:id/messages/:messageId/regenerate-image`
  (body `{ image }`) re-runs the generator in the background against the SAME reserved name (no
  file swap, so no later references need repointing — the old `repointImageRefsAfter` is gone),
  after cancelling any job still running for that image.
- **Sending existing photos without generation.** Independently of the generator, `systemPromptFor`
  (when the inventory is non-empty) instructs the model it can attach an inventory image as-is with a
  `[PHOTO:1,3]` tag (same numbering as `[IMG]` refs). `extractPhotoRequests` in `llm.ts` strips the
  tags (strict format: numbers only — a bare `[PHOTO]` stays literal text); `appendAssistantReply`
  resolves the indices through `resolveInventoryRefs` (character photos are copied into the chat's
  `files/`) and attaches the files to the message like any other image. The inventory itself is now
  built for every reply, generator or not.
- **Generation prompts are always English.** The `[IMG:...]` instruction requires English scene
  descriptions. Manually typed prompts (gen mode) and stored Russian prompts (regeneration) are
  translated to English via the chat's model (`translatePrompt` in `llm.ts`, `ensureEnglishPrompt`
  in `routes.ts`) before hitting the generator; on translation failure the original text is used.
  The final prompt is stored in `ChatMessage.imagePrompts`, so image hover hints show it.
- **Characters are NOT in the config.** Each character is a folder
  `~/.config/sillytalk/characters/<id>/`: the folder name IS the character id, `character.json` holds
  `{ name, description }`, `photos/` is the fixed "starter" photo set (computed by
  `characterPhotosDir(id)`), and `avatar.jpg` is the character avatar shown next to its messages.
  CRUD lives in `characters.ts`; `GET/PUT /api/characters` read/sync the folders (PUT performs a full
  sync: create/update/delete). An on-disk `characters` field in an old config.json is migrated to
  folders at startup (`index.ts`) and stripped by `PUT /api/config` — do not reintroduce a
  `characters` array in the config.
- **Users are NOT in the config either.** Each user is a folder `~/.config/sillytalk/users/<id>/`
  with `user.json` holding `{ name, description }` and `avatar.jpg` (user avatar, shown next to user
  messages). CRUD lives in `users.ts`; `GET/PUT /api/users` mirror the character endpoints. There is
  **no selected/current user** in the config anymore: each chat stores the **active** persona (whose
  name new messages are sent under) in `Chat.userId`, chosen when creating a new chat (dialog) or
  via the header menu. On a fresh install the default user is created with id `default`
  (previously `me`). The active persona's `description` (when non-empty) is appended to the system
  prompt by `systemPromptFor(character, user, …)` so the model knows who it is talking to.
- **Multi-participant chats.** `Chat.characterIds` is the ordered participant list (order =
  answer priority). Every `ChatMessage` carries its author — `characterId` (assistant) /
  `userId` (user) — stored at send time, so switching participants or the active persona never
  rewrites history; the personas that ever spoke in a chat are derived from the messages'
  `userId` values on the fly (there is no stored `Chat.userIds`). `POST /api/chats/:id/messages`
  only stores the user message — the **frontend** then drives the reply queue: for every
  participant in order (starting from the one mentioned by name in the text, else turn order) it
  calls `POST /api/chats/:id/reply` `{ characterId }` (backend: `appendAssistantReply`), so each
  reply appears as soon as it is generated and the typing indicator shows who is generating
  (`ChatStore.typingCharacterId`). Each character sees the previous replies; a character answers
  only from its own name and may stay **silent** by replying with exactly `[SILENT]` (parsed by
  `parseSilence` in `llm.ts` — a bare tag means silence, inline occurrences are stripped;
  `reply === null`). In group chats (more than one character or persona)
  `labelHistory` prefixes history lines with speaker names. "Another message from the AI" (empty
  send) continues with the next character in turn order (same reply queue); "Regenerate" is built
  from the same primitives — delete the last message (`DELETE /messages/:id`, kept visible locally
  until the reply arrives) + one `/reply` call as its author — there is no separate
  `/regenerate` route.
  The header character menu toggles participants (last one cannot be removed) and reorders them
  with ↑/↓; there is no legacy single-`characterId` format — old chats were converted once by a
  one-off script.
- **Avatars.** Served/uploaded via `GET/POST/DELETE /api/users/:id/avatar` and
  `GET/POST/DELETE /api/characters/:id/avatar`. The file is `avatar.<ext>` where the extension
  follows the actual uploaded format (usually `.jpg`); the GET route serves the first existing
  candidate and sets `Cache-Control: no-store`. List endpoints add a computed `hasAvatar` flag —
  the UI shows the image only when it is true.

## Product / UI behavior (invariants to preserve)

- Black background; a single centered chat column (max-width ~820px).
- Header row: participant names joined by ", " (opens the **participants menu**: toggle characters
  in/out of the chat, ↑/↓ reorder = answer priority, a ✎ **edit icon** per item and a
  "+ New character" button), active persona (opens the persona menu — click switches the active
  persona, ✎ edit icon per item, "+ New persona"), model chip (opens the **model menu** — the model
  pick, ✎ edit icon per item, "+ New model"; the chip is the ONLY model picker — the "⋮" menu has no
  model submenu), a "Chat: <last-message date>" label (clickable — opens the **chat menu**: new chat,
  delete chat, the chat list; wider than the usual dropdown, centered under the label, always
  visible), and a "⋮" menu (settings only now). Opening any one of these menus closes the others —
  they must never overlap. The persona/model menus are single-select (the active row is highlighted,
  no ●/○ mark); the character menu keeps the ●/○ mark (membership is a multi-select toggle) and its
  rows are ordered by reply priority, so the ↑/↓ arrows reorder the menu itself.
- **Entity edit dialogs** (character-dialog / user-dialog / model-dialog): one per item, opened from
  the ✎ icons / "+ New" buttons above. They carry **Save/Cancel**, **Delete** (a confirm; only in
  edit mode) and **Clone** (only in edit mode). Models are saved through the config (a rename
  re-keys the llmModels entry); characters/personas through the full list sync. Character/persona
  clone — `POST /api/characters/:id/clone` / `POST /api/users/:id/clone` (the folder is copied:
  photos and avatar go along, the name gets a " (copy)" suffix); the response is
  `{ id, characters|users }` with the NEW id, and the dialog does NOT close — it switches to the
  copy's edit form (the `app.ts` modal blocks wrap the dialog in a single-item `@for ... track
  item-id`, so the dialog component is recreated and re-initializes when the item changes).
  Model clone — a duplicate entry under a free "<name> copy" key (the dialog still closes). The
  settings dialog does NOT manage them — it keeps only the
  listen address and the image generators (with a hint pointing at the header menus).
- Message list is anchored to the bottom (grows upward); a "typing…" indicator shows while the model is
  generating — in reply queues it names the character being asked ("Alice is typing") with their
  avatar/letter, falling back to a neutral glyph when the author is unknown.
- User and assistant messages are visually distinct (avatar + sender label + colored bubble).
- **Images**: stretched to the full chat width — the bubble of a message with images grows to the row
  width via the `has-images` class — and capped at two thirds of the viewport height
  (`width:100%; max-height:2/3vh; object-fit:contain`); when the height cap kicks in and the image
  ends up narrower than the row, `object-fit:contain` centers it. The images are block-level: the
  text is above and below them, never beside.
- Responsive for both desktop and phone.

## Architecture notes

- **Single port in production** — `backend/src/index.ts` mounts the API at `/api`, serves the built
  frontend as static files, and falls back to `index.html` for non-`/api` GETs (SPA).
- **LLM call** (`llm.ts`) — `chatCompletion()` posts to `${baseUrl}/chat/completions`. `trimHistory()`
  trims the tail to fit `contextSize` (never dropping the system prompt), estimating tokens as
  `ceil(len/4) + images*1000`.
- **Frontend store pattern (split by meaning).** App state (signals) and actions live in
  `providedIn: root` stores under `frontend/src/services/`, injected by components
  (`inject(...)`) instead of long `input()`/`output()` lists from a parent. `App` is a thin
  shell (shell + `chatStore.bootstrap()` in `ngOnInit`). Split:
  - `ChatStore` — current chat + chat list: messages, `send`/`saveEdit`, the 📎 attachments
    (`pendingImages`), edit, chat mgmt, new-chat dialog. Injects `ConfigStore` + `UiStore`.
  - `ImageStore` — the image-GENERATION domain: `genMode`/`genRefs`/`generating`, `draw()`,
    `cancelImage`/`regenerateImage`, and the background-job polling (re-reads the chat on a
    1.5 s interval while any image is "pending"). Injects `ChatStore` (one-way) + `ConfigStore`
    + `UiStore`. It reads the current chat / character / edit target and applies the server chat
    back through `ChatStore.applyChat()`. The "what to send" decision (edit → `saveEdit`,
    gen-mode → `draw`, else → `send`) is orchestrated by `InputPanel`, which is what keeps the
    graph acyclic — `ChatStore` never reads `ImageStore`.
  - `ConfigStore` — config + catalogs (models/users/characters), image-gen availability,
    settings dialog (`settingsOpen`/`editingConfig`/`saveSettings`), `loadAll()`. Injects `UiStore`.
  - `UiStore` — cross-cutting UI: the global error banner (written by stores + components).
  Dependencies are one-directional (`ImageStore → ChatStore → ConfigStore → UiStore`) — keep it acyclic.
  Dropdown menu open/close state is **local to `TopBar`** (not a store): a `document` click
  listener closes all; option clicks bubble to `document` so menus close after selection —
  except the participants menu, where name-toggle and ↑/↓ clicks stop propagation (and blur the
  button, so no stale highlight after rows reorder) and the menu stays open for further tweaks.
  DOM concerns stay in the components that own the elements: auto-scroll is an `effect` in
  `MessageList` (reacts to chat/indicator changes), the input textarea is filled/cleared by an
  `effect` in `InputPanel` (reacts to `editTargetId`). Keep new state/actions in a store.
- **Error handling has two surfaces — keep them separate**:
  - Model/LLM failure → the backend appends an assistant message with `error: true` and still returns
    200; the UI renders it as a red bubble (`.msg.error`).
  - Operational/network failure (e.g. the image-gen program fails to spawn, chat not found) → non-2xx →
    the root `error` signal → a dismissable red banner above the input.

## Conventions & gotchas (read before editing)

- **Zoneless Angular.** No zone.js. All root-component state is `signal()`; there is no change detection
  to lean on. Don't reintroduce `@State`/RxJS-driven change detection patterns.
- **Angular template expression limits.** Template binding/action expressions cannot use TypeScript `as`
  casts, `Number(...)`, or pipes for coercion — this is a hard build error. Do coercion in component
  methods (see `setStr/setNum/setBool/setAuto/setArg` in `settings.ts`, `senderLabel/avatarLetter` in
  `app.ts`).
- **No optimistic echo.** `POST /api/chats/:id/messages` only stores the user message and responds
  instantly, so `send` does not push a temporary local message — the server's chat replaces the
  local state right away. The typing row intentionally does **not** carry the `.msg` class so it is
  not matched by the e2e selector for the assistant reply
  (`.msg:not(.user):not(.error)`).
- **Serving images.** `sendImage()` in `routes.ts` streams via `fs.createReadStream(...).pipe(res)` with
  an explicit Content-Type — **not** `res.sendFile` (which threw NotFoundError for these files). Keep the
  streaming approach for chat files and character photos.
- **Frontend dist path.** Angular outputs to `frontend/dist/frontend/browser`. `index.ts` checks that
  path first, then falls back to `frontend/dist/browser`. If you change the Angular output path, update
  both candidates.
- **Component style budget.** Every component owns its own stylesheet
  (`app.scss` + one per `src/components/*`); `angular.json` has an `anyComponentStyle`
  budget (currently 12 kB warn / 32 kB error) per component. If a stylesheet grows past it,
  raise the budget there rather than fighting the default.
- **Component styles do NOT reach child components.** Under emulated view encapsulation Angular
  rewrites a stylesheet's selectors to `.x[_ngcontent-<hash>]`, so they never match elements inside
  a child component's DOM. Each component in `src/components/` therefore owns its `.scss`
  (`styleUrl`). When two components share a class name (e.g. `.opt`, `.icon-btn`, `.send`),
  they carry small self-contained copies — don't "fix" this with `::ng-deep` or global styles.
- **CSS variables live in `frontend/src/styles.scss`, NOT in component styles.** Under emulated view
  encapsulation Angular rewrites a component's `:root { --x: … }` to `[_ngcontent-*]:root`, which never
  matches `<html>` — the variables silently stop resolving, every `var(--x)` falls back to its initial
  value (transparent backgrounds, no borders), and the app only looks half-styled because global
  `html, body` rules cover the rest. Keep the `:root` palette in the global stylesheet.
- **TypeScript version pin.** Backend `typescript` is pinned to `^6.0.2` because `ts-jest`'s peer range
  rejects TS 7. Don't bump backend TS to 7 without resolving the peer conflict.

## E2E

- Playwright, single Chromium project, `workers: 1`, `retries: 1`, `baseURL http://localhost:3211`.
- **Isolated data**: the `webServer` in `playwright.config.ts` starts its own backend on
  `127.0.0.1:3211` with `SILLYTALK_DATA_DIR=e2e/test-data` (gitignored) — the real
  `~/.config/sillytalk` is never touched, no manual backup/restore needed. The backend must be
  built (`npm run build` in `backend/`) before the run.
- Uses **real model calls** — `beforeAll` copies `llmModels` from the user's real
  `~/.config/sillytalk/config.json` into the test config; without it the default test model
  (127.0.0.1:8000) leads nowhere and model-backed tests fail.
- `beforeEach` creates the catalog via the API (`PUT /users`: Carol + Dave; `PUT /characters`:
  Alice + Bob) and clears all chats so each test opens a fresh empty chat.
- Selectors are `data-testid` attributes: `char-name` (joined participant names; click opens the
  participants menu), `model-chip` (click opens the model menu), `menu`,
  `char-option` (a participants-menu row: `.opt-toggle` toggles membership, `.opt-mark` shows
  ● in-chat / ○ out), `model-option` (a model-menu row opened by the chip),
  `char-edit`/`user-edit`/`model-edit` (the ✎ row icons), `new-character`/`new-persona`/`new-model`
  (the "+ New" buttons), `user-option-row`/`model-option-row` (a row wrapper), `chat-date` (the
  "Chat: <date>" label that opens the chat menu), `new-chat`,
  `settings`, `delete-chat`, `history`, `message`, `msg-sender`, `input`, `send`, `attach`,
  `gen-toggle`, `error-banner`, `typing`. The entity dialogs: `character-dialog`/`user-dialog`/
  `model-dialog` + `char-name-input`/`user-name-input`/`model-name-input`/`model-id-input` and
  `char-save`/`char-clone`/`char-delete` (the `user-*`/`model-*` analogues).
- The suite captures screenshots into `e2e/screenshots/`.
