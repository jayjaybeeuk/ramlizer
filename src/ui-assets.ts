import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

export const UI_ASSETS = ["index.html", "app.js", "app.css"] as const;
export type UiAsset = (typeof UI_ASSETS)[number];

const BASE_PLACEHOLDER = /__RAMLIZER_BASE__/g;

/**
 * The UI files live in `src/ui` during development and are copied to `dist/ui` by the build, next
 * to the bundle that is executing (`__dirname` in CommonJS, `import.meta.url` in the ES build).
 */
function currentDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

export function resolveUiDir(): string | null {
  const here = currentDir();
  const candidates = [
    path.join(here, "ui"),
    path.join(here, "..", "src", "ui"),
    path.join(here, "..", "dist", "ui")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export interface UiAssetServer {
  available: boolean;
  serve: (asset: UiAsset, res: any) => void;
}

export function createUiAssetServer(basePath: string, uiDir = resolveUiDir()): UiAssetServer {
  const cache = new Map<string, Buffer>();

  function load(asset: UiAsset): Buffer | null {
    if (!uiDir) return null;
    const cached = cache.get(asset);
    if (cached) return cached;
    try {
      let content = fs.readFileSync(path.join(uiDir, asset));
      if (asset === "index.html") {
        content = Buffer.from(content.toString("utf8").replace(BASE_PLACEHOLDER, basePath), "utf8");
      }
      cache.set(asset, content);
      return content;
    } catch {
      return null;
    }
  }

  function serve(asset: UiAsset, res: any) {
    const content = load(asset);
    if (!content) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ramlizer admin UI assets were not found. Rebuild with `npm run build`.");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPES[path.extname(asset)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (asset === "index.html") {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
      );
    }
    res.end(content);
  }

  return { available: Boolean(uiDir), serve };
}
