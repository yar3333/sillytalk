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
    cli.ts             the command line (the thin layer of the same kind):
                       parseArgs/run/main + USAGE; `test-comfyui <url>` runs the
                       ComfyUI self-test. The published bin runs the SERVER with
                       no argument and this CLI with any argument, so a mistyped
                       command errors instead of silently starting a server;
                       `require.main === module` makes `node dist/cli.js` work
                       too. Exit codes: 0 clean, 1 something wrong, 2 bad
                       command line. Ctrl+C cancels the run (the service aborts
                       the job and the server is told to drop it)
    text_generation/   the LLM domain: the top-level service class
                       (TextGenerationService.ts — the OpenAI-compatible provider client:
                       chatCompletion (text + the image_url parts of the
                       pictures a card shows), translatePrompt, tunePrompt
                       (English + shaped for the generator — the picture
                       editor's "Make it English"), describePicture (a vision
                       caption for the editor's "Describe the picture") and
                       composeImagePrompt (the JSON plan of the picture of the
                       user's turn, reused as the editor's "From the chat") —
                       all on the one requestCompletion;
                       resolveModel (the config's global chatModel by llmModels
                       key with the first-model fallback), resolveVisionModel
                       (the model that looks at pictures: the config's
                       visionModel, else the chat model when it can see, else the
                       first that can) and resolveImagePromptModel (the config's
                       imagePromptModel, else the chat model) — all three take
                       the CONFIG and nothing else, because the models are
                       app-wide settings; the system prompt (which now
                       says the model itself cannot attach or draw pictures),
                       the [SILENT] marker, author labels, the text description
                       of a card in a history line, history trimming;
                       DI token DI_TEXT_GENERATION_SERVICE) and
                       TextGenerationService.test.ts — jest unit tests
    image_generation/  image generation: the driver
                       interface (IImageGeneratorDriver.ts — key + queueKey; the
                       job model — ImageJob.ts / ImageJobResult.ts), the backends
                       (drivers/ComfyUiDriver.ts / drivers/SdApiDriver.ts), the
                       ComfyUI domain folder (comfyui/ComfyUiWorkflows.ts — the
                       loader of the models the app can draw with: the workflow
                       of a model is a raw JSON FILE, read again for every job,
                       so replacing one needs no rebuild — comfyUiModelNames()
                       for the Settings pick, comfyUiWorkflowSet(model) +
                       variantFor(refs) + comfyUiMaxRefs(set) for the driver,
                       comfyUiWorkflowEntries() for the self-test (the whole
                       catalogue with the source folder, the templates and the
                       reason a file is unusable); COMFYUI_WORKFLOW_VARIANTS is
                       the variants in the order of their reference count;
                       the app's own files are comfyui/workflows/<model>.json
                       — qwen-image-2.1.json and qwen-image-2512.json, the UI
                       format as ComfyUI saves it — and the user's own
                       <data root>/comfyui/<model>.json replaces one of them or
                       adds a model; the build copies the folder into dist —
                       backend "scripts/copy-workflows.cjs", because tsc only
                       compiles TypeScript),
                       comfyui/ComfyUiServerInfo.ts (the loose types of what a
                       ComfyUI server REPORTS about itself — /system_stats and
                       /object_info — plus comboOptionsOf(), the two spellings of
                       a combo input; every field optional because these are the
                       server's fields and they moved between releases),
                       comfyui/ComfyUiSelfTestService.ts (the class behind
                       `sillytalk test-comfyui`: five steps, cheapest first —
                       /system_stats and its GPUs and free VRAM, the workflow
                       catalogue, POST /workflow/convert per template,
                       /object_info compared with what the workflows ask for
                       (a node class it lacks — confirmed by the per-class
                       endpoint, so a lazily loaded node is not a false alarm —
                       and a model file name the server does not have, while a
                       PARAM_* placeholder is never compared with a list of
                       files), then one REAL job per template with the app's own
                       driver, the picture checked by reading the size out of its
                       own header; a line sink is the report, so the test reads
                       the lines as the user does; it reads no config and writes
                       nothing but its output folder, because the point is to
                       test a server the user has not configured yet),
                       the driver factory (DriverFactory.ts), and the top-level
                       service class (ImageGenerationService.ts —
                       ImageGenerationService: availability cache, the
                       background job registry keyed by the IMAGE ID the job
                       writes to, the per-queueKey serialization with a
                       round-robin pick between the generators of one queue;
                       it takes the text-generation, configuration and
                       image-metadata services and knows nothing about chats or
                       messages — a job that may outlive its chat is noticed
                       through the caller's `gone` guard, not through a chat
                       folder on disk);
                       image.routes.ts — the /image routes (the availability
                       flag + the ComfyUI model list + the manual generation +
                       the picture editor's LLM helpers: /prompt, /tune-prompt,
                       /describe, and /caption — the caption the vision model
                       writes into an attached card that has none);
                       ImageGenerationService.test.ts —
                       jest unit tests (an in-file mock ComfyUI server:
                       the PARAM_* substitution, the workflow per reference
                       count, the queue of one server, background image jobs)
    images/            the image-metadata domain: the top-level service classes
                       ImageMetaService.ts (the global images.db SQLite database
                       (node:sqlite) — ONE `images` table keyed by the image id
                       (the path of the picture relative to the data root):
                       the description, the prompt and its refs/depicts/source/
                       generator/model/size/steps and the row timestamps; the
                       one source an image card is filled from on read; merge-
                       on-write where undefined/empty removes a field and a row
                       left saying nothing is deleted; get/getMany/list/set/
                       remove/move/copy/removeUnder/repointRefs; nothing is
                       migrated into it — the old format (the <image>.png.json
                       sidecar next to a picture) is not supported, so those
                       leftover files are neither read nor rewritten nor
                       deleted, and a picture with one simply has no row;
                       close() is final; DI token DI_IMAGE_META_SERVICE) and
                       PictureLibraryService.ts (the picture browser's service:
                       browse() = sync() first, then the files of the picture
                       folders with their
                       rows + the orphan rows last, every entry with its
                       referencedBy count — how many other rows' refs name it,
                       computed on every read, never stored — and its sameAs
                       list (the other files holding exactly these bytes: same
                       extension, size and sha256; computed on read too, never a
                       constraint), sync() = the disk
                       reconciliation (a file without a row gets one with the
                       facts of its file size/mtime/sha256; a row whose file is
                       gone matches a file by SIZE + HASH — the name, its folder
                       and even its extension may change, the bytes are the
                       picture — and FOLLOWS it: meta.move + the batched
                       ChatsService.repointImageIds; if that path already carries
                       a record of different bytes, the two records trade places
                       through meta.swap, so the file keeps its own description
                       and the stranded one becomes an orphan),
                       edit() = the
                       description/
                       prompt/refs of any picture of the data folder, rename()
                       = a move of WHAT IS THERE: a picture with a file moves the
                       file, a record whose file is gone moves the row (and
                       attaches to a file that already lives at the new id — how
                       a description comes back to a picture renamed outside the
                       app); the new folder must already exist, the target must
                       have neither a file nor a record, and a picture still
                       being generated waits. The chat cards and the stored
                       reference lists follow through
                       ChatsService.repointImageId; the refusal is an error the
                       banner shows; forget() = drops the record of a picture
                       whose file is gone (an existing file is refused — the app
                       never deletes pictures); DI token
                       DI_PICTURE_LIBRARY_SERVICE);
                       images.routes.ts — the /pictures routes (GET the catalog,
                       PATCH the edit, POST /rename, DELETE = forget); the id
                       travels in the body, never in the URL;
                       PictureLibraryService.test.ts +
                       ImageMetaService.test.ts — jest unit tests
    characters/        the character domain: the Character.ts type and the
                       top-level service class (CharactersService.ts — the
                       character catalog in the `characters` table of the
                       catalogs.db SQLite database (node:sqlite; the card — id
                       (also the folder name of the entity's pictures), name,
                       description, avatar (an image id); the characters/<id>/ folders hold only the
                       pictures — a leftover character.json is not read): CRUD
                       (one card at a time — save/delete), clone, the migration
                       from the old
                       config format, the ID validation, the ID rename (the row
                       + the folder move together), the avatar (an image id kept
                       in the row's `avatar` column — getAvatarId/setAvatarImage/
                       clearAvatar/repointAvatar, the picture picked from disk or
                       from an existing id, a byte-identical picture already in
                       the data folders reused rather than copied through the
                       image-metadata service's findByHash), the list with photos
                       + the avatar id (listWithPhotos), the picture ids of the
                       folder (pictureIdsOf); DI token
                       DI_CHARACTERS_SERVICE, the root folder, the database
                       file and the image-metadata service injected, close() is
                       final);
                       characters.routes.ts — the /characters routes (GET the
                       catalog, PUT /:id create-or-update, DELETE /:id — which
                       takes the character's folder and nothing else —, the
                       clone, the avatar pick/clear; the
                       pictures are served by the one /media route by id);
                       CharactersService.test.ts — jest unit tests
    chats/             the chat domain: the Chat.ts / ChatMessage.ts /
                       ChatSummary.ts types and the top-level service class
                       (ChatsService.ts — chat + chat-file persistence on the
                       chats.db SQLite database (node:sqlite; the chats table
                       holds the chat fields, messages one row per message —
                       both as JSON blobs; the images stay files in
                       chats/<id>/, WHAT IS KNOWN about them lives in the
                       one global images table — an image-card row stores no
                       caption/prompt/depicts of its own, get() fills a card
                       from the table on every read, and with no row the card
                       reads as a picture nobody described: a message row that
                       still carries words of its own (the old format) is not
                       read and its copy is dropped from the stored row on the
                       first write; the legacy chat.json folders
                       are imported once at database open and renamed to
                       chat.json.migrated; the service opens the database
                       lazily and close() is final — later use throws): CRUD,
                       the clone (clone — the messages, the settings, the files/
                       folder and a picture row per copied picture, every image
                       id and reference repointed at the copy's folder),
                       the date-based default ID (a new chat is named by its
                       creation moment yyyy-mm-dd_hh-mm-ss, a "-2"/"-3" suffix
                       keeps it unique) and the chat's own ID rename
                       (rename — the folder move + the chats/messages rows
                       re-keyed + every chats/<old>/ picture id and images.db
                       row repointed; it refuses a malformed or taken name and
                       a chat whose picture is still pending),
                       the format guards (the retired per-chat model picks are
                       stripped from a stored blob on the first read — the models
                       are global settings now),
                       the chat files (saveImage with an English
                       name hint that de-duplicates by content (a byte-identical
                       picture already in the data folders is reused, not copied —
                       the image-metadata findByHash size+sha256 check),
                       reservedImageId, importImage, normalizeImages — every
                       picture is
                       addressed by its data-root-relative ID, never by an
                       absolute path), the message primitives (addUserMessage,
                       addImageMessage, editMessage, setMessageText,
                       deleteMessage), the picture-card edits (editImageCard —
                       the description and the generation block, which can be
                       dropped as a whole (a card that is "just a file": the
                       row's generation fields go with it, or the prompt would
                       come back on read) — replaceMessageImage,
                       replaceMessageImageId),
                       the per-image generation status (setMessageImageStatus),
                       the chat-exists check a queued image job asks for
                       (exists()) and the rename support for the picture
                       browser (repointImageId — the cards and the status maps
                       of every chat follow a renamed picture; repointImageIds
                       applies several replacements in ONE pass, which is what a
                       trade of two ids needs — and is what the disk sync calls);
                       DI token DI_CHATS_SERVICE, the root folder and the
                       image-metadata service
                       injected); chats.routes.ts — the
                       /chats routes
                       (the chat CRUD + the clone (POST /:id/clone) + the ID
                       rename (POST /:id/rename), the
                       messages, the reply queue, the
                       picture of the user's turn (POST /:id/auto-image), the
                       card edit (PATCH /:id/messages/:id/picture), the
                       per-image generation controls);
                       ChatsService.test.ts — jest unit tests
    persons/           the person (persona card) domain: the Person.ts type and
                       the top-level service class (PersonsService.ts — the
                       persona catalog in the `persons` table of the same
                       catalogs.db (the card — id (also the folder name of the
                       picture folder under users/), name, description, avatar (an
                       image id); a
                       leftover user.json is not read): CRUD (one card at a
                       time — save/delete), clone, the ID validation, the ID
                       rename (the row
                       + the folder move together), the avatar (an image id kept
                       in the row's `avatar` column — getAvatarId/setAvatarImage/
                       clearAvatar/repointAvatar, deduped through the image-
                       metadata service), the list with the avatar id
                       (listWithAvatars), the picture ids of the folder
                       (pictureIdsOf); DI token DI_PERSONS_SERVICE, the root
                       folder, the database file and the image-metadata service
                       injected, close() is final); persons.routes.ts —
                       the /persons routes (GET the catalog, PUT /:id
                       create-or-update, DELETE /:id, the clone, the avatar
                       pick/clear);
                       PersonsService.test.ts — jest unit tests
    configuration/     the configuration domain: the types (Config.ts,
                       LlmModel.ts, Model.ts, and the generator settings —
                       ImageGenerator.ts, the union of SdApiSettings.ts /
                       ComfyUiSettings.ts + the isSdApiGenerator /
                       isComfyUiGenerator guards on the `kind` discriminator:
                       they describe the config schema, so the domain owns
                       them),
                       the top-level service class (ConfigurationService.ts —
                       the config.json load/save with normalization + JSONC
                       comment stripping, the defaults, the listen-address
                       parsing, the flat-model helpers, the legacy-field
                       cleanup (prepareLegacyConfig), normalizeGenerators (an
                       entry without a known `kind` is dropped — a generator
                       the app cannot run is not a generator), and the model-pick
                       cleanup (the three global keys — chatModel, visionModel,
                       imagePromptModel — each dropped when it names a model no
                       longer in llmModels); DI token
                       DI_CONFIGURATION_SERVICE);
                       config.routes.ts — the /config routes;
                       ConfigurationService.test.ts — jest unit tests
    reply/             the reply domain: the top-level service class
                       (ReplyService.ts — the AI-reply orchestration:
                       appendAssistantReply (system prompt, the history, the
                       model call, the [SILENT] parsing, saving a TEXT-ONLY
                       message — a character never carries a picture),
                       attachUserImages (the caption message + one image card
                       per attached picture), requestUserTurnImage (the 📷
                       picture of the user's turn: a placeholder card at once,
                       the model's plan + the generation in the background),
                       resolveChatModel (the
                       chat's model with the first-model fallback),
                       saveErrorMessage (the visible error line), the
                       in-flight reply registry (beginReply/endReply/
                       cancelReply), the manual image operations (manualImage,
                       regenerateImage, editPicture — the picture editor's save:
                       description / prompt / the image the card points at /
                       kind "generated"|"file", replaceImage, cancelImage) and
                       the editor's LLM helpers (planPicturePrompt — the prompt
                       from the dialogue, tunePicturePrompt — English + shaped
                       for the generator, describePicture — a vision caption,
                       captionPicture — the caption of an attached card, written
                       by the chat's vision model); DI token
                       DI_REPLY_SERVICE, the six domain services injected) and
                       ReplyService.test.ts — jest unit tests
    shared/            small cross-domain helpers as stateless classes with
                       static methods: DataUrl.ts (image(dataUrl) — the one
                       parser of a `data:image/…;base64,` URL into its buffer,
                       a normalised file extension and its sha256 hash; the
                       avatar and chat-attachment paths both go through it, so
                       the same bytes hash the same way for the de-dup),
                       FileFacts.ts (of(file) — the size, the modification time
                       and the sha256 of a picture file, the facts the images
                       table recognises a moved file by; written by every place
                       that writes a picture — a save, an import, a generated
                       picture — as well as by the disk sync, so a row is never
                       blind to its own file),
                       HttpHelper.ts (sendImage — the file
                       streaming and the picture-format guard isImage, both a
                       routes-layer concern; every file response of the app
                       goes through them, and each has its test),
                       ImageMeta.ts (the row shape of the images table: the
                       open ImageMeta record + the ImageGenerationRecord
                       written at generation time + IMAGE_GENERATION_KEYS —
                       the fields a "this is just a file" edit clears), and
                       PathHelper.ts —
                       the shared data-layout helpers (the data root, the
                       domain folders, expandPath, newId, isDirEntry, and the
                       image ID pair imageIdOf/resolveImageId — the latter
                       refusing any path that escapes the data folders — plus
                       the stricter resolvePictureId of the media route, which
                       accepts only the folders pictures live in, and
                       listPictureIds — the newest-first catalog of the picture
                       browser, reading only those folders and only the names
                       HttpHelper.isImage accepts; the three database files
                       chatsDatabaseFile/imagesDatabaseFile/
                       catalogsDatabaseFile; PathHelper
                       and HttpHelper have their own tests)
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
                       (send/saveEdit), the 📎 attachments (pendingImages) and
                       their auto-caption (captionAttachments →
                       POST /image/caption), the isUserTurn flag (when the 📷
                       button belongs), the vision model (visionModel /
                       selectVisionModel — the header's 👁), edit,
                       chat mgmt (incl. the chatTitle and the clone),
                       new-chat dialog
    image-store.ts     ImageStore: image GENERATION — genMode/genRefs/generating,
                       draw(), requestTurnImage() (the 📷 picture of the user's
                       turn), cancel/regenerate of message images, the picture
                       editor's target (pictureEdit) + savePictureEdit, the
                       lightbox, the background-job polling;
                       depends ONE-WAY on ChatStore
    picture-library-store.ts
                       PictureLibraryStore: the picture browser — open/refresh
                       (GET /pictures), the selected picture, savePicture (the
                       PATCH of the description/prompt/refs — the row IS the
                       chat card, so the current chat is re-read after it) and
                       renamePicture (the server-side file move; the catalog is
                       re-read, the selection follows the new id)
    ui-store.ts        UiStore: cross-cutting UI state (global error banner)
    helpers.ts         pure helpers: chat labels, times, the chat title
                       (chatTitleOf) and the chat-row hint (chatHintOf),
                       message counts, the
                       avatar letter, the narration split, the image hover hint
                       (imageHintFor), the reasoning-levels list parse
  src/components/      UI components, each with its own .scss (encapsulation!);
                       read state/actions via injected stores — no big input lists
    top-bar/           header: character/user menus (edit icons + "New"),
                       the chat title + its chat-actions ⋮ (settings / clone /
                       delete) and its chat menu (the list rows = the chat
                       title + the count, the hint = who + the last date),
                       model chip (menu + edit icons), ⋮ menu (Settings +
                       Pictures — the picture browser dialog)
    message-list/      history: empty state, messages, typing indicator
    message-row/       one message: avatar, text, or the image CARD (the picture
                       with its caption, prompt and reference count; the
                       pending/broken/cancelled placeholders; the ↻ quick
                       redraw) + the hover buttons (image actions via
                       ImageStore, the ✎ of a card = the picture editor)
    picture-dialog/    the picture editor, opened by the ✎ of a card — the
                       kind (generated / from a file), the prompt (with "From
                       the chat" and "Make it English"), the description (with
                       "Describe the picture"), the picture id pick of the data
                       folder (GET /pictures) / a file from disk, the preview;
                       Save only edits the card (drawing stays the card's ↻)
    picture-library/   the picture browser (the ⋮ menu → Pictures): every
                       picture of the data folder with its row of the images
                       table — the filterable thumbnail list (a row shows the
                       file name, the description, the "N refs" count and the
                       id) with its sort pick (newest / by ID) beside the
                       filter, beside
                       the editor of the selected one (description, prompt, the
                       reference list the prompt names, the ID field with its
                       Rename action right of the field and the "used as a
                       reference by N" hint under it — a rename moves the file
                       and the cards
                       follow); state/actions in PictureLibraryStore
    input-panel/       input: error banner, gen-mode bar, 📎 attachments, the 📷
                       "picture of my turn" button, send;
                       orchestrates the "what to send" decision (edit/gen/text)
    new-chat-dialog/   new chat: user + character pick (local selection state)
    character-dialog/  character edit dialog (name, description, avatar,
                       Delete/Clone)
    user-dialog/       persona edit dialog (name, description, avatar, Delete/Clone)
    model-dialog/      model edit dialog (llmModels entry fields, the reasoning
                       pick + levels, Delete/Clone)
    chat-settings-dialog/ the per-chat name + the ID field with its Rename button + the per-chat overrides: temperature /
                       min-P / repetition penalty + the system-prompt addition
    image-lightbox/    a picture enlarged over a dark backdrop (ImageStore
                       .lightbox carries the media URL)
    settings/          settings modal (listen address / the picture prompt model / image generation)
  angular.json         build config (incl. style budgets)
  proxy.conf.json      dev proxy: /api -> http://localhost:3210

e2e/                   Playwright suite
  playwright.config.ts
  tests/app.spec.ts
  screenshots/         captured by the suite

~/.config/sillytalk/   runtime data (NOT in the repo)
  config.json
  images.db           (node:sqlite: the one global images table — every picture
                       of the data folder by its data-root-relative id, with
                       its description, prompt, references and cast, plus the
                       facts of its file (size, mtime, sha256) kept by the disk
                       sync; the picture browser edits it, chat cards read it;
                       nothing is
                       migrated in — a leftover <image>.png.json of the old
                       format is not read and left where it is)
  chats/chats.db      (node:sqlite: the chats + messages tables; the legacy
                       chats/<chatId>/chat.json files are imported at database
                       open and renamed to chat.json.migrated; a message row
                       of a picture card stores only the image id and its
                       status — the caption/prompt live in images.db)
  chats/<chatId>/   — the pictures of a chat, sitting directly in the chat's folder,
                       every one of them addressable by its data-root-relative id
                       (<chatId>/<slug>-<6hex>.png); plain pictures, nothing is
                       written next to them (the old files/ subfolder is gone — no
                       legacy path is read)
  characters/<id>/  — the pictures of a character, directly in its folder (the
                       "starter" set the planner offers as look references); the
                       avatar is one of these pictures, named by the row's `avatar`
                       column rather than a fixed avatar.<ext> file (the card itself
                       is a row of catalogs.db, the folder holds no files of its own
                       besides pictures; a leftover character.json is not read)
  users/<id>/       — the pictures of a persona, directly in its folder; the avatar
                       is one of these pictures, named by the row's `avatar` column
                       (the card is a row of catalogs.db; a leftover user.json is
                       not read)
  catalogs.db       (node:sqlite: the characters + persons tables — the cards
                       themselves: id (also the folder name of the entity's
                       pictures), name, description, avatar (the data-root-relative
                       id of the picture used as the avatar, or NULL); opened lazily,
                       close() is final; the old character.json / user.json files
                       are not read and not touched)
  comfyui/           — the user's own ComfyUI workflows: <model>.json replaces the
                       workflow the app ships for that name, or adds a model (the
                       file name is the model name); empty by default
  comfyui-test/      — the pictures `sillytalk test-comfyui` drew, written by that
                       command only (--out moves them); no reader, safe to delete
```

## Commands

Run from the repo root unless noted.

| Task | Command |
| --- | --- |
| Install all deps (root + backend + frontend) | `npm run install:all` |
| Build backend + frontend | `npm run build` |
| Run production (single server, port 3210) | `npm run start` |
| Run dev (backend :3210 + Angular :4200, `/api` proxied) | `npm run dev` |
| CLI of the built backend (e.g. `-- test-comfyui http://127.0.0.1:8188`) | `npm run cli -- <command>` |
| Backend unit tests (jest) | `cd backend && npm test` |
| Frontend unit tests (vitest via `ng test`) | `cd frontend && npm test` |
| Frontend production build | `cd frontend && npm run build` |
| E2E (auto-starts an isolated server on :3211; backend must be built) | `cd e2e && npx playwright test` |
| E2E, then discard the screenshots that did not really change | `npm run test:e2e` |
| Discard the re-taken screenshots whose pixels are the committed ones | `npm run shots:clean` (add `-- --max-diff 0.5` / `-- --dry-run`) |
| Pack the npm release (after `npm run build`) | `npm run package` |

Production: `npm run build && npm run start`, then open http://localhost:3210 — the backend serves both
the API and the built frontend.

The E2E suite does **not** start the server itself (no `webServer` in the Playwright config). Start it
first (`npm run start`, in the background), then run the suite.

## CI / npm publish

`.github/workflows/publish.yml` (mirrors the aiservermanager setup) runs on a `v*` **tag**, a **PR** to
main/master, and **manual dispatch** — and deliberately **not on branch pushes**: a release push carries
its tag, so the tag run (which runs the same tests) is the only build of that commit. Deduplicating by a
shared `concurrency` group was the earlier attempt and it is racy — the branch run and the tag run cancel
each other, and the cancelled one can be the run that publishes (aiservermanager hit exactly this).

- **`build`** — installs backend + frontend deps, runs the jest suite, `npm run build`,
  `node scripts/package-npm.mjs`, and uploads `release/sillytalk` as the `npm-release` artifact.
- **`publish`** (`needs: build`, tag or manual dispatch only) **downloads that artifact** and publishes it —
  the release is the tree that was tested, never a rebuild. No `NPM_TOKEN`: npm **trusted publishing** —
  `environment: NPM`, `permissions: id-token: write`, `npm install -g npm@latest` (trusted publishing
  needs npm ≥ 11.5 and the runner image lags), `npm pack --dry-run`, then
  `npm publish --access public --provenance`.
  One-time setup on npmjs.com: register `sillytalk`'s trusted publisher as this repo +
  `.github/workflows/publish.yml` + the `NPM` environment (and the `NPM` environment must exist in the
  repo settings). The `NPM_TOKEN` secret is no longer read and can be deleted.

Release flow: `npm version patch|minor|major` (bumps the root `package.json` version — the version
`scripts/package-npm.mjs` puts into the package — and makes the release commit + tag), then
`git push origin master --tags`; the tag triggers the pipeline.

`npm run package` (`scripts/package-npm.mjs`) builds `release/sillytalk/` — the publishable package:
`bin/sillytalk.js` (the `npx sillytalk` entry: **no argument runs the server, any argument goes to
`backend/dist/cli.js`** — that is what keeps `npx sillytalk` the documented way to start the app while
`sillytalk test-comfyui …` still reports a typo instead of starting a server), `backend/dist/`, and
the built frontend at `frontend/dist/frontend/browser/` (the FIRST candidate `index.ts` looks for —
keep the package layout in sync with those candidates), plus a runtime-only `package.json` and
`scripts/npm-package/README.md` as the package README. `release/` is gitignored.

## Configuration

Stored at `~/.config/sillytalk/config.json`, auto-created with examples on first run. Editable as a file
or through the in-app **Settings** dialog. Paths may use `~` (resolved by `expandPath`).

```jsonc
{
  // address the server listens on (host:port) — port is parsed from here
  "listen": "0.0.0.0:3210",
  // key = model name inside the app (displayed, chosen in the menu) AND the
  // identifier the global picks below name; value field `id` is the
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
  // The models are settings of the WHOLE APP, not of a chat (the header's model
  // chip and 👁 write them; the Settings dialog keeps only the prompt model).
  // The one that talks (replies, and the default of every other role); unset or
  // unknown = the first model of llmModels.
  "chatModel": "openrouter/anthropic/claude-3.5-sonnet",
  // The one that LOOKS at pictures (card captions, the describe helpers); unset
  // or unknown = the chat model when it can see, else the first that can.
  "visionModel": "",
  // the llmModels key of the model that PLANS the picture prompts (the 📷 "picture of
  // my turn" and the editor's "From the chat"); unset or a model that is gone = the
  // chat model plans. It does not affect replies or picture captions.
  "imagePromptModel": "",
  // generation backends: kind = "sdapi" | "comfyui" decides the type; every
  // enabled + available one is used in parallel, the jobs of one SERVER are
  // queued (enabled defaults to true)
  "imageGenerators": [
    {
      "kind": "sdapi",                  // SD API / Stable Diffusion WebUI
      "url": "http://127.0.0.1:7860",
      "steps": 30, "width": 768, "height": 768,
      "denoisingStrength": 0.75, "negativePrompt": "",
      "enabled": true                   // generator toggle (default true)
    },
    {
      "kind": "comfyui",                // a ComfyUI server
      "url": "http://127.0.0.1:8188",
      "model": "qwen-image-2.1",        // ONE of comfyUiModelNames()
      "device": "cuda:0",               // the GPU the workflow pins its loaders to
      "width": 1328, "height": 1328,
      "enabled": true
    }
  ]
}
```

The config is **flat**: connection settings live on each `llmModels` entry (`baseUrl`,
`apiKey`/`envKey`, `contextSize`) — there is no separate `providers` level. The **key** of
`llmModels` is both the human-visible name and the internal id the three global picks
(`chatModel`, `visionModel`, `imagePromptModel`) name; the entry's `id` field is the identifier
actually sent to the provider
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
  generators, each named by its `kind` (`sdapi` / `comfyui`) and carrying an
  `enabled` flag (defaults to `true` — a disabled generator is never used). An entry whose
  `kind` the app does not know is dropped by `normalizeGenerators` — there is **no legacy
  format support** (no bare-`url` SD entry, no `command` entry; the old local-program
  generators were converted once by a throwaway script). At startup
  (`refreshAvailableGenerators` in `image_generation/ImageGenerationService.ts`) all generators are probed
  (in parallel): the SD API availability is checked via `GET {url}/sdapi/v1/sd-models`, a ComfyUI
  generator is available when a readable workflow file defines its `model` (the app's own or the
  user's) and `GET {url}/system_stats` answers. **Every enabled and available generator is used**: jobs of
  different generators run in PARALLEL (a new job goes to the least-loaded QUEUE, and between the
  generators of that queue the pick rotates, so two models of one server both get their jobs),
  while the jobs of ONE server are queued (one run at a time — the GPU must not be hit
  concurrently). This is why the driver carries TWO ids: `key` (the generator's identity — written
  into the picture row's `generator` and shown in the hover hint) and `queueKey` (the queue identity:
  `comfyui:<url>` for ComfyUI, so two generators of one server share one queue; for SD API it is
  its own `key`). `GET /api/image/status` returns `{ available, comfyUiModels }` for the UI —
  `available` is true when at least one generator is available and `comfyUiModels` is
  `comfyUiModelNames()`, the list the Settings dialog fills its model pick from (the frontend does
  not mirror the model names). Config changes via `PUT /api/config` recompute the available
  generators.
- **A ComfyUI workflow is a JSON file, not compiled code** (`image_generation/comfyui/`, ported
  from the PowerShell scripts that used to sit next to the app). The app ships
  `comfyui/workflows/qwen-image-2.1.json` and `comfyui/workflows/qwen-image-2512.json`; a file
  holds the UI-format graph under the keys `text` / `oneImage` / `twoImages` — the template per
  number of reference images — and a model may ship fewer of them than the app's own three,
  which is simply how many references it takes. `<data root>/comfyui/<model>.json` **replaces** the
  shipped file of that name or **adds** a model, and the file name is the model name the generator
  picks. The folder is created on startup and the files are re-read for every job and every
  `/api/image/status`, so an edit takes effect on the next picture with no restart; the driver's
  copy of the converted API workflow is cached against the **template text**, so an edited file is
  converted again instead of being shadowed by the old copy. A file that is not readable JSON or
  holds none of those keys makes its model unknown to the app (it drops out of the list and the
  generator becomes unavailable) with the reason in the server log — and a broken override of a
  shipped model does NOT fall back to the shipped graph, because the file the user wrote wins.
  A model name is a file stem, so it cannot contain a path separator (`comfyUiWorkflowSet`
  refuses it — a hand-written config must not point the loader at `../config.json`).
  **How many references a generator takes is part of its driver** (`IImageGeneratorDriver.maxRefs`:
  for ComfyUI `comfyUiMaxRefs(set)` — the highest template the file defines; for the SD API `1`,
  because several `init_images` are a batch, not a reference set) and
  `ImageGenerationService.maxReferenceCount()` is the highest count ANY available generator takes —
  which is what the picture planner is asked for and what assembles the final list. Before a job
  starts the service cuts the references to `driver.maxRefs`, so a model with fewer templates uses
  the pictures it can take instead of failing the job (the cast anchors come first, so a cut drops
  scenery before it drops a face, and the ordinals of the binding sentence stay true for what
  survives); the driver keeps its own refusal as the safety net for a workflow file swapped under a
  queued job.
  The driver (`drivers/ComfyUiDriver.ts`):
  `POST /workflow/convert` turns the UI template into the API format (the
  `comfyui-workflow-to-api-converter-endpoint` custom node — a 404 here is reported as the node
  not being installed); `POST /upload/image` (multipart field `image`) uploads the references
  under a `safeName()`; the `PARAM_*` placeholders of the API workflow are then substituted by
  whole-string match (`PARAM_PROMPT`, `PARAM_SEED` — a number in 0..2147483647, `PARAM_DEVICE`,
  `PARAM_INT_OUTPUT_IMAGE_WIDTH`/`_HEIGHT`, `PARAM_STRING_OUTPUT_IMAGE_FILENAME`,
  `PARAM_STRING_INPUT_IMAGE_FILENAME`/`_1`/`_2`); `POST /prompt` starts the job (its `node_errors`
  are reported — "usually a custom node or a model file of the workflow is missing");
  `GET /history/{prompt_id}` is polled every 2 s until the job is done (10 min cap, an error
  carries the server's `status.messages`); `GET /view?filename&subfolder&type=output` downloads the
  picture onto the target file. Cancelling a job aborts the local request AND tells the server to
  drop it (`POST /queue {remove:[prompt_id]}` then `POST /interrupt {prompt_id}`, best-effort).
  **The driver is the only place that knows this dialect**, so the read-only questions the self-test
  asks are methods of it too: `baseUrl`, `systemStats(timeoutMs)`, `objectInfo()`,
  `hasNodeClass(name)` and `convert(template, refCount, signal)` (the converted-workflow cache stays
  its own — keyed by the template text, so a converted copy cannot shadow an edited file). A failed
  connection reports the `cause` code (`ECONNREFUSED`, `ENOTFOUND`, a TLS mismatch) inside its
  message, because that code is the whole diagnostic and `fetch` hides it otherwise.
  `device` is the GPU the workflow's model loaders are pinned to — on a multi-GPU server a
  generator per GPU; the ComfyUI server needs the models of the workflow installed (the
  `picgen-install-comfyui` script of the `d:\MyDocs\AiPic\generators` folder the workflows were
  ported from sets such a server up — it is not part of this app).
- **One model talks, another one looks (`Config.chatModel` / `Config.visionModel`).** The models are
  GLOBAL settings, not fields of a chat: the model that runs the replies is `chatModel` and the one
  that sees is `visionModel`, both written by the header chips (the model chip and the 👁) through
  `PUT /api/config` — a chat carries no pick at all, so switching a model switches it for the whole
  app. `TextGenerationService.resolveVisionModel(config)` is the rule, mirrored on the frontend
  (`ChatStore.visionModel`): the configured vision model wins — even when it cannot see, so the
  banner can say "«x» cannot see pictures" instead of silently using another — else the chat model
  when it `supportsImages`, else the first vision-capable model of the config (a roleplay model with
  no vision still gets its cards described). Nothing configured that can see → the
  `"Describe the picture"` call answers a 400 with that sentence. An empty vision pick is a real
  choice (the field is removed, back to that default), and `ConfigurationService` drops a pick whose
  model is gone on load.
  What uses it: the editor's `POST /api/image/describe`, and the caption of an attached picture —
  `ChatStore.send` calls `POST /api/image/caption` `{ chatId, messageId }` for every 📎 card that
  has no caption (`ReplyService.captionPicture`), which writes the vision model's sentence into the
  picture's row (`description` — what the card shows as its `text`); an empty caption, a config with nothing that can see and a model that
  failed all leave the card as it is (no error banner — an unlabelled picture is a normal state).
  That caption is what a chat model without vision reads about the picture in the history and what
  the 📷 planner reads in its catalogue, so it is not decoration.
- **A separate planner model (`Config.imagePromptModel`).** The model that writes a picture's
  prompt can be different from the one that replies. It is a GLOBAL field (the Settings dialog's
  "Picture prompt model" pick, `settings-prompt-model`), an llmModels key, used ONLY by the
  picture PLANNER — the 📷 "picture of my turn" and the editor's "From the chat" — NOT by
  replies, tunePrompt ("Make it English"), or the vision captions. `TextGenerationService.resolveImagePromptModel`
  (mirrored by `ReplyService.resolveImagePromptModel`) is the rule: the configured key when it names
  an existing model, else the chat model (`chatModel`, else the first). `runUserTurnImage` and
  `planPicturePrompt` resolve
  through it; `ConfigurationService` drops the field on load when it names a model no longer in
  `llmModels`, and the Settings pick writes an empty value as "Default" (the field removed → the
  chat model plans). Replies and picture captions are unaffected — they use `chatModel` and
  `visionModel`.
- **Pictures belong to the user; the model is text-only.** There is no `[IMG:…]` /
  `[PHOTO:…]` protocol and no `accessAllImages` flag anymore: `systemPromptFor` states plainly that
  the character cannot send or create images. A picture enters a chat in exactly three ways, and all
  three of them are user actions:
  - **📎 attach** (`POST /api/chats/:id/messages`, body `{ text, images: [data URLs] }`, backend
    `ReplyService.attachUserImages`): the text becomes a user message and every picture becomes its
    OWN `kind: 'image'` message right after it ("Look at this picture", then a card per picture).
    A picture the user attached is never re-saved by a later step.
  - **🎨 gen mode** (the prompt box, `POST /api/image` with body `{ chatId, prompt, refs }`): one
    image card with the prompt as
    its generation data; the picture itself is what the generator produced.
  - **📷 the picture of the user's turn** (`POST /api/chats/:id/auto-image`, backend
    `ReplyService.requestUserTurnImage`) — see the next bullet.
  A card is shown with its caption (what is on it), the prompt it was drawn from and the number of
  references it used (`image-card` / `card-caption` / `card-prompt` / `card-refs`); a model that
  supports images receives the card as an image part plus a `A picture you are shown, it shows: …`
  text part, and as `[A picture: …]` in the history text of a model without vision.
- **The picture of the user's turn (📷).** The button appears in the input bar when a generator is
  available AND it is the user's turn (the last message is a non-error assistant one —
  `ChatStore.isUserTurn`). One click calls `POST /api/chats/:id/auto-image`, which
  **returns immediately** with the chat containing a placeholder image card (pending,
  `generation.source: 'auto'`) — the rest runs in the background (`runUserTurnImage`) and the client
  polls, so typing and sending are never blocked. The background half asks the model
  (`composeImagePrompt`) for a plan: the input is the whole dialogue as TEXT (who is in it, the
  labeled lines, the **cast** — see the next bullet — and a numbered catalogue of the pictures the
  chat already has, with what each shows, how it got there, who shared it and how long ago), and its
  own placeholder is left out of both; the output is strict JSON
  `{"name","description","prompt","refs","cast","subjects"}` extracted from whatever wrapping the
  model chose (`parseJsonPlan`), with `refs` clamped to the catalogue and `cast`/`subjects` to the
  cast it was given. The placeholder card is then repointed at a file named from the model's 2–5
  English words, the description becomes the card's caption, and the generation runs as the usual
  background job. If the model cannot produce a readable plan the card becomes the broken placeholder
  with the reason and a Regenerate button — it never stays pending.
- **A person is a face and a description, never a name (`ReplyService.pictureMaterial` /
  `finishPlan`).** The generator has never heard of Alice or Carol, so a name in a prompt buys
  nothing and a person the model has to guess gets a new face every time. The cast layer fixes both:
  - **Who is offered:** `pictureMaterial` builds the cast from the chat's characters, its active
    persona and every persona that ever spoke here. Each member carries a **look** — the card's
    `description`, which is where the user writes the appearance ("tall, short red hair, always in a
    green coat") together with the personality, capped at 400 characters by
    `ReplyService.visualLine` so one long card cannot eat the planning prompt — and, as **anchors**,
    up to two of their actual pictures: newest first a card of THIS chat that depicts them, else
    the pictures of `characters/<id>/` and the avatar (the avatar is itself one of
    those pictures, so it leads the list). The planner is told `char:alice — Alice: <look>
    (shown on picture 2)` and answers with the cast ids the picture shows plus the 2–4 word noun
    phrase it used for each (`subjects`). The anchors are what really carries a face; the look line
    is all the generator gets of a person who has no picture anywhere.
  - **What reaches the generator:** `finishPlan` assembles the references itself — the cast anchors
    first (a face beats a place), then the pictures the model picked, deduped and cut to
    `ImageGenerationService.maxReferenceCount()` — appends the binding sentence `Reference images:
    the first reference image shows the woman in the green coat — draw them with exactly the same
    face, hair and outfit; …` and rewrites any name the model still wrote into that noun phrase
    (`describePeople`). The generator therefore sees **no proper names** and always knows what each
    of its input pictures is for; the reference order is what makes "the first reference image" true
    (`ComfyUiDriver` keeps it — `PARAM_STRING_INPUT_IMAGE_FILENAME_1`/`_2`).
  - **What is remembered:** the people on a picture are stored in its row of the
    images table as `depicts: ["char:alice", "user:carol"]` (`ChatsService.setMessageDepicts` /
    `editImageCard`, read back by `applyImageMeta`). That record is what offers the card as the
    person's anchor in the next plan, so the next picture of the same chat draws the same woman
    instead of a stranger.
- **One look per conversation (`Chat.stylePrompt`).** The chat-settings dialog's *Picture style*
  field is appended to every generation prompt of that chat as `Style: …` — the auto plan, a gen-mode
  draw and a regeneration alike (`ReplyService.withChatStyle`, which skips a prompt that already
  carries the style so repeated redraws do not stack it).
- **Every picture is addressed by an ID that is its path relative to the data folder**
  (`PathHelper.imageIdOf` / `resolveImageId`, e.g. `chats/<chatId>/a-sunset-1a2b3c.png`,
  `characters/alice/photo1.jpg`). The same id is the PRIMARY KEY of its row in the images
  table — the table and the file are found by exactly the same string. An id is resolved only when
  it stays inside one of the data folders (`configDir`, `chatsDir`, `charactersDir`, `personsDir`),
  so an id written by hand in a chat or in a stored row can never reach an arbitrary file; an
  unparsable or escaping id resolves to `null` and is rejected with a clear error. This is the
  **storage** rule — what a stored id may point at; serving a file over HTTP is stricter, see the
  next bullet.
  `ChatMessage.images` holds ids, the picture row's `refs` holds ids, the generator receives
  absolute paths resolved by `ImageGenerationService.resolveRefPaths` (references whose file is gone
  are dropped, not passed as junk), and the browser loads a picture through the one
  id-addressed route `GET /api/media?path=<id>` (`ApiService.mediaUrl(id)`). File names are
  human-readable English: `ChatsService.slugify` transliterates Cyrillic, keeps up to five leading
  words and lowercases them, so a saved picture is `a-sunset-over-the-sea-1a2b3c.png`; the 6-hex
  suffix keeps a reserved name unique (`reservedImageId`).
- **The media route serves pictures, not the data folder.** `GET /api/media` resolves the id with
  `PathHelper.resolvePictureId`, which accepts only a file inside one of the folders pictures live in
  (`chatsDir`, `charactersDir`, `personsDir`) and **not** the data root itself, so the route cannot be
  pointed at `config.json` (it can hold a literal provider key), at `comfyui/*.json` (the user's own
  workflow files) or at anything else that shares the data root with them — such an id gives `400
  {"error":"Unknown image path"}`. The second rule is by name: `HttpHelper.sendImage` streams only a
  name whose extension is a picture format (`HttpHelper.isImage` — png / jpg / jpeg / webp / gif / bmp
  / avif), which also covers the files that sit *inside* a picture folder (`chats/chats.db`, a
  `chat.json.migrated`, any leftover JSON) with `404`. This is the one file route the app serves
  pictures through — the chat cards, the character/persona pictures and the avatars all load their
  preview by id from here, so every file response of the app goes through `sendImage`. The storage
  side stays looser on purpose: a reference may name any image of the data folders.
- **What is known about a picture lives in ONE global table, `images.db`** — keyed by the image id,
  holding `{ name, description, depicts, prompt, negativePrompt, refs, source, generator, model,
  width, height, steps, createdAt, updatedAt }` (`shared/ImageMeta.ts` is the row shape,
  `images/ImageMetaService.ts` the store; `depicts` — the cast ids of the people on the picture —
  is content, not generation data, so it is NOT in `IMAGE_GENERATION_KEYS` and survives a
  generation block being dropped). The table is the authority: `ChatsService.get()` fills every
  image card from it on every read, and a message row stores **no copy** of the caption/prompt —
  a card whose picture has no row reads as a picture nobody described. A row is merge-on-write: a
  field given as `undefined` or empty is removed, and a row left saying nothing is deleted.
  `source` says how the picture got there: `upload` / `manual` / `auto`. The old format of this
  data — a `<image>.png.json` sidecar next to each described picture (plus the short
  `<image>.json` alias) — is **not supported and not migrated**: the app neither reads such a file,
  nor merges it into a row, nor falls back to it, nor deletes it. Clearing the leftovers is the
  user's own decision; a picture that only has one simply shows no caption.
  `close()` is final, like the chats database.
- **The table is reconciled with the disk by `PictureLibraryService.sync()`** — at server start
  (`index.ts`, a failing sync is only logged, it never stops the server) and on every browser open
  (`browse()` syncs before reading). The row of every picture on disk carries the **facts of its
  file** — `fileSize`, `fileModifiedAt` (ms) and `fileHash` (sha256 hex, `shared/ImageMeta.ts`) —
  and a file that has no row gets one carrying exactly those facts (the `files/` folders themselves
  stay plain pictures; nothing is written next to a file). A file whose row still vouches for it
  (same size, same modification time) is **not hashed again** — the content read only happens for
  new or changed files. The facts are also what recognises a picture **renamed or moved outside the
  app**: a row whose file is gone and a file with the same size and hash are the same picture — the
  bytes are the identity, so the folder, the file name and even its extension may have changed —
  and the row FOLLOWS the file (`meta.move` + `ChatsService.repointImageIds`, the same trail the
  app's own Rename walks), so the chat cards and the stored reference lists name the new path and
  the picture keeps working. The user may therefore sort the pictures into folders himself. A file
  keeps its path only when the record there already remembers THESE bytes (a copy of the same
  picture); when it carries a record of DIFFERENT bytes, that description is stranded and the two
  records **trade places** (`ImageMetaService.swap`, repointed in one pass — a swap cannot be two
  single repoints): the file keeps the description of what is really in it, the stranded one becomes
  an orphan at the path the file left, and neither is lost. A record without stored facts cannot be
  judged, so it keeps its path. Every writer of a picture — a save, an import, a
  generated picture, a disk pick — records those facts at the moment it writes the file
  (`shared/FileFacts.ts`), so a row is never blind to its own file and the de-dup (`findByHash`)
  sees a fresh picture before anyone opens the browser; the sync keeps the same facts fresh for
  the files the user drops in. A row without a stored hash is never guessed at (it
  stays an orphan), and one file can only carry one row — byte-identical copies leave the others as
  pictures of their own. These fields are row bookkeeping, not generation data: they are NOT in
  `IMAGE_GENERATION_KEYS`, so a "this is just a file" edit keeps them.
- **The picture browser (⋮ → Pictures)** is the chat-independent view and editor of that table:
  `GET /api/pictures` lists every picture of the picture folders with its row (newest file first,
  orphan rows — a row whose file is gone — last, visible so the user can clear them),
  `PATCH /api/pictures` edits the `description` / `prompt` / `refs` of ANY picture (a caption
  written for a character's photo is what a chat card of that photo shows — one source), and
  `POST /api/pictures/rename` renames one. An id is a path, so a rename moves **what is there**:
  a picture with a file moves the file (the row, the cards of every chat and the stored reference
  lists follow through `ChatsService.repointImageId`), while a record whose file is gone moves the
  ROW — and when a file already lives at the new id it attaches to it, its facts are re-read from
  that file, which is how a description comes back to a picture renamed outside the app in a way
  the sync could not recognise (another extension, rewritten bytes, a row without facts). Both
  never create and never destroy: the new folder must already exist (a rename that invented
  `characters/<new-id>/` would make a folder that is not a character — no row names it, nothing reads
  it, and the picture in it belongs to nobody), the
  target must have no file (a rename must never overwrite a picture) and no record (two pictures
  never fuse — `ImageMetaService.move` refuses a target row as the backstop), and a picture that is
  still being generated waits (`ChatsService.hasPendingImage`, the same guard a chat rename
  applies, because a running job writes to the path it was given). A name that is taken, outside
  the picture folders or not a picture format is a 400 with the reason.
  `DELETE /api/pictures` (body `{ id }`) forgets the record of a picture whose file is gone —
  the one delete the browser has; a picture whose file still exists is refused, because the app
  never removes a picture file. The id travels in the body, never in the URL (it is a path).
  Every entry also carries `referencedBy` — how many OTHER pictures name it in the reference set
  of their prompt — and `sameAs` — the other files holding exactly these bytes (same extension,
  size and sha256). Both are **computed on every read, never stored**: a reference is a fact
  about another row and a stored counter would be a second copy that could disagree, and two
  byte-identical files are two pictures (a cloned chat owns its copy, a name is a path), so the
  table does not forbid them — it says they exist, which is what a user needs before deleting one.
  `PictureLibraryService.browse` counts with one pass over the table (`refCounts` over all rows),
  `get` scans once per read; a row naming itself (a hand-edited table) does not count itself.
- **Image generation runs in the BACKGROUND.** Each generation (a gen-mode draw, the picture of the
  user's turn, or a regeneration) is started with the TARGET IMAGE ID already stored in the card with
  `ChatMessage.imageStatus[id] = 'pending'`, the message is saved and returned without waiting, and
  `ImageGenerationService.startImageJob` runs the job (`image_generation/ImageGenerationService.ts`).
  The job writes to a temp file (a dot-file next to the target, so the rename stays atomic) and
  renames it to the reserved id only on success (so a name is never
  left with a partial image), then merges the generation data into the picture's row (a description
  written while the job ran survives); the jobs of one
  server are **queued** (one run at a time — the GPU must not be hit
  concurrently; the queue is the driver's `queueKey`, so two ComfyUI generators of one URL take
  turns) while jobs of different servers run in parallel. The registry is keyed by the
  image id, so a job can outlive its message — and a job whose chat was deleted while it waited in
  the queue is noticed by the `gone` guard its caller (ReplyService, via `ChatsService.exists`)
  hands it: the chat's folder on disk is not the evidence, a database chat owns a folder only once
  it owns a file. When the job
  finishes, `ReplyService` updates the message: ok → the status is cleared (the image is ready);
  failed/cancelled → `imageStatus[id] = 'failed'` + `imageErrors[id]` (the "broken" image),
  UNLESS an older image existed at the name (a cancelled/failed regeneration) — then the old file
  is kept and the image stays ready. The **frontend polls** the chat (`GET /chats/:id`) on a 1.5 s
  interval while any image of the current chat is `pending` (stops when none are), so a generation
  never blocks sending messages. The UI shows a spinner placeholder with a **Cancel** button while
  pending (the label says what the app is doing — "Planning and drawing the picture…" for the 📷
  flow, "Generating the image…" otherwise) and a broken-image placeholder with a **Regenerate**
  button when failed.
  `POST /api/chats/:id/messages/:messageId/cancel-image` (body `{ image }` — an id) cancels the in-flight
  job and marks the image failed. `POST /api/chats/:id/messages/:messageId/regenerate-image`
  (body `{ image, prompt? }`) re-runs the generator in the background against the SAME id (no
  file swap, so no later reference needs repointing), after cancelling any job still running for it.
  `PATCH /api/chats/:id/messages/:messageId/picture` (body `{ description?, prompt?, image?, kind?,
  refs?, depicts? }`)
  is what the picture editor saves — every field is a field of the picture's row: the description
  and the prompt, `image` — an existing picture id of the data folder the card should point at (the
  card's generation data is dropped; a card whose picture is still `pending` refuses the swap), and
  `kind` — `"generated"` (keep/create the generation fields, source `manual` when it had none) or
  `"file"` (drop them from the row, or the prompt would come back on the next read). An empty prompt
  is a real edit — the card then has nothing to redraw from. `refs` — the picture ids the saved
  prompt names in order (each must resolve with `PathHelper.resolveImageId`), because a prompt that
  says "the first reference image shows …" is only true together with its pictures; `depicts` — the
  cast ids of the people on the picture, `[]` being a real edit that clears the note.
  `POST /api/chats/:id/messages/:messageId/replace-image`
  (body `{ image, data }`) repoints the card at a file the user picked — the old picture keeps its
  own file and row (nothing references it anymore) and the card's generation data is dropped,
  because the new file was not generated by the app.
- **The picture editor's LLM helpers** (`/api/image`, all taking `chatId`; the model work is
  `TextGenerationService`, the orchestration `ReplyService`, and all of it uses the chat's sampling):
  (the catalog the "from a file" pick fills is the picture browser's
  `GET /api/pictures` — one list, with the row each picture carries);
  `POST /api/image/prompt` `{ chatId, messageId? }` → `{ prompt, description, refs }`, the finished
  plan of the card from the dialogue (`composeImagePrompt` on the whole dialogue, cast and picture
  catalogue, the card itself left out; `ReplyService.planPicturePrompt` returns the prompt WITH the
  reference binding already appended and the references assembled — the two are one thing, so they
  come back together; 502 when the model gives nothing readable); `POST /api/image/tune-prompt`
  `{ chatId, prompt }` → `{ prompt }`, the typed prompt translated to English and shaped for the
  generator (`tunePrompt` — not a literal translation, unlike `translatePrompt`); and
  `POST /api/image/describe` `{ chatId, image? | data? }` → `{ description }`, one English sentence
  about a picture (`describePicture`), which needs a model with vision (400 otherwise).
- **Generation prompts are always English.** Manually typed prompts (gen mode) and stored non-English
  prompts (regeneration) are translated to English via the chat's model (`translatePrompt` in
  `TextGenerationService`, called by `ImageGenerationService.ensureEnglishPrompt`) before hitting the
  generator; on translation failure the original text is used. The 📷 planning call asks for English
  outright, so it needs no translation.
  The final prompt lives in the picture's row (which is what the card shows as
  `generation.prompt`), so the caption line and the hover hint show it.
- **Characters are NOT in the config.** Each character is a row of the `characters` table of
  `~/.config/sillytalk/catalogs.db` (`node:sqlite`, `catalogsDatabaseFile()`): the id is the primary
  key and at the same time the name of the character's picture folder
  `~/.config/sillytalk/characters/<id>/`, the row carries `{ name, description, avatar }` — the
  **one**
  description is the whole card, the appearance included
  (English, since the picture planner reads the visual line out of it for every prompt that shows
  her; a card has no appearance field of its own).
  The character's pictures are ordinary image files sitting **directly in** that folder (no
  `photos/` subfolder) — they are the "starter" set the planner offers as look references
  (`pictureIdsOf(id)` lists them). The **avatar** is one of those pictures: the row's `avatar`
  column holds the data-root-relative id of the file used as the avatar (NULL when there is none),
  and the preview is served by the one `/api/media?path=<id>` route — there is no `avatar.jpg`
  file and no avatar GET route any more. Picking an avatar (`setAvatarImage`) takes a disk file
  (a data URL) or an existing picture id; a disk file whose bytes match a picture already in the
  data folders (the image-metadata `findByHash` size+sha256 check) is **reused rather than
  copied**, so the row points at the file the user already has. `clearAvatar` NULLs the column
  and keeps the file.
  The pictures and the avatar are addressed by
  an image id (`characters/alice/photo1.jpg`) like any other — there is no separate reference
  machinery for them and no "access to all images" flag (the characters do not attach pictures at
  all). They ARE, however, what the picture planner offers as a person's **look references** (see the
  cast bullet above).
  CRUD lives in `characters/CharactersService.ts`; the routes edit **one card at a time** —
  `PUT /api/characters/:id` creates or updates it, `DELETE /api/characters/:id` removes the row and
  the character's folder (its pictures), and there is no list-wide PUT: a client can only change the
  card it names, and the app never sweeps a folder it does not own (a `characters/<id>/` folder
  nothing names is the user's pictures, not a character — and saving a card under that id adopts the
  folder, so a hand-made folder of photos becomes a character's starter set). The old
  `character.json` files are **not supported and not read** — a leftover file is just a file, the
  card is the row (the existing files were converted into rows once by a throwaway script, and the
  user deletes them by hand). An on-disk `characters` field in an old config.json is migrated to
  rows at startup (`index.ts`) and stripped by `PUT /api/config` — do not reintroduce a
  `characters` array in the config.
- **Users are NOT in the config either.** Each person (persona card) is a row of the `persons` table
  of the same `catalogs.db` (the row carries `{ name, description, avatar }` — the description
  is the whole card, the appearance included, exactly as for a character); the id is the primary key
  and the name of the folder `~/.config/sillytalk/users/<id>/` whose pictures sit directly in it;
  the **avatar** is one of those pictures, named by the row's `avatar` column (the data-root-relative
  id, or NULL) and served by the `/api/media` route — there is no `avatar.jpg` file (persona avatar,
  shown next to user messages — the persona appears in the picture cast of the chat
  too, so a persona whose card says nothing visual and whose avatar is missing is the one case the
  model has to invent a face from). The old `user.json` files are **not supported and not read**
  (converted into rows once by a throwaway script, deleted by the user by hand). CRUD lives in
  `persons/PersonsService.ts` (the
  domain concept in the code is `person`/`persons`, type `Person`); `PUT /api/persons/:id` and
  `DELETE /api/persons/:id` mirror the
  character endpoints — the `users` JSON body/response fields, the `userId` fields and the on-disk
  picture layout (`users/`) stay "user"-named. There is **no selected/current user** in the
  config anymore: each chat stores the **active** persona (whose name new messages are sent under) in
  `Chat.userId`, chosen when creating a new chat (dialog) or via the header menu. On a fresh install
  the default person is created with id `default` (previously `me`). The active persona's
  `description` (when non-empty) is appended to the system prompt by
  `systemPromptFor(character, person, …)` so the model knows who it is talking to. A chat also
  carries its own `sampling` overrides and a `systemSuffix` — see "Per-chat settings" below.
- **An ID is a folder name, and it is the user's to choose.** The ID of a character or a persona is
  the primary key of its catalogs row and the name of its picture folder (`characters/<id>/`,
  `users/<id>/`) at once, so it is not a label the app slaps on
  something — it is written into the chats (`Chat.characterIds`, `Chat.userId`, the `characterId` /
  `userId` of every stored line), into the picture ids of that folder (`characters/<id>/*.png` —
  the primary keys of the images table and the ids the cards point at), into the row's own `avatar`
  column (the avatar id starts with the folder name, so a rename repoints it too) and into the
  picture rows' `depicts` (the cast refs `char:<id>` / `user:<id>`). Both entity dialogs therefore
  carry an **ID field**: when creating, the user writes the ID (the field suggests one from the name —
  `helpers.suggestEntityId` — until he touches it; an empty field falls back to the generated
  `c<timestamp>` / `u<timestamp>`), and afterwards the ID changes only through the field's own
  **Rename** button, disabled until it says another name (the same shape as the picture browser's
  rename; Save alone never moves a row or a folder). The rename is `POST /api/characters/:id/rename` /
  `POST /api/persons/:id/rename` (`{ newId }`; the response is the clone's — `{ id, characters }` /
  `{ id, users }`, and the dialog re-opens on the new ID via `openCharacterDialog(newId)`).
  `CharactersService.rename` / `PersonsService.rename` move the row and its folder together and
  refuse a name
  that is taken — by a row or by a folder still standing there (`isValidId` = letters, digits, `.`,
  `-`, `_`, no leading dot, ≤ 100 chars — mirrored
  in `helpers.isEntityId`); **`entities/EntityIdService.ts`** is the piece that walks the trail above
  (`renameCharacter` / `renamePerson`: the cards and reference lists through
  `ChatsService.repointImageId`, the rows through `ImageMetaService.move`, the chats through the new
  `ChatsService.repointAuthor`, the cast through `ImageMetaService.repointDepicts` and the entity's
  own avatar id through the catalog's `repointAvatar`) — it sits above
  both catalogs, the chat store and the table for the same reason the picture browser does: a rename
  is nothing one row or one folder can do on its own. Renaming is per kind, so a character and a
  persona that
  happen to share an ID are two entities and one rename leaves the other alone. After a rename the
  dialog re-reads the open chat (`ChatStore.refreshCurrentChat()`) and the chat list, because the
  server has just rewritten that chat's participant list and message authors.
- **A chat ID follows the same rule.** It is the primary key of the chat's rows
  AND the name of its folder `chats/<id>/`, and it prefixes every picture id of
  the chat (`chats/<id>/…`). A new chat is therefore named by its
  **creation moment** — `yyyy-mm-dd_hh-mm-ss` local time, a `-2`/`-3` suffix
  keeping it unique inside one second (`ChatsService.newChatId`; the clone takes
  the same shape) — a name that reads in a chat list, a picture id and a folder
  listing, where a UUID said nothing. The chat settings dialog carries an **ID
  field with its own Rename** button exactly like the entity dialogs (disabled
  until it says another folder name, `helpers.isEntityId` on the frontend and
  `ChatsService.isValidId` on the server, Save alone never renames). The rename
  is `POST /api/chats/:id/rename` (`{ newId }` → `{ id, chat }`) and lives in
  `ChatsService.rename` itself — every piece it drags along belongs to the chat
  domain, so no EntityIdService-like piece above it is needed: the folder
  moves, the `chats` row is re-keyed (its blob carries the id) and the
  `messages` `chat_id` follows, then every picture id under `chats/<old>/` is
  repointed — the cards and status maps through `repointImageId`, the
  `images.db` rows through `ImageMetaService.move`, orphan rows included. It
  refuses a malformed ID, a name that is taken (by a row or by a folder still
  standing there) and a chat with a **pending picture** — a running job writes
  to the old ids, the same guard the card swap applies. On the frontend
  `ChatStore.renameChat(newId)` applies the renamed chat the server answers
  with and re-reads the chat list; the dialog stays open on the new name (the
  other fields of the dialog are untouched by a move).
- **Multi-participant chats.** `Chat.characterIds` is the ordered participant list (order =
  answer priority). Every `ChatMessage` carries its author — `characterId` (assistant) /
  `userId` (user) — stored at send time, so switching participants or the active persona never
  rewrites history; the personas that ever spoke in a chat are derived from the messages'
  `userId` values on the fly (there is no stored `Chat.userIds`). Toggling a character out of a
  chat is a **reply-queue** decision only: the author of a message is resolved for the display
  (`ChatStore.characterOf` / `characterNameOf` → the name + avatar in `message-row`) and for the
  labeled history (`appendAssistantReply` builds its author map from the message authors, not from
  `chat.characterIds`) through the WHOLE catalog, so a former participant keeps its name and avatar
  on the lines it already said. `ChatStore.chatCharacters()` stays participant-scoped — it drives
  the header label, the mention match and the reply order. `POST /api/chats/:id/messages`
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
- **Avatars.** An avatar is a normal picture of the entity's folder, designated by the data-root-
  relative id stored in the row's `avatar` column — there is no fixed `avatar.<ext>` file and no
  GET avatar route; the preview is served by the one `GET /api/media?path=<id>` route.
  `POST /api/persons/:id/avatar` / `POST /api/characters/:id/avatar` set it from a disk file
  (`{ data }`, a data URL — a byte-identical picture already in the data folders is reused, not
  copied) or from an existing picture (`{ image }`, an id); the answer is the avatar's id, which the
  dialog mirrors into its local row. `DELETE …/:id/avatar` NULLs the column and keeps the file.
  List endpoints return the `avatar` id (or null) on each row — `listWithPhotos` / `listWithAvatars`;
  the UI shows the image only when the id is non-null.

## Command line (`backend/src/cli.ts`)

The CLI is the thin layer of the terminal, the way `<domain>.routes.ts` is the thin layer of HTTP:
`parseArgs` turns the command line into typed options (or a message), `run` hands them to a domain
service and prints what comes back, `main` exits with the code. No container, no state, and a command
that needs the databases resolves them here — the one place allowed to.

- **The bin dispatch is the contract** (see CI / npm publish): no argument = the server, any argument
  = the CLI. A new command therefore goes into `cli.ts`, never into `index.ts`.
- **`test-comfyui <url>`** drives `image_generation/comfyui/ComfyUiSelfTestService.ts` and is the
  supported way to find out why a ComfyUI server draws nothing. Its invariants:
  - **Nothing of the user's config is read or written.** The URL, the size and the GPU are arguments
    (defaults 1024x1024 / `cuda:0`), so it can test a server the user has not configured yet — and
    `ConfigurationService.loadConfig` is never called, because it WRITES a config file when there is
    none and a diagnostic does not create state. The only writes are the test pictures and the two
    reference pictures, under `--out` / `<data root>/comfyui-test/`.
  - **The five steps run cheapest first and each one is printed**: server → workflow files → converter
    → nodes and model files → one real job per template. Everything before the GPU is free, so a
    broken workflow file or a missing converter node is said before a minute of drawing is spent;
    a missing converter stops the run (nothing can be drawn without it), a missing `/object_info`
    does not (the run says what it skipped and draws anyway).
  - **Node/model findings are warnings, the draw is the verdict.** A class the listing lacks is
    confirmed through `GET /object_info/<name>` first (a lazily loaded node must not be called
    missing) and a `PARAM_*` value is never compared with a list of the server's files (the value it
    stands for exists only at run time) — a false alarm in a diagnostic costs more than the request
    it saves.
  - **The drawn file is read back** (format + pixel size from its own header): a workflow that
    ignores `PARAM_INT_OUTPUT_IMAGE_*` and a server that answers a download with an error page both
    look like success until the file is opened.
  - **A server that dies mid-run is one event, not N failures.** A ComfyUI whose GPU code aborts
    takes the whole process with it (core dumped), so the client sees `ECONNRESET` and then
    `ECONNREFUSED`; the run marks the server as lost, names the cause once (with the journalctl hint)
    and reports the templates it never reached as SKIPPED — they are not evidence about those
    workflows. The same reading ends a converter step that stops answering.
  - **`/system_stats` is read twice.** A real 0.44/ROCm server answers it WITHOUT a device list before
    its first job and draws on its GPU right after it, so an empty device list before the draws is
    printed as a neutral note, never as a problem; after a job the same field is read again (that is
    where the GPU and its free VRAM can be named), and a low free VRAM in the FIRST reading — the
    state a new job would start from — is a warning.
  - **Every failure line carries its own hint** (the converter custom node, a model file of the
    workflow, an out-of-memory GPU, a job still queued, a server bound to 127.0.0.1 without
    `--listen`). Exit codes: `0` clean, `1` something failed or needs a look, `2` a bad command line.
  - **Ctrl+C cancels through the service** (`cancel()` → the driver aborts and tells the server to
    drop the job); the second one ends the process. The SIGINT listener is removed when the command
    returns, so a long-lived process does not accumulate them.

## Product / UI behavior (invariants to preserve)

- Black background; a single centered chat column (max-width ~820px).
- Header row: participant names joined by ", " (opens the **participants menu**: toggle characters
  in/out of the chat, ↑/↓ reorder = answer priority, a ✎ **edit icon** per item and a
  "+ New character" button), active persona (opens the persona menu — click switches the active
  persona, ✎ edit icon per item, "+ New persona"), model chip (opens the **model menu** — the model
  pick, ✎ edit icon per item, "+ New model"; the chip is the ONLY model picker — the "⋮" menu has no
  model submenu), then the **vision chip** — a small round 👁 right of the model chip (opens the
  **vision menu**: a "Default" row plus every llm model, each marked `(👁)` when it can see, ✎ per
  row; single-select — the active row is highlighted). Both chips write the **global** pick
  (`PUT /api/config` with `chatModel` / `visionModel`) — the models are settings of the whole app,
  not of a chat, so a pick lives across chats and survives switching. The vision chip carries no
  name of its own: the
  model that will really look is its hover hint (`ChatStore.visionModelTitle`, e.g. "Pictures are
  described by: qwen-vl"; a pick that cannot see says so, and the chip is dimmed —
  `.vision-chip.missing`). The **chat title** label (the chat's own `name`, or the date it was created while
  it has no name — `ChatStore.chatTitle` / `helpers.chatTitleOf`; clickable — opens the **chat menu**:
  new chat + the chat list; wider than the usual dropdown, centered under the label, always visible;
  a long name gets an ellipsis) with a
  **chat-actions ⋮ right next to it in the same cell** ("Chat settings…", "Clone chat" and
  "Delete chat" — the chat
  management moved out of the label's own menu), and a "⋮" menu (settings only now).
  Opening any one of these menus closes the others —
  they must never overlap. The persona/model menus are single-select (the active row is highlighted,
  no ●/○ mark); the character menu keeps the ●/○ mark (membership is a multi-select toggle) and its
  rows are ordered by reply priority, so the ↑/↓ arrows reorder the menu itself.
- **The chat's name and cloning it.** `Chat.name` is the user's own title (`ChatSettingsDialog`'s
  "Name" field, saved with `PATCH /api/chats/:id`; an empty name is stored as no name) and
  `Chat.createdAt` is the creation date written once by `ChatsService.create` — the **default title**
  of a nameless chat (`normalize` gives a row without one the date of its first message, or the
  moment it is first read when it is empty, and `list()` carries both fields). The header shows the
  name, falling back to that date. The chat list in the chat menu shows the SAME title per row
  (`.chat-item-title`) with the message count under it; who is in the chat and its last-message date
  moved to the row's hover hint — `helpers.chatHintOf(characters, users, cs)` →
  `"<characters> / <persona> · <last message date>"` (the date is dropped for an empty chat), bound
  as the row's `title` attribute. "Clone chat" (the chat-actions ⋮) calls
  `POST /api/chats/:id/clone` → `{ chat }` (`ChatsService.clone`): a new id, a copy of every message,
  the participants / persona / model / sampling / systemSuffix, the name suffixed " (copy)" (a
  nameless copy stays nameless), and the chat `files/` folder copied into the copy's folder with
  every image id repointed — in the cards, in their `generation.refs` and with a picture row of its
  own per copied file — so the
  two chats are independent and deleting either leaves the other intact. A card whose picture was
  still "pending" becomes **failed** in the copy with its own reason (the job belongs to the source
  chat, and a pending card in the copy would poll forever). The frontend opens the copy and refreshes
  the chat list (`ChatStore.cloneCurrentChat`).
- **Per-chat settings** (the chat-actions ⋮ → "Chat settings…", `chat-settings-dialog`): the chat's
  **name** plus the
  sampling overrides of THIS chat — temperature / min-P / repetition penalty — plus a free-text
  **system-prompt addition** plus the chat's **picture style** (one look for every picture of the
  conversation, `chat-style-input`). An empty sampling field means "do not override" (the provider default); all
  three sampling fields empty clear the whole block server-side. Stored on the chat as
  `Chat.sampling = { temperature?, minP?, repetitionPenalty? }`, `Chat.systemSuffix`,
  `Chat.stylePrompt` and
  `Chat.name`, saved with
  `PATCH /api/chats/:id` (the only place they are set — `POST /api/chats` takes just the
  participants and the persona; the models are not a field of a chat at all). `ReplyService.appendAssistantReply`
  appends `systemSuffix` to the system prompt of every reply in the chat, and `sampling` goes into
  every model call of the chat — the replies and the 📷 picture-planning call alike — as
  `temperature` / `min_p` / `repetition_penalty`, each sent only when it is set (`requestCompletion`
  in `TextGenerationService`).
- **Entity edit dialogs** (character-dialog / user-dialog / model-dialog): one per item, opened from
  the ✎ icons / "+ New" buttons above. They carry **Save/Cancel**, **Delete** (a confirm; only in
  edit mode) and **Clone** (only in edit mode). Models are saved through the config (a rename
  re-keys the llmModels entry); characters/personas one card at a time (`PUT …/:id`). Character/persona
  clone — `POST /api/characters/:id/clone` / `POST /api/persons/:id/clone` (the folder is copied:
  photos and avatar go along, the name gets a " (copy)" suffix); the response is
  `{ id, characters|users }` with the NEW id, and the dialog does NOT close — it switches to the
  copy's edit form (the `app.ts` modal blocks wrap the dialog in a single-item `@for ... track
  item-id`, so the dialog component is recreated and re-initializes when the item changes).
  Model clone — a duplicate entry under a free "<name> copy" key (the dialog still closes). The
  settings dialog does NOT manage them — it keeps the
  listen address, the global picture-prompt model pick and the image generators (with a hint
  pointing at the header menus): "+ ComfyUI"
  adds a `{ kind: 'comfyui' }` entry (URL + the model **pick** + the GPU device + width/height — the
  pick is fed by `GET /api/image/status`'s `comfyUiModels` rather than a hardcoded frontend list, and
  the hint under it names the converter node the server needs) and "+ SD API" the SD fields; the row
  header shows the kind (`ComfyUI — <model>` / `SD API`). The model pick marks the current option
  with `[selected]` on the `<option>` — `[value]` on the `<select>` would be set before the `@for`
  options exist and silently fail (the same gotcha as the reasoning pick in the model dialog).
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
- **A picture is a message of its own** (`kind: 'image'` — an image CARD, `image-card`), never an
  attachment glued to a text bubble: attaching a picture with a caption produces the caption message
  followed by one card per picture. A card is stretched to the full chat width — its bubble grows to
  the row width via the `has-images` class — and capped at two thirds of the viewport height
  (`width:100%; max-height:2/3vh; object-fit:contain`); when the height cap kicks in and the image
  ends up narrower than the row, `object-fit:contain` centers it. Everything is block-level and in
  order: the picture, then its caption (`card-caption`), then the prompt it was drawn from
  (`card-prompt`) and how many references it used (`card-refs`) — the text of a message is above and
  below the images, never beside.
- **The picture editor is the ONE place a card is edited** (the ✎ of the card opens the
  `picture-dialog`; the bottom input's edit mode is for text messages only). A card is one of two
  things, and the dialog's kind says which: **generated** — a prompt (with "From the chat", which
  plans it from the dialogue via the model, and "Make it English", which translates + shapes the
  typed text for the generator) — or **from a file** — the picture's id, picked from the catalog of
  the data folder (`GET /api/pictures`, the same list the picture browser shows) or from disk. Both carry a **description** (with
  "Describe the picture", a vision call) and the **"who is on this picture"** chips
  (`picture-depicts`, the chat's characters and every persona that ever spoke here; the note the next
  plan reads to draw the same person again). A generated card also shows the **reference set** its
  prompt names, in order (`.refs` / `.ref-thumb`) — "From the chat" fills the prompt and those
  pictures together and Save writes both, because a prompt that says "the first reference image
  shows the woman in the green coat" is only true with its pictures. Save sends only the fields the
  dialog actually changed: an untouched card keeps its `refs` and `depicts` (`sameList` compares
  against what the card said on open — and an empty list IS a change, so clearing works).
  Save only edits what the card says and which file it
  points at — it never draws: redrawing stays the card's ↻ (shown only when there is a prompt). The
  dialog is destroyed/re-initialized per card, so it always reads the card from the store, and it
  closes itself when the card is gone.
- **A character/persona card has no appearance field.** The dialogs carry name, description, the
  avatar and Delete/Clone only — the description is the single text the picture planner reads for the
  look (see the cast bullet), so a user who wants the same face in every picture writes it into the
  description, in English. The hint under the field says why: the generator has never heard the name,
  it draws this text and the reference pictures.
- **The picture browser (the ⋮ menu → "Pictures")** is the chat-independent view of every picture of
  the data folder (`PictureLibraryStore` + `picture-library` component, a wide two-pane modal). The
  left pane is a filterable thumbnail list of all pictures (`GET /api/pictures`, newest file first; a
  row shows the file name, the description, the **"N refs" badge** when the picture is named by
  other pictures as their reference (`referencedBy`, the server's number — no badge for zero, so the
  common case stays clean), and — under them — the **id** of the picture, and a row
  whose file is gone shows a ✕ and is dimmed, not hidden: it is a record the user can still clear).
  Beside the filter sits a **sort pick** (`picture-sort`): "Newest first" keeps the server order
  (orphan row last, where the server put it), "By ID" sorts the whole list alphabetically by the
  path — finding "that one boat picture of the harbour chat" by reading is an alphabetical job, and
  there the orphan rows sort with the rest, because the reader cannot know a row lost its file.
  The id line shows the **whole path** in full (`.lib-id`, wrapping onto more lines when the column
  is narrower than the path — `overflow-wrap: anywhere`, because a long path has no word to break
  on): the id is where the file lives, what the ID field edits and what the filter matches, so the
  row hides none of it; the row's hover hint repeats it. This is why the window and the side column
  are wide (`.modal-library` 1180px, `.lib-side` 360px). The **filter** is an AND over its
  space-separated words — every word has to be found in the picture's id or in its description, so
  "alice sunset" keeps the pictures of alice that say sunset and not the union of the two words
  (matching the id too is what makes "chats", a chat id or a file-name part a filter word);
  `picture-empty` is the "nothing matched" state. The right pane edits the SELECTED picture's row:
  its **description** and **prompt**
  (Save
  writes them to the images table, which is the SAME row every chat card of that picture reads — so a
  caption written here is what the chat shows, and the current chat is re-read after the save), the
  **reference list** the prompt names (added from the catalog, minus the picture itself and minus any
  row whose file is gone), and its **ID** with a separate **Rename** action sitting right of the ID
  field (`.id-row`), not at the bottom of the dialog — a rename is the field's own action. The
  description has its own **"Describe the picture"** (`picture-describe` — the same call and the same
  button the card editor has): the model that looks is the OPEN CHAT's vision model, so with no chat
  at all the button is disabled, and the answer only fills the form (Save is still the write).
  For a picture the app drew **automatically** (the 📷 turn picture, `source: 'auto'`) the prompt and
  the reference list are NOT shown: both are the planner's, and they are edited where the card is
  (`picture-dialog`); a draw the user asked for (🎨, `manual`) keeps its prompt here, because that
  text is theirs. Under the
  field the hint line states **"Used as a reference by N other picture(s)"** (`picture-used-by`,
  the same `referencedBy` number as the row badge) — it is what tells the user whether a rename has
  followers. Renaming is not a label:
  an id is a path, so it moves the file and the server repoints every chat card and stored reference
  list at the new path; a name that is taken or points outside the picture folders comes back as a
  visible error (the banner) and changes nothing. The field works on a row whose file is gone too:
  then it moves only the record, and pointing it at a file that is already there attaches the
  description to that picture — which is what the hint under the field says, together with the
  **Forget record** button (`picture-forget`, shown only for such a row: the one delete the browser
  has, and the only one that cannot lose a picture file — it confirms with the same two-click armed
  state as the message deletes, because dropping a description is irreversible). A row whose bytes live at another path as
  well carries a **"N copies"** badge (`sameAs`, with the other ids in its hover hint) — the table
  keeps byte-identical files as separate pictures, so the browser names them instead of letting the
  user find out by accident. This dialog edits the picture, not a message — the
  card's own ✎ (`picture-dialog`) is for pointing a card at a file/attaching; this one is for the
  words and the name, for a picture that may belong to no chat at all (a character's photo).
- **📷 is a turn affordance, not a generator switch.** It shows only when a generator is available
  AND the last message is a plain assistant answer (`ChatStore.isUserTurn`), so it never competes
  with the 🎨 prompt box, the edit mode, or a turn that already has the user's message in it. One
  click adds the placeholder card and the button steps back (the card is the user's message now, so
  it is the characters' turn); the planning and the drawing happen behind the placeholder.
- Responsive for both desktop and phone. The header is the tight spot (names + date + model + 👁 +
  two ⋮) and its narrow-screen rules in `top-bar.scss` are a measured budget, not a guess: the names
  keep 44px each (`.name-wrap` must not shrink below its name, or the two names paint over each
  other), the chat-date label and the model chip ellipsize to 18vw, the 👁 is 24px, the ⋮ buttons
  drop to 22px/5px padding and the side padding is 10px — that is what makes the row fit a 390px
  phone. Adding another header control means measuring again (a headless Chromium + getBoundingClientRect
  of the zones); the e2e UX 15 test fails loudly if the names stop being clickable.

## Architecture notes

- **DI is a minimal hand-rolled container** (`backend/src/di.ts`, no framework): typed tokens
  (`createToken<T>()`) registered as lazy singletons. The composition root is `index.ts` — it
  registers `DI_CONFIGURATION_SERVICE`,
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
  - **Dependencies are injected through the constructor**
    (`TextGenerationService`, `ConfigurationService`);
    the class is registered in the container under a token defined next to it
    (`DI_IMAGE_GENERATION_SERVICE`)
    and resolved once at the composition root. Tests instantiate the class directly
    (`new ImageGenerationService(...)`) instead of resetting module state.
  - **The service stays persistence- and HTTP-agnostic.** It speaks in ids and primitives
    (the target image id, the prompt, the reference ids), returns results the caller applies
    (`ImageJob.result`),
    and never imports express. `ReplyService` is the exception that proves the rule: it is a
    TOP-LEVEL service that sits above the domain services and orchestrates across them
    (it saves through `ChatsService` and returns the saved chat / the message / a typed
    failure for the route to apply). The pure persistence pieces live in the domain they
    belong to (`ChatsService.setMessageImageStatus`, `ChatsService.normalizeImages`); the
    "a job finished → update the message" orchestration (`startChatImageJob`) is a private
    method of `ReplyService`; file serving (`HttpHelper.sendImage`) stays a routes-layer
    concern, not a domain's.
  - **Keep the dependency graph one-way and acyclic** (`routes → reply → the domain
    services → drivers/configuration/...`): the service may call lower-level services
    and module functions (e.g. `ImageGenerationService` calling
    `TextGenerationService.translatePrompt`;
    `ReplyService` calling all six domain services), but nothing below it may import the
    domain back — that is why the reply orchestration could NOT go into
    `ChatsService` (which the reply pipeline depends on) and got its own
    `reply/` domain, and why the picture of the user's turn lives in `reply/`
    (`requestUserTurnImage` — it needs the chat store, the model and the generator at once)
    while the picture STORAGE (`ChatsService.addImageMessage`, the images-table
    fill on read)
    and the picture PLANNING (`TextGenerationService.composeImagePrompt`) sit in their own
    domains. The images metadata got its own `images/` domain for the same reason:
    `ImageMetaService` is plain storage below the chat store (both `ChatsService`
    and `ImageGenerationService` depend on it, it depends on neither), while the
    chat-aware half — the browser that renames a file and repoints every chat's
    cards at it — is `PictureLibraryService`, which sits above both (it needs
    `ChatsService.repointImageId`). When pulling code into the service, grep the rest of the project for
    logic that belongs to the domain and move what fits (`ensureEnglishPrompt`,
    `appendAssistantReply`, the in-flight reply
    registry moved from `routes.ts`); leave HTTP concerns (validation, status codes, file
    streaming) in the route files, and be able to say why.
  - **A generation backend goes behind the driver interface**
    (`IImageGeneratorDriver.ts` + `drivers/ComfyUiDriver.ts` / `drivers/SdApiDriver.ts`, chosen by
    `DriverFactory` on the config entry's `kind`): the driver speaks the generator's own protocol
    (ComfyUI's convert/upload/prompt/history/view over HTTP, the SD API's txt2img/img2img), fills
    `key` + `queueKey` and writes the picture to the `outPath` it is handed — the service above it
    knows neither protocols nor URLs. A new backend is a new driver + a new `kind`, not a branch in
    `ImageGenerationService`. There is no OS-specific code left in the app (the former `machine/`
    domain that launched external programs is gone with them), so nothing branches on
    `process.platform`.
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
    (`pendingImages`), `isUserTurn` (the last message is a plain assistant answer — the only moment
    the 📷 button belongs), edit, chat mgmt, new-chat dialog. Injects `ConfigStore` + `UiStore`.
    Editing a message never re-attaches its picture: `startEdit` clears `pendingImages` and
    `saveEdit` patches the text only (a card's ✎ does not go through `startEdit` at all — it opens
    the picture editor, whose Save is `ImageStore.savePictureEdit`).
  - `ImageStore` — the image-GENERATION domain: `genMode`/`genRefs`/`generating`, `draw()`,
    `requestTurnImage()` (the 📷 picture of the user's turn — it only fires the request and applies
    the chat with the placeholder card; the background job and the polling do the rest),
    `cancelImage`/`regenerateImage`, the picture editor (`pictureEdit` — the card it edits, opened by
    a row; `savePictureEdit` — the one Save of the dialog: the description, the prompt, the kind and
    the picture the card points at, a disk pick going through `replaceImage` first), the `lightbox`,
    and the background-job polling (re-reads the chat on a
    1.5 s interval while any image is "pending"). The editor closes itself when its card is gone
    (chat switched or message deleted). Injects `ChatStore` (one-way) + `ConfigStore`
    + `UiStore`. It reads the current chat / character / edit target and applies the server chat
    back through `ChatStore.applyChat()`. The "what to send" decision (edit → `saveEdit`,
    gen-mode → `draw`, else → `send`) is orchestrated by `InputPanel`, which is what keeps the
    graph acyclic — `ChatStore` never reads `ImageStore` (the 📷 button lives in `InputPanel` too and
    asks `ChatStore.isUserTurn()` and `ImageStore.canGen()` there). The picture editor's own LLM
    buttons call `ApiService` directly (`composePicturePrompt` / `tunePicturePrompt` /
    `describePicture`) — they only fill the dialog's fields, so they belong to the component.
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
  - Operational/network failure (e.g. "Image generation is not configured", an unknown chat id,
    a rejected request body) → non-2xx →
    the root `error` signal → a dismissable red banner above the input.
  - A picture that did not happen (the plan could not be read, the generator failed or was
    cancelled) is NOT an error banner and never an error message: the card itself becomes the broken
    placeholder with the reason (`imageErrors[id]`, `img-error-text`) and a Regenerate button,
    because the failure belongs to that one picture, not to the conversation.

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
  streaming approach for chat files, character photos and avatars. It also answers `404` for a name
  whose extension is not a picture format (`HttpHelper.isImage`) — the guard every file response of the
  app passes, so no picture route can hand out the JSON that sits next to the pictures; a new file
  route must resolve its path the same way the media route does (`PathHelper.resolvePictureId`) rather
  than joining a user-supplied name onto a folder.
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
- **Runtime assets next to the compiled code.** `tsc` compiles TypeScript and copies nothing, so the
  ComfyUI workflow JSON files reach `dist` through `backend/scripts/copy-workflows.cjs`, which the
  backend `build` script runs after `tsc` (and `scripts/package-npm.mjs` then packs with
  `backend/dist`). A new folder of files the app reads at runtime needs a step like it, or a
  production run finds the folder missing while tests — which read the source tree — stay green.

## E2E

- Playwright, single Chromium project, `workers: 1`, `retries: 1`, `baseURL http://localhost:3211`.
- **Isolated data**: the `webServer` in `playwright.config.ts` starts its own backend on
  `127.0.0.1:3211` with `SILLYTALK_DATA_DIR=e2e/test-data` (gitignored) — the real
  `~/.config/sillytalk` is never touched, no manual backup/restore needed. The backend must be
  built (`npm run build` in `backend/`) before the run.
- **A run rewrites the tracked screenshots in `e2e/screenshots/`, and most of that rewriting is
  noise** — `scripts/discard-unchanged-screenshots.mjs` (`npm run shots:clean`, and the tail of
  `npm run test:e2e`) decides which of them really changed by DECODING the pixels (its own PNG
  reader over `node:zlib`) and comparing them with HEAD, then restores the unchanged ones with
  `git checkout HEAD --`, the index included, because the noise is usually staged by an earlier
  "add everything". Measured on this suite: two runs of one build differ by 0.015% (a caret) to
  0.08% (a text-heavy screen), a real UI change starts near 2%, so `--max-diff` defaults to 0.2 —
  above the noise, below a change. A baseline committed by another Chromium sits ~1% away from
  every screenshot (glyph antialiasing), which is when the threshold has to be raised once and the
  difference pictures reviewed. Those pictures (changed pixels painted magenta over the dimmed new
  shot, for every file that differs at all — restored ones too) go to `.qwen/tmp/shot-diffs/`;
  `--dry-run` reports without touching anything, `--strict` fails on a PNG this reader cannot
  decode. The three screenshots of the picture browser taken by UX 20 (ux-20b / ux-20c / ux-20d) can
  never be stable: the list shows
  generated file names with a random suffix.
- Uses **mocked model + image generation** — both suites share `e2e/helpers/mocks.ts`:
  a deterministic OpenAI-compatible LLM (the delay before answering is controllable at
  runtime via `MockLlm.setDelay`) and a **mock ComfyUI server** (`startMockComfy(model?, size?)` —
  an in-process HTTP server speaking the part of the ComfyUI API the app drives:
  `/system_stats`, `/workflow/convert` (it answers its own tiny workflow whose `PARAM_*` placeholders
  follow the reference count of the template it was handed, so a placeholder the app forgot to
  substitute stays visible), `/upload/image`, `/prompt`, `/history/{id}`, `/view`, `/queue`,
  `/interrupt`; it returns `MockComfy` = `{ url, generator, prompts(), uploads(), close() }`, where
  `generator` is the `kind: 'comfyui'` `imageGenerators` entry pointing at it and `prompts()` /
  `uploads()` are **what the app actually sent** — the substituted prompt of every submitted job and
  the name of every uploaded reference (the assertions about the cast layer read them: UX 17 checks
  that the prompt named the reference and never named the person). What a job does follows the prompt
  text the app substituted into the workflow: "fail" → the server reports an execution error, "slow" →
  5 s, anything else → a short pause and a real generated PNG from `/view` — so the failure, the
  pending/spinner and the ready-card paths are all covered without a real ComfyUI. `beforeAll` starts
  the mock LLM and the mock ComfyUI, `beforeEach` points the config's `llmModels`/`imageGenerators`
  at them, so the run is fast and does not depend on the user's real models. The mock LLM recognizes
  the calls by their system prompt: a chat reply answers
  "Mock reply from <character name>." (the name is read from the system prompt, and a
  `customReplies` option can override the wording); a prompt translation ("Translate …")
  answers with an English description that keeps the "fail"/"slow" markers so a test can steer
  the generator; the picture planning of the user's turn ("You plan one picture …") answers
  with the JSON plan the suite sets through `MockLlm.setImagePlan` — the plan carries the cast layer
  too (`cast` = the person ids it shows, `subjects` = the noun phrase it used for each; both default
  to empty, so a plan written before them still works), and `MockLlm.lastPlanRequest()` returns the
  system prompt + user text of that call, which is how a test sees what the planner was told about
  the people and the pictures — `setImagePlan(null)` makes
  it answer with prose instead, which is how "the model could not plan it" path is covered; the
  picture editor's "Make it English" ("You prepare an image generation prompt …") answers an
  English prompt, and its "Describe the picture" ("You describe pictures …") a fixed sentence —
  that is what UX 10b drives. The "hanging model" cancel test in `app.spec.ts` still
  spins up its own never-answering server (on top of the mocks).
- `beforeEach` also creates the catalog via the API (`PUT /persons`: Carol + Dave;
  `PUT /characters`: Alice + Bob) and clears all chats so each test opens a fresh empty chat.
- Selectors are `data-testid` attributes: `char-name` (joined participant names; click opens the
  participants menu), `model-chip` (click opens the model menu), `vision-chip` (the 👁 — its title
  names the vision model, `class="missing"` when that model cannot see; click opens the vision menu:
  `vision-option-default` "Default", `vision-option` per model, `vision-option-row` the row,
  `vision-edit` its ✎), `menu`,
  `char-option` (a participants-menu row: `.opt-toggle` toggles membership, `.opt-mark` shows
  ● in-chat / ○ out), `model-option` (a model-menu row opened by the chip),
  `char-edit`/`user-edit`/`model-edit` (the ✎ row icons), `new-character`/`new-persona`/`new-model`
  (the "+ New" buttons), `user-option-row`/`model-option-row` (a row wrapper), `chat-date` (the
  chat-title label — the chat name, or the creation date while it has no name — that opens the chat
  menu) with a **chat-actions ⋮ right next to it in the
  same cell** (`chat-dots` — `chat-settings` "Chat settings…", `clone-chat` "Clone chat" and
  `delete-chat` live in its dropdown,
  not in the label's own menu), `new-chat` / `new-chat-dialog` / `new-chat-confirm`, `user-name`,
  `settings`, `history`, `message`, `msg-sender`, `msg-edit` (the ✎ of a message,
  and of a picture card — a text message goes into the bottom field's edit mode, a card opens
  the picture editor), `input`, `send` (➤ normally; ✕
  while a reply is generating — it is the cancel then), `attach`,
  `gen-toggle`, `auto-image` (the 📷 picture of the user's turn; only then),
  `error-banner`, `typing`. The picture card: `image-card`, `card-caption`,
  `card-prompt`, `card-refs`, and inside it the state placeholders `img-pending`
  (+ `img-cancel`), `img-cancelled` / `img-broken` (+ `img-regen`, `img-error-text`) and the
  ready picture's quick redraw `img-regenerate` + `lightbox`/`lightbox-close`. The picture
  editor (`picture-dialog`, opened by the card's ✎): `picture-kind-generated` /
  `picture-kind-file` (the radios), `picture-prompt`, `picture-prompt-from-chat`,
  `picture-prompt-english`, `picture-description`, `picture-describe`, `picture-id` (the catalog
  `<select>`), `picture-file` (the disk pick), `picture-depicts` (the "who is on this picture" chips,
  `.on` = chosen), the reference set the prompt names (`.refs` / `.ref-thumb`, no testid — it is
  read-only) and `picture-save` / `picture-cancel`. The picture BROWSER (the ⋮ menu → `picture-library`
  opens the `picture-library` modal, closed by `picture-library-close`): `picture-filter` (the search),
  `picture-sort` (the order pick: `newest` / `id`),
  `picture-row` (one picture in the list, `.on` = selected, `.gone` = its file is gone, with a
  `.lib-thumb-gone` ✕ inside, a `.lib-refs` "N ref(s)" badge when other pictures use it and a
  `.lib-same` "N copy/copies" badge when the same bytes live at another path),
  `picture-empty`, `picture-preview`, then the editor of the selected
  picture — `picture-description` with its `picture-describe` helper, `picture-prompt` and the
  reference chips (`picture-ref-remove` per chip) with `picture-ref-add` (the `<select>` of catalog
  ids) — both absent for a picture the app drew automatically (`source: 'auto'`) —, the
  `picture-id-input` with
  `picture-rename` right of the field (disabled until the id differs), the
  `picture-used-by` hint line under it, the `picture-forget` button of a row whose file is gone
  (absent for a real picture) and `picture-reset` / `picture-save` at its bottom.
  The entity dialogs: `character-dialog`/`user-dialog`/
  `model-dialog` + `char-name-input`/`user-name-input`/`model-name-input`/`model-id-input` and
  `char-save`/`char-clone`/`char-delete` (the `user-*`/`model-*` analogues); the entity dialogs also
  carry the ID field — `char-id-input` with `char-rename` and `user-id-input` with `user-rename`
  (both rename buttons disabled until the field says another folder name); the
  model dialog also
  has `model-reasoning-select` + `model-reasoning-levels-input`. The per-chat dialog:
  `chat-settings-dialog` + `chat-name-input` + the ID field `chat-id-input` with
  `chat-rename` (disabled until the field says another folder name — the chat's
  ID is its folder name, a new one is born `yyyy-mm-dd_hh-mm-ss`) +
  `chat-temp-input`/`chat-minp-input`/`chat-reppen-input`/
  `chat-sysprompt-input`/`chat-style-input` (the picture style of the whole chat) +
  `chat-settings-save`.
- The suite captures screenshots into `e2e/screenshots/`.
