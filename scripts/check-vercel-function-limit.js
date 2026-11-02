import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const API_ROOT = join(PROJECT_ROOT, "api");
const MAX_FUNCTIONS = 12;

function collectFunctions(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return collectFunctions(absolute);
    return entry.isFile() && entry.name.endsWith(".js")
      ? [relative(PROJECT_ROOT, absolute).replaceAll("\\\\", "/")]
      : [];
  }).sort();
}

const functions = collectFunctions(API_ROOT);
console.log(`Vercel serverless function inventory: ${functions.length}/${MAX_FUNCTIONS}`);
for (const file of functions) console.log(` - ${file}`);

if (functions.length > MAX_FUNCTIONS) {
  console.error(`Function limit exceeded by ${functions.length - MAX_FUNCTIONS}. Consolidate API routes before deployment.`);
  process.exitCode = 1;
} else if (functions.length === MAX_FUNCTIONS) {
  console.warn("Function budget is fully used; do not add another api/*.js entrypoint.");
} else {
  console.log(`Function headroom: ${MAX_FUNCTIONS - functions.length}`);
}
