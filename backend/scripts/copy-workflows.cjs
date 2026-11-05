// tsc compiles TypeScript and nothing else, so the ComfyUI workflow templates —
// raw JSON the app reads at runtime so the user can replace them without a
// rebuild — have to be put next to the compiled module by hand. The loader
// (src/image_generation/comfyui/ComfyUiWorkflows.ts) looks for them in
// <its own folder>/workflows, which is src/... in the source tree (tests, dev
// server) and dist/... in a build.
const fs = require("fs");
const path = require("path");

const from = path.join(__dirname, "..", "src", "image_generation", "comfyui", "workflows");
const to = path.join(__dirname, "..", "dist", "image_generation", "comfyui", "workflows");

fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`ComfyUI workflows: ${fs.readdirSync(to).length} file(s) -> ${path.relative(process.cwd(), to)}`);
