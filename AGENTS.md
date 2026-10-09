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
    index.ts           bootstrap: API + static frontend + SPA fallback;
                       the DI composition root (registers + resolves services)
    di.ts              minimal DI container: typed tokens (createToken<T>) +
                       lazy singletons (register/resolve)
    routes.ts          the thin API assembler:
                       createApiRouter(imageGeneration, textGeneration,
                       characters, persons, chats, configuration, reply)
                       mounts the per-domain routers — every domain folder
                       keeps its own <domain>.routes.ts (the thin HTTP layer:
                       parameter parsing, validation, status codes, file
                       streaming over the services)
    text_generation/   the LLM domain: the top-level service class
                       (TextGenerationService.ts — the OpenAI-compatible provider client:
                       chatCompletion text + image_url, translatePrompt;
                       resolveModel (the chat's model by llmModels key with
                       the first-model fallback); the system prompt,
                       [IMG]/[PHOTO] tag parsing, [SILENT], author labels,
                       history trimming; DI token TEXT_GENERATION) and
                       TextGenerationService.test.ts — jest unit tests
    image_generation/  image generation: the driver
                       interface (IImageGeneratorDriver.ts; the job model —
                       ImageJob.ts / ImageJobResult.ts), the backends
                       (drivers/SdApiDriver.ts / drivers/LocalProgramDriver.ts),
                       the driver factory (DriverFactory.ts), and the top-level
                       service class (ImageGenerationService.ts —
                       ImageGenerationService: availability cache, the
                       background job registry);
                       image.routes.ts — the /image routes (the availability
                       flag + the manual generation);
                       ImageGenerationService.test.ts —
                       jest unit tests (local program, background image jobs)
    characters/        the character domain: the Character.ts type and the
                       top-level service class (CharactersService.ts — the
                       character catalog on the
                       characters/<id>/ folders: CRUD, clone, the full-list
                       sync, the migration from the old config format, the ID
                       validation, the avatar (findAvatar/saveAvatar/
                       deleteAvatar), the list with photos + the avatar flag
                       (listWithPhotos), the photo path (photoFile); DI token
                       DI_CHARACTERS_SERVICE, the root folder injected as
                       () => string);
                       characters.routes.ts — the /characters routes (the
                       catalog sync, the clone, the photos, the avatar);
                       CharactersService.test.ts — jest unit tests
    machine/           the local-generator machine service: the interface +
                       platform selection (IMachineService.ts, DI token
                       DI_MACHINE_SERVICE), the Windows impl
                       (implementations/MachineWindowsService.ts — cmd.exe /
                       powershell wrappers, taskkill) and the POSIX impl
                       (implementations/MachinePosixService.ts — detached
                       process groups, group kill); MachineService.test.ts —
                       jest unit tests (platform selection, command lines)
    chats/             the chat domain: the Chat.ts / ChatMessage.ts /
                       ChatSummary.ts types and the top-level service class
                       (ChatsService.ts — chat + chat-file persistence on the
                       chats.db SQLite database (node:sqlite; the chats table
                       holds the chat fields, messages one row per message —
                       both as JSON blobs; the images stay files in
                       chats/<id>/files/; the legacy chat.json folders are
                       imported once at database open and renamed to
                       chat.json.migrated; the service opens the database
                       lazily and close() is final — later use throws): CRUD,
                       the format guards, the model
                       fallback, the chat files (saveImage,
                       importCharacterPhoto, normalizeImages), the message
                       primitives (addUserMessage, editMessage, deleteMessage),
                       the per-image generation status (setMessageImageStatus);
                       DI token DI_CHATS_SERVICE, the root folder and the
                       configuration service injected); chats.routes.ts — the
                       /chats routes
                       (the chat CRUD, the messages, the reply queue, the
                       per-image generation controls);
                       ChatsService.test.ts — jest unit tests
    persons/           the person (persona card) domain: the Person.ts type and
                       the top-level service class (PersonsService.ts — the
                       persona catalog on the
                       users/<id>/ folders: CRUD, clone, the full-list sync,
                       the ID validation, the avatar (findAvatar/saveAvatar/
                       deleteAvatar), the list with the avatar flag
                       (listWithAvatars); DI token DI_PERSONS_SERVICE, the root
                       folder injected as () => string); persons.routes.ts —
                       the /persons routes (the persona catalog + the avatar);
                       PersonsService.test.ts — jest unit tests
    configuration/     the configuration domain: the types (Config.ts,
                       LlmModel.ts, Model.ts, and the generator settings —
                       ImageGenerator.ts, the union of SdApiSettings.ts /
                       LocalProgramSettings.ts + the type guards: they
                       describe the config schema, so the domain owns them),
                       the top-level service class (ConfigurationService.ts —
                       the config.json load/save with normalization + JSONC
                       comment stripping, the defaults, the listen-address
                       parsing, the flat-model helpers, the legacy-field
                       cleanup (prepareLegacyConfig); DI token
                       DI_CONFIGURATION_SERVICE);
                       config.routes.ts — the /config routes;
                       ConfigurationService.test.ts — jest unit tests
    reply/             the reply domain: the top-level service class
                       (ReplyService.ts — the AI-reply orchestration:
                       appendAssistantReply (system prompt, the history, the
                       model call, the [SILENT]/[IMG]/[PHOTO] parsing, saving,
                       the background image jobs), resolveChatModel (the
                       chat's model with the first-model fallback),
                       saveErrorMessage (the visible error line), the
                       in-flight reply registry (beginReply/endReply/
                       cancelReply), the manual image operations (manualImage,
                       regenerateImage, cancelImage); DI token
                       DI_REPLY_SERVICE, the six domain services injected) and
                       ReplyService.test.ts — jest unit tests
    shared/            small cross-domain helpers as stateless classes with
                       static methods: AvatarFile.ts (the avatar.<ext>
                       find/save/delete, shared by the character and the
                       person services), HttpHelper.ts (sendImage — the file
                       streaming, a routes-layer concern) and PathHelper.ts —
                       the shared data-layout helpers (the data root, the
                       domain folders, expandPath, newId, isDirEntry)
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
  chats/chats.db       (node:sqlite: the chats + messages tables; the legacy
                       chats/<chatId>/chat.json files are imported at database
                       open and renamed to chat.json.migrated)
  chats/<chatId>/files/ — the uploaded/generated images of a chat
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
| Pack the npm release (after `npm run build`) | `npm run package` |

Production: `npm run build && npm run start`, then open http://localhost:3210 — the backend serves both
the API and the built frontend.

The E2E suite does **not** start the server itself (no `webServer` in the Playwright config). Start it
first (`npm run start`, in the background), then run the suite.

## CI / npm publish

`.github/workflows/publish.yml` (mirrors the aiservermanager setup): on push/PR to master it installs
backend + frontend deps, runs the jest suite, builds, and packs the release; on a `v*` tag or a manual
run it additionally publishes to npm (environment `NPM`, secret `NPM_TOKEN`).

`npm run package` (`scripts/package-npm.mjs`) builds `release/sillytalk/` — the publishable package:
`bin/sillytalk.js` (the `npx sillytalk` entry), `backend/dist/`, and the built frontend at
`frontend/dist/frontend/browser/` (the FIRST candidate `index.ts` looks for — keep the package layout
in sync with those candidates), plus a runtime-only `package.json` and `scripts/npm-package/README.md`
as the package README. `release/` is gitignored.

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
      "supportsImages": true,
      "reasoning": false,               // current reasoning level, false = off
      "reasoningLevels": ["low", "medium", "high", "xhigh", "max"]  // optional
    }
  },
  // generation backends: every enabled + available one is used in parallel,
  // the jobs of one generator are queued (enabled defaults to true)
  "imageGenerators": [
    {
      "url": "http://127.0.0.1:7860",   // SD API / Stable Diffusion WebUI (has `url`)
      "steps": 30, "width": 768, "height": 768,
      "denoisingStrength": 0.75, "negativePrompt": "",
      "enabled": true                   // generator toggle (default true)
    },
    {
      "command": "",                    // local program (has `command`)
      "args": ["--prompt", "{prompt}", "--input", "{absolutePathsToInputImages}", "--output", "{absolutePathToOutputImage}"],
      "maxInputImages": 0,
      "enabled": true
    }
  ]
}
```

The config is **flat**: connection settings live on each `llmModels` entry (`baseUrl`,
`apiKey`/`envKey`, `contextSize`) — there is no separate `providers` level. The **key** of
`llmModels` is both the human-visible name and the internal id a chat references
(`chat.modelId`); the entry's `id` field is the identifier actually sent to the provider
(flattened to `Model.name`/`Model.id` in `listModels()`, see
`configuration/ConfigurationService.ts`). The API key is
resolved by `resolveApiKey()`: `envKey` (env var) wins over `apiKey` (literal).

**Environment overrides** (set before server start; used by the e2e suite for isolation):
`SILLYTALK_DATA_DIR` moves the whole data root (`config.json`, `chats/`, `characters/`,
`users/`) elsewhere; `SILLYTALK_CHATS_DIR` / `SILLYTALK_CHARACTERS_DIR` / `SILLYTALK_USERS_DIR`
override the individual folders; `SILLYTALK_LISTEN` overrides the listen address on top of
`config.json`.

- `llmModels[].supportsImages: true` — the model accepts images; sent/reference images are passed into the
  prompt as `image_url` data-URIs.
- `llmModels[].reasoning` — the reasoning level: a string = the level, sent to the provider in both
  common OpenAI-compatible spellings at once — top-level `reasoning_effort` (OpenAI, llama.cpp) and
  `reasoning.effort` (OpenRouter); `false`/absent = off, sent as `chat_template_kwargs.enable_thinking=false`
  (the reliable cross-backend switch — `reasoning_effort` alone does not turn thinking off on llama.cpp,
  and a default-on hybrid model like Qwen would keep thinking); a provider ignores a field it does not
  know. `llmModels[].reasoningLevels` — the possible levels (a string list); when
  absent the default set `low, medium, high, xhigh, max` applies (and a level outside the model's list
  is normalized to off on load). Edited in the model dialog ("Reasoning levels" + "Reasoning" pick).
- **Image generation has no `auto` toggle anymore.** `imageGenerators` is a list of
  generators (SD API by presence of `url`, local program by presence of `command`), each with an
  `enabled` flag (defaults to `true` — a disabled generator is never used). At startup
  (`refreshAvailableGenerators` in `image_generation/ImageGenerationService.ts`) all generators are probed
  (in parallel); the
  SD API availability is checked via `GET {url}/sdapi/v1/sd-models`, a local program is
  available if `command` is set (and, for an absolute path, if that file exists). **Every
  enabled and available generator is used**: jobs of different generators run in PARALLEL
  (a new job is assigned to the least-loaded one), while the jobs of ONE generator are queued
  (one run at a time — a local program / the GPU must not be hit concurrently; the queue is
  keyed by the generator's command/URL, so two entries pointing at the same program share a
  queue). `GET /api/image/status` returns `{ available }` (true when at least one generator
  is available) for the UI. Config changes via `PUT /api/config` recompute the available
  generators.
- Local-program placeholders: `{prompt}` (prompt text), `{absolutePathsToInputImages}` (comma-joined
  absolute paths of the reference images, empty when there are none — matches
  `-InputImagePath a.jpg,b.jpg` style), `{absolutePathToOutputImage}` (absolute path of the output
  PNG the program must write — the backend places it in the chat's `files/` dir; there is no
  `outputDir` config field anymore). The OS-specific launch/kill lives behind the
  `IMachineService` interface (`machine/IMachineService.ts`, selected once at startup in `index.ts` via
  the `createMachineService()` factory for the current OS): on **Windows** `.bat`/`.cmd` run through
  `cmd.exe /d /s /c` with quoted args, `.ps1` through `powershell.exe -NoProfile
  -ExecutionPolicy Bypass -File` (plain executables spawn directly — Node throws EINVAL on
  batch files without a shell), and cancelling kills the process TREE with `taskkill /F /T
  /PID` (a plain `child.kill()` would only terminate the wrapper); on **POSIX** programs
  spawn directly in their own process group (`detached`) and cancelling kills the whole
  group (`kill(-pid)`), while `.bat`/`.cmd` are refused with a clear error. Keep new
  OS-specific behavior in the platform impls (`machine/implementations/MachineWindowsService.ts` /
  `MachinePosixService.ts`), not in
  the image-generation code. A generator's `maxInputImages` caps how many reference images it accepts
  (0 = unlimited; the backend rejects the request with a clear error before spawning).
- **Self-initiated image generation.** When a generator is available, `systemPromptFor`
  adds an instruction letting the model insert `[IMG:description]` tags into its replies; it may
  also pass reference images by index: `[IMG:description | 1,3]`. The index list ("inventory") is
  built per request by `ImageGenerationService.imageInventory` (`image_generation/ImageGenerationService.ts`):
  the character's photos first, then every
  image already in the chat, oldest first; it is appended to the system prompt so the model knows
  what the numbers mean. The backend strips the tags (`extractImageRequests`) and resolves indices
  to files (`ImageGenerationService.resolveInventoryRefs`; character photos are copied into the
  chat via `importCharacterPhoto`).
- **Image generation runs in the BACKGROUND.** Each `[IMG:…]` (or a manual gen-mode draw, or a
  regeneration) gets a reserved file name that is stored in the message RIGHT AWAY with
  `ChatMessage.imageStatus[name] = 'pending'` (`imagePrompts`/`imageRefs` alongside), the reply is
  saved and returned to the client without waiting, and the generation runs as a background job
  (`startImageJob` in `image_generation/ImageGenerationService.ts`). The job writes to a temp file and renames it
  to the reserved
  name only on success (so a name is never left with a partial image); the jobs of one
  generator are **queued** (one run at a time — a local program / the GPU must not be hit
  concurrently) while jobs of different generators run in parallel. When the job
  finishes, `ReplyService` updates the message: ok → the status is cleared (the image is ready);
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
  `[PHOTO:1,3]` tag (same numbering as `[IMG]` refs). `extractPhotoRequests` in `TextGenerationService` strips the
  tags (strict format: numbers only — a bare `[PHOTO]` stays literal text); `appendAssistantReply`
  resolves the indices through `ImageGenerationService.resolveInventoryRefs` (character photos are
  copied into the chat's
  `files/`) and attaches the files to the message like any other image. The inventory itself is now
  built for every reply, generator or not.
- **Generation prompts are always English.** The `[IMG:...]` instruction requires English scene
  descriptions. Manually typed prompts (gen mode) and stored Russian prompts (regeneration) are
  translated to English via the chat's model (`translatePrompt` in `TextGenerationService`, called by
  `ImageGenerationService.ensureEnglishPrompt`) before hitting the generator; on translation
  failure the original text is used.
  The final prompt is stored in `ChatMessage.imagePrompts`, so image hover hints show it.
- **Characters are NOT in the config.** Each character is a folder
  `~/.config/sillytalk/characters/<id>/`: the folder name IS the character id, `character.json` holds
  `{ name, description }`, `photos/` is the fixed "starter" photo set (computed by
  `characterPhotosDir(id)`), and `avatar.jpg` is the character avatar shown next to its messages.
  CRUD lives in `characters/CharactersService.ts`; `GET/PUT /api/characters` read/sync the folders (PUT performs a full
  sync: create/update/delete). An on-disk `characters` field in an old config.json is migrated to
  folders at startup (`index.ts`) and stripped by `PUT /api/config` — do not reintroduce a
  `characters` array in the config.
- **Users are NOT in the config either.** Each person (persona card) is a folder
  `~/.config/sillytalk/users/<id>/` with `user.json` holding `{ name, description }` and `avatar.jpg`
  (persona avatar, shown next to user messages). CRUD lives in `persons/PersonsService.ts` (the
  domain concept in the code is `person`/`persons`, type `Person`); `GET/PUT /api/persons` mirror the
  character endpoints — the `users` JSON body/response fields, the `userId` fields and the on-disk
  layout (`users/`, `user.json`) stay "user"-named. There is **no selected/current user** in the
  config anymore: each chat stores the **active** persona (whose name new messages are sent under) in
  `Chat.userId`, chosen when creating a new chat (dialog) or via the header menu. On a fresh install
  the default person is created with id `default` (previously `me`). The active persona's
  `description` (when non-empty) is appended to the system prompt by
  `systemPromptFor(character, person, …)` so the model knows who it is talking to.
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
  `parseSilence` in `TextGenerationService` — a bare tag means silence, inline occurrences are stripped;
  `reply === null`). In group chats (more than one character or persona)
  `labelHistory` prefixes history lines with speaker names. "Another message from the AI" (empty
  send) continues with the next character in turn order (same reply queue); "Regenerate" is built
  from the same primitives — delete the last message (`DELETE /messages/:id`, kept visible locally
  until the reply arrives) + one `/reply` call as its author — there is no separate
  `/regenerate` route.
  **Canceling the generation** — while a reply is being generated the send button is a cancel
  (✕, Enter does the same): the in-flight `POST /reply` fetch is aborted and
  `POST /api/chats/:id/cancel` aborts the model call on the server (one in-flight controller per
  chat in the `ReplyService` in-flight registry, the signal goes through
  `appendAssistantReply` into `chatCompletion`); a cancelled reply saves NO message (no error
  one either). The queue itself
  stops via the generation session in `ChatStore` (`cancelGeneration()` + `generationSeq`) —
  silently, without the error banner.
  The header character menu toggles participants (last one cannot be removed) and reorders them
  with ↑/↓; there is no legacy single-`characterId` format — old chats were converted once by a
  one-off script.
- **Avatars.** Served/uploaded via `GET/POST/DELETE /api/persons/:id/avatar` and
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
  clone — `POST /api/characters/:id/clone` / `POST /api/persons/:id/clone` (the folder is copied:
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
- While a reply is generating the send button is a red cancel (✕) — clicking it (or Enter) aborts
  the generation (see "Canceling the generation" above); it is NOT disabled. **Editing an existing
  message overrides this**: while `editTargetId` is set the button is always the save (✓) and saves
  the edit (a PATCH) even during a generation — the backend re-reads the chat before appending a
  reply, so the edit and the in-flight reply both persist (like delete-during-generation). The cancel
  (✕) styling/behaviour applies only outside the editing mode.
- User and assistant messages are visually distinct (avatar + sender label + colored bubble).
- **Images**: stretched to the full chat width — the bubble of a message with images grows to the row
  width via the `has-images` class — and capped at two thirds of the viewport height
  (`width:100%; max-height:2/3vh; object-fit:contain`); when the height cap kicks in and the image
  ends up narrower than the row, `object-fit:contain` centers it. The images are block-level: the
  text is above and below them, never beside.
- Responsive for both desktop and phone.

## Architecture notes

- **DI is a minimal hand-rolled container** (`backend/src/di.ts`, no framework): typed tokens
  (`createToken<T>()`) registered as lazy singletons. The composition root is `index.ts` — it
  registers `DI_MACHINE_SERVICE`, `DI_CONFIGURATION_SERVICE`,
  `DI_TEXT_GENERATION_SERVICE`, `DI_CHARACTERS_SERVICE`,
  `DI_PERSONS_SERVICE`, `DI_CHATS_SERVICE`, `DI_IMAGE_GENERATION_SERVICE` and
  `DI_REPLY_SERVICE` and resolves them once; `routes.ts` (the thin API assembler) receives the
  services through
  `createApiRouter(imageGeneration, textGeneration, characters, persons, chats,
  configuration, reply)` and mounts the per-domain routers (each domain folder keeps its own
  `<domain>.routes.ts`). Consumers take dependencies via constructors and never import the
  container themselves.
- **General backend patterns (established by the `image_generation/` refactor).** When a domain
  grows logic of its own, structure it like `image_generation/` does — these rules generalize it:
  - **A domain = a folder + one top-level service class.** `service.ts`-style module globals
    (plain functions + `let`-state) are replaced by a class (`ImageGenerationService`) whose name
    names the file; every cache, registry and map is a private instance field, never a
    module-scoped variable. Pure helpers dissolve into private methods / private statics of the
    class that uses them; a piece used by several classes becomes its own class
    (`DriverFactory.ts`). Interfaces get their own file named after the type
    (`IImageGeneratorDriver.ts`, `ImageJob.ts`); no barrel `index.ts` — consumers import from
    concrete files.
  - **Dependencies are injected through the constructor** (`IMachineService`, `ConfigurationService`);
    the class is registered in the container under a token defined next to it (`IMAGE_GENERATION`)
    and resolved once at the composition root. Tests instantiate the class directly
    (`new ImageGenerationService(...)`) instead of resetting module state.
  - **The service stays persistence- and HTTP-agnostic.** It speaks in ids and primitives
    (`chatId`, reserved file name), returns results the caller applies (`ImageJob.result`),
    and never imports express. `ReplyService` is the exception that proves the rule: it is a
    TOP-LEVEL service that sits above the domain services and orchestrates across them
    (it saves through `ChatsService` and returns the saved chat / the message / a typed
    failure for the route to apply). The pure persistence pieces live in the domain they
    belong to (`ChatsService.setMessageImageStatus`, `ChatsService.normalizeImages`); the
    "a job finished → update the message" orchestration (`startChatImageJob`) is a private
    method of `ReplyService`; file serving (`HttpHelper.sendImage`) stays a routes-layer
    concern, not a domain's.
  - **Keep the dependency graph one-way and acyclic** (`routes → reply → the domain
    services → drivers/machine/configuration/...`): the service may call lower-level services
    and module functions (e.g. `ImageGenerationService` calling
    `ChatsService.importCharacterPhoto` and `TextGenerationService.translatePrompt`;
    `ReplyService` calling all six domain services), but nothing below it may import the
    domain back — that is why the reply orchestration could NOT go into
    `ChatsService` (which `ImageGenerationService` already depends on) and got its own
    `reply/` domain. When pulling code into the service, grep the rest of the project for
    logic that belongs to the domain and move what fits (`ensureEnglishPrompt`,
    `imageInventory`, `resolveInventoryRefs`, `appendAssistantReply`, the in-flight reply
    registry moved from `routes.ts`); leave HTTP concerns (validation, status codes, file
    streaming) in the route files, and be able to say why.
  - **OS/program specifics go behind an interface** selected once at startup
    (`IMachineService` + `machine/implementations/MachineWindowsService.ts` /
    `MachinePosixService.ts`); the domain code never
    branches on `process.platform`.
  - **Migration done:** every former module-level domain is now a folder with a top-level
    service class — `text_generation/TextGenerationService.ts`,
    `characters/CharactersService.ts`, `chats/ChatsService.ts`,
    `persons/PersonsService.ts`, `configuration/ConfigurationService.ts` (the last one moved out
    of the function-style `config.ts`), `reply/ReplyService.ts` (the AI-reply orchestration, moved out of the
    former monolithic `routes.ts`, together with the per-domain `<domain>.routes.ts`
    split). New domains must start as service classes right away — no stateful
    module globals; new routes go into the domain's `<domain>.routes.ts`, not the
    assembler.
- **Single port in production** — `backend/src/index.ts` mounts the API at `/api`, serves the built
  frontend as static files, and falls back to `index.html` for non-`/api` GETs (SPA).
- **LLM call** (`text_generation/TextGenerationService.ts`) — `chatCompletion()` posts to `${baseUrl}/chat/completions`. `trimHistory()`
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
- **Serving images.** `HttpHelper.sendImage()` (`shared/HttpHelper.ts`, used by the per-domain
  routers) streams via `fs.createReadStream(...).pipe(res)` with
  an explicit Content-Type — **not** `res.sendFile` (which threw NotFoundError for these files). Keep the
  streaming approach for chat files, character photos and avatars.
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
- Uses **mocked model + image generation** — both suites share `e2e/helpers/mocks.ts`:
  a deterministic OpenAI-compatible LLM (the delay before answering is controllable at
  runtime via `MockLlm.setDelay`) and a mock local-program image generator (a node script
  that sleeps, fails on "fail" prompts, and is slow on "slow" ones — plain `node` instead of
  a bash script, because "bash" on Windows may be a WSL stub without a distro). `beforeAll` starts the
  mock LLM, `beforeEach` points the config's `llmModels`/`imageGenerators` at the mocks, so
  the run is fast and does not depend on the user's real models. The mock LLM answers
  "Mock reply from <character name>." (the name is read from the system prompt); the
  ux-explore suite passes a `drawReplies` option so it can test the model-initiated
  `[IMG:...]` / `[PHOTO:1]` tags. The "hanging model" cancel test in `app.spec.ts` still
  spins up its own never-answering server (on top of the mocks).
- `beforeEach` also creates the catalog via the API (`PUT /persons`: Carol + Dave;
  `PUT /characters`: Alice + Bob) and clears all chats so each test opens a fresh empty chat.
- Selectors are `data-testid` attributes: `char-name` (joined participant names; click opens the
  participants menu), `model-chip` (click opens the model menu), `menu`,
  `char-option` (a participants-menu row: `.opt-toggle` toggles membership, `.opt-mark` shows
  ● in-chat / ○ out), `model-option` (a model-menu row opened by the chip),
  `char-edit`/`user-edit`/`model-edit` (the ✎ row icons), `new-character`/`new-persona`/`new-model`
  (the "+ New" buttons), `user-option-row`/`model-option-row` (a row wrapper), `chat-date` (the
  "Chat: <date>" label that opens the chat menu), `new-chat`,
  `settings`, `delete-chat`, `history`, `message`, `msg-sender`, `input`, `send` (➤ normally; ✕
  while a reply is generating — it is the cancel then), `attach`,
  `gen-toggle`, `error-banner`, `typing`. The entity dialogs: `character-dialog`/`user-dialog`/
  `model-dialog` + `char-name-input`/`user-name-input`/`model-name-input`/`model-id-input` and
  `char-save`/`char-clone`/`char-delete` (the `user-*`/`model-*` analogues).
- The suite captures screenshots into `e2e/screenshots/`.
