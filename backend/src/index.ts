import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createApiRouter } from "./routes";
import { PathHelper } from "./configuration/PathHelper";
import { DI_CONFIGURATION_SERVICE, ConfigurationService } from "./configuration/ConfigurationService";
import { Container } from "./di";
import { initMachineService, DI_MACHINE_SERVICE } from "./machine/IMachineService";
import { DI_CHATS_SERVICE, ChatsService } from "./chats/ChatsService";
import { DI_CHARACTERS_SERVICE, CharactersService } from "./characters/CharactersService";
import { DI_PERSONS_SERVICE, PersonsService } from "./persons/PersonsService";
import { DI_IMAGE_GENERATION_SERVICE, ImageGenerationService } from "./image_generation/ImageGenerationService";
import { DI_REPLY_SERVICE, ReplyService } from "./reply/ReplyService";
import { DI_TEXT_GENERATION_SERVICE, TextGenerationService } from "./text_generation/TextGenerationService";

// ---- DI: the composition root of the backend ----
// Services are registered as lazy singletons on the container and resolved
// here, once; consumers (e.g. the API router) receive them via constructors
// and never touch the container themselves.
const container = new Container();
container.register(DI_MACHINE_SERVICE, () => initMachineService());
container.register(DI_CONFIGURATION_SERVICE, () => new ConfigurationService());
container.register(
  DI_TEXT_GENERATION_SERVICE,
  (c) => new TextGenerationService(c.resolve(DI_CONFIGURATION_SERVICE)),
);
container.register(DI_CHARACTERS_SERVICE, () => new CharactersService(() => PathHelper.charactersDir()));
container.register(DI_PERSONS_SERVICE, () => new PersonsService(() => PathHelper.personsDir()));
container.register(
  DI_CHATS_SERVICE,
  (c) => new ChatsService(() => PathHelper.chatsDir(), c.resolve(DI_CONFIGURATION_SERVICE)),
);
container.register(
  DI_IMAGE_GENERATION_SERVICE,
  (c) =>
    new ImageGenerationService(
      c.resolve(DI_MACHINE_SERVICE),
      c.resolve(DI_TEXT_GENERATION_SERVICE),
      c.resolve(DI_CHATS_SERVICE),
      c.resolve(DI_CONFIGURATION_SERVICE),
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
    ),
);
const configuration = container.resolve(DI_CONFIGURATION_SERVICE);
const characters = container.resolve(DI_CHARACTERS_SERVICE);
const persons = container.resolve(DI_PERSONS_SERVICE);
const chats = container.resolve(DI_CHATS_SERVICE);

// Migration: characters from the old config.json format (the characters field)
// are moved into characters/<id>/character.json folders.
if (fs.existsSync(PathHelper.configFile())) {
  try {
    const raw = JSON.parse(fs.readFileSync(PathHelper.configFile(), "utf-8")) as { characters?: unknown };
    if (Array.isArray(raw.characters)) {
      characters.migrate(raw.characters);
      delete raw.characters;
      fs.writeFileSync(PathHelper.configFile(), JSON.stringify(raw, null, 2));
    }
  } catch {
    // a corrupted config will be reported by loadConfig
  }
}

const config = configuration.loadConfig();
PathHelper.ensureDirs();

// The available image generators (enabled and up) — every one of them can
// run jobs in parallel; the jobs of a single generator are queued.
const images = container.resolve(DI_IMAGE_GENERATION_SERVICE);
const textGeneration = container.resolve(DI_TEXT_GENERATION_SERVICE);
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
app.use("/api", createApiRouter(images, textGeneration, characters, persons, chats, configuration, reply));

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

// On stop (systemd stop / Ctrl+C) cancel in-flight image generation so a
// restart does not leave orphaned generator processes running and holding the
// GPU. The kills target the generator's whole process group / tree (the
// platform-specific part — MachineService.killTree) and are in flight when the
// server exits.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    try {
      images.cancelAllJobs();
    } catch {
      // best effort — still exit
    }
    process.exit(0);
  });
}
