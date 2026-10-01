/**
 * Pack the built backend + frontend into a publishable npm package.
 *
 * Layout produced under release/sillytalk/:
 *   bin/sillytalk.js                  # entry point for `npx sillytalk`
 *   backend/dist/**                   # compiled backend
 *   frontend/dist/frontend/browser/** # built Angular frontend
 *   package.json                      # publishable manifest (runtime deps only)
 *   README.md
 *
 * The frontend is placed at <root>/frontend/dist/frontend/browser — the first
 * candidate backend/src/index.ts looks for — so the server finds it unchanged.
 *
 * Usage: node scripts/package-npm.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");
const browserDir = path.join(rootDir, "frontend", "dist", "frontend", "browser");
const outDir = path.join(rootDir, "release", "sillytalk");

const required = [distDir, browserDir];
for (const dir of required) {
  if (!fs.existsSync(dir)) {
    console.error(`Missing ${path.relative(rootDir, dir)} — run "npm run build" first.`);
    process.exit(1);
  }
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });
fs.cpSync(distDir, path.join(outDir, "backend", "dist"), { recursive: true });
fs.cpSync(browserDir, path.join(outDir, "frontend", "dist", "frontend", "browser"), {
  recursive: true,
});

fs.writeFileSync(
  path.join(outDir, "bin", "sillytalk.js"),
  '#!/usr/bin/env node\nrequire("../backend/dist/index.js");\n',
  "utf-8",
);

fs.copyFileSync(path.join(rootDir, "scripts", "npm-package", "README.md"), path.join(outDir, "README.md"));

const manifest = {
  name: "sillytalk",
  version: rootManifest.version,
  description: "Chat with AI characters: a web app with a Node.js/Express backend and an Angular frontend",
  main: "backend/dist/index.js",
  bin: { sillytalk: "bin/sillytalk.js" },
  files: ["bin", "backend/dist", "frontend/dist", "README.md"],
  scripts: { start: "node bin/sillytalk.js" },
  keywords: ["ai", "chat", "characters", "llm", "image-generation"],
  author: "yar3333",
  license: "MIT",
  repository: { type: "git", url: "https://github.com/yar3333/sillytalk" },
  engines: { node: ">=24" },
  dependencies: {
    cors: "^2.8.5",
    express: "^5.2.1",
  },
};
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");

console.log(`Packaged ${manifest.name} v${manifest.version} -> ${path.relative(rootDir, outDir)}`);
console.log(`Inspect:  npm pack ${path.relative(rootDir, outDir)} --dry-run`);
console.log(`Publish:  cd ${path.relative(rootDir, outDir)} && npm publish --access public`);
