import express from "express";
import { CharactersService } from "./characters/CharactersService";
import { ChatsService } from "./chats/ChatsService";
import { ConfigurationService } from "./configuration/ConfigurationService";
import { ImageGenerationService } from "./image_generation/ImageGenerationService";
import { PersonsService } from "./persons/PersonsService";
import { ReplyService } from "./reply/ReplyService";
import { createCharactersRouter } from "./characters/characters.routes";
import { createChatsRouter } from "./chats/chats.routes";
import { createConfigRouter } from "./configuration/config.routes";
import { createImageRouter } from "./image_generation/image.routes";
import { createPersonsRouter } from "./persons/persons.routes";
import { HttpHelper } from "./shared/HttpHelper";
import { PathHelper } from "./shared/PathHelper";

// The API router: a thin assembler that mounts the per-domain route files
// (each domain folder keeps its own <domain>.routes.ts). The domain logic
// lives in the services; the route files are the thin HTTP layer (parameter
// parsing, validation, status codes, file streaming). The services are
// injected — the composition root in index.ts builds the DI container and
// hands them in here. The text-generation service is not handed in: the only
// route-level concern left (the chat's model) is resolved by the reply
// service (ReplyService.resolveChatModel).
export function createApiRouter(
  imageGeneration: ImageGenerationService,
  characters: CharactersService,
  persons: PersonsService,
  chats: ChatsService,
  configuration: ConfigurationService,
  reply: ReplyService,
): express.Router {
  const apiRouter = express.Router();

  apiRouter.use(express.json({ limit: "25mb" }));

  // An image is addressed by its id — its path relative to the data folder —
  // so it is served by one route of its own rather than by a route per folder
  // (a chat file, an imported character photo and a picture a sidecar points
  // at are all just images). The id arrives as a query parameter and is
  // resolved through PathHelper, which refuses anything that leaves the data
  // folders, so this can never be turned into an arbitrary file reader.
  //
  // It lives here, in the assembler, because it belongs to no domain: it is
  // the one place where the data layout is exposed over HTTP.
  apiRouter.get("/media", (req, res) => {
    const id = typeof req.query.path === "string" ? req.query.path : "";
    const file = PathHelper.resolveImageId(id);
    if (!file) {
      res.status(400).json({ error: "Unknown image path" });
      return;
    }
    HttpHelper.sendImage(res, file);
  });

  apiRouter.use("/config", createConfigRouter(configuration, characters, imageGeneration));
  apiRouter.use("/characters", createCharactersRouter(characters));
  apiRouter.use("/persons", createPersonsRouter(persons));
  apiRouter.use("/chats", createChatsRouter(chats, reply, characters, imageGeneration));
  apiRouter.use("/image", createImageRouter(imageGeneration, reply, chats));

  return apiRouter;
}
