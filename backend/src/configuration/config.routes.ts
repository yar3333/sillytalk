import express from "express";
import { CharactersService } from "../characters/CharactersService";
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ConfigurationService } from "./ConfigurationService";
import { PathHelper } from "../shared/PathHelper";

// The /config routes: the config.json load/save. The PUT performs the legacy
// migrations (the characters array into folders, the dead fields removed)
// and recomputes the available image generators for the updated settings.
export function createConfigRouter(
  configuration: ConfigurationService,
  characters: CharactersService,
  imageGeneration: ImageGenerationService,
): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.json(configuration.loadConfig());
  });

  router.put("/", async (req, res) => {
    const cfg = req.body;
    if (!cfg || typeof cfg !== "object") {
      res.status(400).json({ error: "Invalid config" });
      return;
    }
    // The legacy fields (the characters array into folders, the dead fields
    // removed) are handled in one place — the configuration service.
    const legacyCharacters = configuration.prepareLegacyConfig(cfg as Record<string, unknown>);
    if (legacyCharacters) characters.migrate(legacyCharacters);
    configuration.saveConfig(cfg);
    PathHelper.ensureDirs();
    // recompute the available generators for the updated settings
    await imageGeneration.refreshAvailableGenerators(configuration.loadConfig().imageGenerators);
    res.json(configuration.loadConfig());
  });

  return router;
}
