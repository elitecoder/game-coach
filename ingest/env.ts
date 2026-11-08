import { readFileSync } from "node:fs";
import { join } from "node:path";

let loaded = false;

/** Minimal .env loader: reads <project>/.env (gitignored) into process.env without overriding
 *  anything already set. Lets the API key live in one local file instead of a shell export. */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    const txt = readFileSync(join(import.meta.dirname, "..", ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // no .env — fine, rely on the real environment
  }
}
