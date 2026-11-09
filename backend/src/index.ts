import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createApiRouter } from "./routes";
import { PathHelper } from "./shared/PathHelper";
import { DI_CONFIGURATION_SERVICE, ConfigurationService } from "./configuration/ConfigurationService";
import { Container } from "./di";
import { DI_CHATS_SERVICE, ChatsService } from "./chats/ChatsService";
import { DI_CHARACTERS_SERVICE, CharactersService } from "./characters/CharactersService";
import { DI_PERSONS_SERVICE, PersonsService } from "./persons/PersonsService";
import { DI_IMAGE_GENERATION_SERVICE, ImageGenerationService } from "./image_generation/ImageGenerationService";
import { DI_REPLY_SERVICE, ReplyService } from "./reply/ReplyService";
import { DI_TEXT_GENERATION_SERVICE, TextGenerationService } from "./text_generation/TextGenerationService";
import { DI_IMAGE_META_SERVICE, ImageMetaService } from "./images/ImageMetaService";
import { DI_PICTURE_LIBRARY_SERVICE, PictureLibraryService } from "./images/PictureLibraryService";
import { DI_ENTITY_ID_SERVICE, EntityIdService } from "./entities/EntityIdService";

// ---- DI: the composition root of the backend ----
// Services are registered as lazy singletons on the container and resolved
// here, once; consumers (e.g. the API router) receive them via constructors
// and never touch the container themselves.
const container = new Container();
container.register(DI_CONFIGURATION_SERVICE, () => new ConfigurationService());
container.register(
  DI_TEXT_GENERATION_SERVICE,
  (c) => new TextGenerationService(c.resolve(DI_CONFIGURATION_SERVICE)),
);
// The images table comes first among the consumers of the data layout: the
// catalogs, the chat store and the generator all write through it, so it is the
// one place a picture's description, facts and avatar-de-dup live. The catalogs
// take it only to de-duplicate a picture picked from disk for an avatar.
container.register(DI_IMAGE_META_SERVICE, () => new ImageMetaService(() => PathHelper.configDir()));
container.register(
  DI_CHARACTERS_SERVICE,
  (c) =>
    new CharactersService(
      () => PathHelper.charactersDir(),
      () => PathHelper.catalogsDatabaseFile(),
      c.resolve(DI_IMAGE_META_SERVICE),
    ),
);
container.register(
  DI_PERSONS_SERVICE,
  (c) =>
    new PersonsService(
      () => PathHelper.personsDir(),
      () => PathHelper.catalogsDatabaseFile(),
      c.resolve(DI_IMAGE_META_SERVICE),
    ),
);
container.register(
  DI_CHATS_SERVICE,
  (c) =>
    new ChatsService(
      () => PathHelper.chatsDir(),
      c.resolve(DI_CONFIGURATION_SERVICE),
      c.resolve(DI_IMAGE_META_SERVICE),
    ),
);
container.register(
  DI_IMAGE_GENERATION_SERVICE,
  (c) =>
    new ImageGenerationService(
      c.resolve(DI_TEXT_GENERATION_SERVICE),
      c.resolve(DI_CONFIGURATION_SERVICE),
      c.resolve(DI_IMAGE_META_SERVICE),
    ),
);
container.register(
  DI_REPLY_SERVICE,
  (c) =>
    new ReplyService(
      c.resolve(DI_CHARACTERS_SERVICE),
      c.resolve(DI_PERSONS_SERVICE),
      c.resolve(DI_CHATS_SERVICE),
      c.resolve(DI_TEXT_GENERATION_SERVICE),
      c.resolve(DI_IMAGE_GENERATION_SERVICE),
      c.resolve(DI_CONFIGURATION_SERVICE),
    ),
);
// The picture browser sits above the table and the chat store: renaming a file
// is nothing a picture of one chat can do on its own.
container.register(
  DI_PICTURE_LIBRARY_SERVICE,
  (c) => new PictureLibraryService(c.resolve(DI_IMAGE_META_SERVICE), c.resolve(DI_CHATS_SERVICE)),
);
// Renaming a character or a persona renames its row in the catalogs table and
// with it the folder of its pictures — and the id is written into the chats,
// into the picture ids and into the cast of the picture rows — so this sits
// above both catalogs, the chat store and the table, the same way the picture
// browser does.
container.register(
  DI_ENTITY_ID_SERVICE,
  (c) =>
    new EntityIdService(
      c.resolve(DI_CHARACTERS_SERVICE),
      c.resolve(DI_PERSONS_SERVICE),
      c.resolve(DI_CHATS_SERVICE),
      c.resolve(DI_IMAGE_META_SERVICE),
    ),
);
const configuration = container.resolve(DI_CONFIGURATION_SERVICE);
const characters = container.resolve(DI_CHARACTERS_SERVICE);
const persons = container.resolve(DI_PERSONS_SERVICE);
const chats = container.resolve(DI_CHATS_SERVICE);

// Migration: the legacy config.json fields are cleaned up in one place
// (ConfigurationService.prepareLegacyConfig) — the characters array becomes
// rows of the catalogs table.
if (fs.existsSync(PathHelper.configFile())) {
  try {
    const raw = JSON.parse(fs.readFileSync(PathHelper.configFile(), "utf-8")) as Record<string, unknown>;
    const legacyCharacters = configuration.prepareLegacyConfig(raw);
    if (legacyCharacters) {
      characters.migrate(legacyCharacters);
      fs.writeFileSync(PathHelper.configFile(), JSON.stringify(raw, null, 2));
    }
  } catch {
    // a corrupted config will be reported by loadConfig
  }
}

const config = configuration.loadConfig();
PathHelper.ensureDirs();

// Reconcile the images table with the picture files on disk before anything
// reads it: a file the user dropped into a folder gets its row, a file he
// renamed outside the app takes its cards and references to the new path.
// A broken file must never stop the server, so a failing sync is only said.
try {
  container.resolve(DI_PICTURE_LIBRARY_SERVICE).sync();
} catch (err) {
  console.error(`picture sync at startup skipped: ${(err as Error).message}`);
}

// The available image generators (enabled and up) — every one of them can
// run jobs in parallel; the jobs of a single generator are queued.
const images = container.resolve(DI_IMAGE_GENERATION_SERVICE);
const reply = container.resolve(DI_REPLY_SERVICE);
void images.refreshAvailableGenerators(config.imageGenerators);

// First run (nothing exists yet): create the default character and person.
if (characters.list().length === 0) {
  characters.save({
    id: "assistant",
    name: "Assistant",
    description: "A friendly AI assistant. Replies briefly and to the point.",
  });
}
if (persons.list().length === 0) {
  persons.save({ id: "default", name: "You", description: "" });
}

const app = express();
app.use(cors());
app.use(
  "/api",
  createApiRouter(
    images,
    characters,
    persons,
    chats,
    configuration,
    reply,
    container.resolve(DI_PICTURE_LIBRARY_SERVICE),
    container.resolve(DI_ENTITY_ID_SERVICE),
  ),
);

// Static built frontend (Angular) + SPA fallback
const candidates = [
  path.join(__dirname, "..", "..", "frontend", "dist", "frontend", "browser"),
  path.join(__dirname, "..", "..", "frontend", "dist", "browser"),
];
const frontendDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? candidates[0];
const indexHtml = path.join(frontendDist, "index.html");

app.use(express.static(frontendDist));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api") && fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
    return;
  }
  next();
});

const { host, port } = configuration.parseListen(config.listen);
app.listen(port, host, () => {
  console.log(`sillytalk backend running on http://${host}:${port}`);
});

// On stop (systemd stop / Ctrl+C) cancel in-flight image generation, so a
// restart does not leave a generation running on a generator server with
// nobody waiting for its picture. The cancel asks each server over HTTP to
// drop the job it was given, and that request needs a moment to leave — the
// exit waits for it instead of cutting it off.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    try {
      images.cancelAllJobs();
    } catch {
      // best effort — still exit
    }
    setTimeout(() => process.exit(0), 300);
  });
}
