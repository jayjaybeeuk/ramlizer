import { createUiAssetServer, type UiAsset } from "./ui-assets";
import type {
  OperationState,
  RamlizerState,
  RequestLogEntry,
  ScenarioConfigBody,
  ScenarioConfigResponse,
  ScenarioSelection,
  SpecSummary
} from "./types";

export interface AdminContext {
  basePath: string;
  ui: boolean;
  plannedMethodResponseCodes: Record<string, string>;
  plannedMethodExampleNames: Record<string, string>;
  getState: () => RamlizerState;
  selectScenario: (selection: ScenarioSelection | ScenarioSelection[]) => OperationState[];
  resetScenarios: (filter?: { method?: string; route?: string }) => number;
  setSpecEnabled: (id: string, enabled: boolean) => SpecSummary;
  reload: () => Promise<RamlizerState>;
  getRequestLog: (sinceId?: number) => RequestLogEntry[];
}

function sendJson(res: any, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function queryParam(req: any, name: string): string | null {
  try {
    return new URL(req.originalUrl || req.url, "http://localhost").searchParams.get(name);
  } catch {
    return null;
  }
}

/** Accepts both the admin API shape ({code, example}) and the legacy one ({nextResponseCode, nextExampleName}). */
function toSelection(raw: any): ScenarioSelection {
  return {
    method: raw?.method,
    route: raw?.route,
    code: raw?.code ?? raw?.nextResponseCode,
    example: raw?.example ?? raw?.nextExampleName
  };
}

function guard(handler: (req: any, res: any) => unknown | Promise<unknown>) {
  return (req: any, res: any) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err: any) => {
        sendJson(res, 400, { error: err?.message ? String(err.message) : String(err) });
      });
  };
}

/**
 * Registers the scenario configuration API and the graphical admin interface on `app`.
 *
 *   POST {base}                 legacy scenario switch (unchanged behaviour)
 *   GET  {base}/                admin interface
 *   GET  {base}/api/state       specs, operations, examples and current selections
 *   POST {base}/api/select      switch one or many operations ({method, route, code?, example?})
 *   POST {base}/api/reset       restore defaults (optionally for one {method, route})
 *   POST {base}/api/spec        enable / disable a RAML file ({id, enabled})
 *   POST {base}/api/reload      re-read RAML files from disk
 *   GET  {base}/api/log?since=N recent mock requests
 */
export function registerAdminRoutes(app: any, ctx: AdminContext) {
  const base = ctx.basePath.replace(/\/+$/, "");
  const assets = createUiAssetServer(base);

  // Original configuration endpoint, kept byte-for-byte compatible for existing clients.
  app.post(base, (req: any, res: any) => {
    const { method, nextExampleName, nextResponseCode, route }: ScenarioConfigBody =
      req.body || {};
    const key = `${method}:${route}`;
    const response: ScenarioConfigResponse = { route };

    if (nextResponseCode) {
      response.nextResponseCode = nextResponseCode;
      response.oldResponseCode = ctx.plannedMethodResponseCodes[key] || "none";
      ctx.plannedMethodResponseCodes[key] = nextResponseCode;
    }

    if (nextExampleName) {
      response.nextExampleName = nextExampleName;
      response.oldExampleName = ctx.plannedMethodExampleNames[key] || "none";
      ctx.plannedMethodExampleNames[key] = nextExampleName;
    }

    sendJson(res, 200, response);
  });

  app.get(
    `${base}/api/state`,
    guard((_req, res) => sendJson(res, 200, ctx.getState()))
  );

  app.post(
    `${base}/api/select`,
    guard((req, res) => {
      const body = req.body;
      const selection = Array.isArray(body) ? body.map(toSelection) : toSelection(body);
      sendJson(res, 200, { operations: ctx.selectScenario(selection) });
    })
  );

  app.post(
    `${base}/api/reset`,
    guard((req, res) => {
      const { method, route } = req.body || {};
      const count = ctx.resetScenarios({ method, route });
      sendJson(res, 200, { reset: count, state: ctx.getState() });
    })
  );

  app.post(
    `${base}/api/spec`,
    guard((req, res) => {
      const { id, enabled } = req.body || {};
      if (typeof id !== "string" || typeof enabled !== "boolean") {
        throw new Error("Expected a JSON body of {\"id\": string, \"enabled\": boolean}.");
      }
      const spec = ctx.setSpecEnabled(id, enabled);
      sendJson(res, 200, { spec, state: ctx.getState() });
    })
  );

  app.post(
    `${base}/api/reload`,
    guard(async (_req, res) => sendJson(res, 200, await ctx.reload()))
  );

  app.get(
    `${base}/api/log`,
    guard((req, res) => {
      const since = Number(queryParam(req, "since") || 0);
      sendJson(res, 200, { entries: ctx.getRequestLog(Number.isFinite(since) ? since : 0) });
    })
  );

  if (ctx.ui) {
    const serve = (asset: UiAsset) => (_req: any, res: any) => assets.serve(asset, res);
    app.get(base, serve("index.html"));
    app.get(`${base}/index.html`, serve("index.html"));
    app.get(`${base}/app.js`, serve("app.js"));
    app.get(`${base}/app.css`, serve("app.css"));
  }

  return { available: ctx.ui && assets.available };
}
