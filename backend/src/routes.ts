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

  apiRouter.use("/config", createConfigRouter(configuration, characters, imageGeneration));
  apiRouter.use("/characters", createCharactersRouter(characters));
  apiRouter.use("/persons", createPersonsRouter(persons));
  apiRouter.use("/chats", createChatsRouter(chats, reply, characters, imageGeneration));
  apiRouter.use("/image", createImageRouter(imageGeneration, reply, chats));

  return apiRouter;
}
