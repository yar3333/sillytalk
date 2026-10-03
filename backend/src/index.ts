import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { apiRouter } from "./routes";
import { CONFIG_FILE, ensureDirs, loadConfig, parseListen } from "./config";
import { listCharacters, migrateCharacters, saveCharacter } from "./characters";
import { listUsers, saveUser } from "./users";
import { cancelAllJobs, refreshAvailableGenerators } from "./imagegen";
import { initMachineService } from "./machine";

// Migration: characters from the old config.json format (the characters field)
// are moved into characters/<id>/character.json folders.
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as { characters?: unknown };
    if (Array.isArray(raw.characters)) {
      migrateCharacters(raw.characters);
      delete raw.characters;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
    }
  } catch {
    // a corrupted config will be reported by loadConfig
  }
}

const config = loadConfig();
ensureDirs();

// The platform-specific machine service (Windows / POSIX) — selected once
// here, at startup, for the current OS; everything else uses it lazily.
initMachineService();

// The available image generators (enabled and up) — every one of them can
// run jobs in parallel; the jobs of a single generator are queued.
void refreshAvailableGenerators(config.imageGenerators);

// First run (nothing exists yet): create the default character and user.
if (listCharacters().length === 0) {
  saveCharacter({
    id: "assistant",
    name: "Assistant",
    description: "A friendly AI assistant. Replies briefly and to the point.",
  });
}
if (listUsers().length === 0) {
  saveUser({ id: "default", name: "You", description: "" });
}

const app = express();
app.use(cors());
app.use("/api", apiRouter);

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

const { host, port } = parseListen(config.listen);
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
      cancelAllJobs();
    } catch {
      // best effort — still exit
    }
    process.exit(0);
  });
}
