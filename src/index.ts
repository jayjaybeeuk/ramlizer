import oraModule from "ora";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import * as ramlParser from "raml-1-parser";
import osprey from "osprey";
import resources from "osprey-resources";
import finalhandler from "finalhandler";
import morgan from "morgan";
import bodyParser from "body-parser";
import Negotiator from "negotiator";
import cors from "cors";

import {
  extractExamples,
  extractTypesMap,
  generateMockResponse,
  ramlResourcesToEndpoints
} from "./raml";
import {
  buildCatalogue,
  buildOperationStates,
  detectRamlVersion,
  effectiveExample,
  operationKey
} from "./catalogue";
import { registerAdminRoutes } from "./admin";
import type {
  OperationState,
  RamlizerOptions,
  RamlizerServerConfig,
  RamlizerInstance,
  RamlizerState,
  RequestLogEntry,
  ScenarioSelection,
  SpecRecord,
  SpecSummary,
  StartedRamlizer
} from "./types";

export * from "./types";
export * from "./raml";
export {
  buildCatalogue,
  buildOperationStates,
  detectRamlVersion,
  effectiveExample,
  operationKey
} from "./catalogue";

const ora = (oraModule as any)?.default || oraModule;

const REQUEST_LOG_LIMIT = 200;

type Source = { kind: "folder" | "file"; path: string };

export function createRamlizer(options: RamlizerOptions = {}): RamlizerInstance {
  const silent = Boolean(options.silent);
  const spinner: any = silent
    ? {
        start: () => spinner,
        succeed: () => spinner,
        warn: () => spinner,
        info: () => spinner,
        fail: () => spinner
      }
    : ora("Launching").start();

  // These two objects are part of the public instance, so they are only ever mutated in place.
  const plannedMethodResponseCodes: Record<string, string> = {};
  const plannedMethodExampleNames: Record<string, string> = {};
  const knownTypes: Record<string, any> = {};

  const specs = new Map<string, SpecRecord>();
  const sources: Source[] = [];
  const requestLog: RequestLogEntry[] = [];
  let requestSeq = 0;
  let lastReload: string | undefined;
  let endpointName = (options.endpoint || "ramlizer").replace(/^\/+|\/+$/g, "") || "ramlizer";

  let mockRouter: any = null;
  let mockRouterMounted = false;
  let reloadChain: Promise<unknown> = Promise.resolve();

  const app = osprey.Router();
  app.use(cors());

  /* ------------------------------------------------------------------ mock serving */

  function recordRequest(entry: Omit<RequestLogEntry, "id" | "time">) {
    requestLog.push({ id: ++requestSeq, time: new Date().toISOString(), ...entry });
    if (requestLog.length > REQUEST_LOG_LIMIT) {
      requestLog.splice(0, requestLog.length - REQUEST_LOG_LIMIT);
    }
  }

  function mockHandler(specId: string) {
    return (handledRoute: any, routePath?: string) => {
      return (req: any, res: any) => {
        const rawMethod = handledRoute.method;
        const method =
          typeof rawMethod === "function"
            ? rawMethod()
            : rawMethod?.value
              ? rawMethod.value()
              : rawMethod;
        const negotiator = new Negotiator(req);
        const route = routePath || (req.route ? req.route.path : req.url);
        const key = operationKey(method, route);

        const plannedMethodResponseCode = plannedMethodResponseCodes[key];

        const plannedResponse =
          (plannedMethodResponseCode && handledRoute.responses?.[plannedMethodResponseCode]) ||
          handledRoute.responses?.[200] ||
          (handledRoute.responses && Object.values(handledRoute.responses)[0]) ||
          {};

        const bodies = plannedResponse?.body || {};
        const types = Object.keys(bodies);
        const type = negotiator.mediaType(types);
        const chosenType = type || types[0];
        const body = (type ? bodies[type] : Object.values(bodies)[0]) || {};

        let response: any;
        let servedExample = "generated";
        const examples = extractExamples(body, knownTypes);

        if (examples.length > 0) {
          const plannedExampleName = plannedMethodExampleNames[key];
          const plannedExample =
            examples.find(example => example.name === plannedExampleName) || examples[0];
          response = plannedExample.value;
          servedExample = plannedExample.name;
        } else if (types.length === 0) {
          servedExample = "none";
        } else {
          response = generateMockResponse(body, knownTypes);
        }

        res.statusCode = Number(plannedMethodResponseCode) || 200;
        if (chosenType) {
          res.setHeader("Content-Type", chosenType);
        }

        if (res.statusCode !== 204 && res.statusCode !== 304) {
          if (typeof response === "string" && chosenType && !chosenType.includes("json")) {
            res.write(response);
          } else {
            res.write(JSON.stringify(response === undefined ? {} : response));
          }
        }
        res.end();

        recordRequest({
          method: String(req.method || method).toUpperCase(),
          path: req.originalUrl || req.url,
          route,
          status: res.statusCode,
          example: servedExample,
          specId,
          contentType: chosenType
        });
      };
    };
  }

  function orderedSpecs(): SpecRecord[] {
    return Array.from(specs.values());
  }

  /** Rebuilds the mock router from the enabled specs and swaps it in atomically. */
  function rebuildMockRouter() {
    for (const k of Object.keys(knownTypes)) delete knownTypes[k];
    const enabled = orderedSpecs().filter(s => s.enabled && s.json && !s.error);
    for (const spec of enabled) Object.assign(knownTypes, spec.types);

    const router = osprey.Router();
    for (const spec of enabled) {
      router.use(resources(ramlResourcesToEndpoints(spec.json.resources), mockHandler(spec.id)));
    }
    router.use(osprey.errorHandler());
    mockRouter = router;

    if (!mockRouterMounted) {
      mockRouterMounted = true;
      app.use((req: any, res: any, next: any) =>
        mockRouter ? mockRouter(req, res, next) : next()
      );
    }
  }

  /* ------------------------------------------------------------------ scenario planning */

  function applyDefaults(spec: SpecRecord, overwrite: boolean) {
    for (const op of spec.operations) {
      if (overwrite || !plannedMethodResponseCodes[op.key]) {
        plannedMethodResponseCodes[op.key] = op.defaultCode;
        plannedMethodExampleNames[op.key] = op.defaultExample;
      }
    }
  }

  /**
   * After specs change (reload, enable/disable) the file now serving a route may not declare the
   * response code that was selected; fall back to its defaults rather than send a mismatched body.
   */
  function sanitisePlan() {
    const validKeys = new Set<string>();
    for (const spec of orderedSpecs()) {
      for (const op of spec.operations) {
        validKeys.add(op.key);
      }
    }

    // Prune stale keys from specs that were deleted or reloaded without those routes
    for (const key of Object.keys(plannedMethodResponseCodes)) {
      if (!validKeys.has(key)) delete plannedMethodResponseCodes[key];
    }
    for (const key of Object.keys(plannedMethodExampleNames)) {
      if (!validKeys.has(key)) delete plannedMethodExampleNames[key];
    }

    for (const op of buildOperationStates(
      orderedSpecs(),
      plannedMethodResponseCodes,
      plannedMethodExampleNames
    )) {
      if (op.active) {
        if (!op.responses.some(r => r.code === plannedMethodResponseCodes[op.key])) {
          plannedMethodResponseCodes[op.key] = op.defaultCode;
          plannedMethodExampleNames[op.key] = op.defaultExample;
        } else {
          plannedMethodExampleNames[op.key] = effectiveExample(
            op,
            plannedMethodResponseCodes[op.key] || op.defaultCode,
            plannedMethodExampleNames[op.key]
          );
        }
      }
    }
  }

  function findServingOperation(key: string): OperationState | undefined {
    const states = buildOperationStates(
      orderedSpecs(),
      plannedMethodResponseCodes,
      plannedMethodExampleNames
    );
    return states.find(s => s.key === key && s.active) || states.find(s => s.key === key);
  }

  function getState(): RamlizerState {
    return {
      endpoint: endpointName,
      specs: orderedSpecs().map(summariseSpec),
      operations: buildOperationStates(
        orderedSpecs(),
        plannedMethodResponseCodes,
        plannedMethodExampleNames
      ),
      lastReload
    };
  }

  function selectScenario(selection: ScenarioSelection | ScenarioSelection[]): OperationState[] {
    const list = Array.isArray(selection) ? selection : [selection];
    if (list.length === 0) {
      throw new Error("Selection list cannot be empty.");
    }

    // Validate all selections atomically before applying any mutations
    const validated: Array<{
      key: string;
      code: string;
      example: string;
    }> = [];

    for (const item of list) {
      if (!item || typeof item.route !== "string" || typeof item.method !== "string") {
        throw new Error("Each selection needs a string `route` and `method`.");
      }
      const key = operationKey(item.method, item.route);
      const op = findServingOperation(key);
      if (!op) {
        throw new Error(`No operation ${item.method.toUpperCase()} ${item.route} is loaded.`);
      }

      let code = plannedMethodResponseCodes[key] || op.defaultCode;
      if (item.code !== undefined && item.code !== null && item.code !== "") {
        code = String(item.code);
        if (!op.responses.some(r => r.code === code)) {
          throw new Error(
            `${item.method.toUpperCase()} ${item.route} does not declare a ${code} response.`
          );
        }
      }

      let example: string;
      if (item.example !== undefined && item.example !== null && item.example !== "") {
        example = String(item.example);
        const response = op.responses.find(r => r.code === code);
        const hasExplicitExamples = Boolean(response?.examples && response.examples.length > 0);
        const isGenerated = example === "generated" && !hasExplicitExamples;
        const known =
          example === "none" ||
          isGenerated ||
          (response?.examples.some(ex => ex.name === example) ?? false);
        if (!known) {
          throw new Error(`The ${code} response of ${item.route} has no example named '${example}'.`);
        }
        if (isGenerated) {
          example = "none";
        }
      } else {
        example = effectiveExample(op, code);
      }

      validated.push({ key, code, example });
    }

    // Apply mutations only after all items have validated successfully
    for (const entry of validated) {
      plannedMethodResponseCodes[entry.key] = entry.code;
      plannedMethodExampleNames[entry.key] = entry.example;
    }

    const states = getState().operations;
    return validated.map(
      entry => states.find(s => s.key === entry.key && s.active) || states.find(s => s.key === entry.key)!
    );
  }

  function resetScenarios(filter: { method?: string; route?: string } = {}): number {
    // One plan entry per method + route: take the defaults of the spec that serves it, so a
    // shadowed copy in another file never overrides them.
    const owners = new Map<string, OperationState>();
    for (const op of buildOperationStates(
      orderedSpecs(),
      plannedMethodResponseCodes,
      plannedMethodExampleNames
    )) {
      if (filter.method && op.method !== String(filter.method).toLowerCase()) continue;
      if (filter.route && op.route !== filter.route) continue;
      const current = owners.get(op.key);
      if (!current || (!current.active && op.active)) owners.set(op.key, op);
    }
    for (const op of owners.values()) {
      plannedMethodResponseCodes[op.key] = op.defaultCode;
      plannedMethodExampleNames[op.key] = op.defaultExample;
    }
    return owners.size;
  }

  /* ------------------------------------------------------------------ spec loading */

  function summariseSpec(spec: SpecRecord): SpecSummary {
    const { json: _json, types: _types, operations, ...rest } = spec;
    return { ...rest, operationCount: operations.length };
  }

  function uniqueSpecId(file: string): string {
    const existing = orderedSpecs().find(s => s.file === file);
    if (existing) return existing.id;
    const base = path.basename(file);
    let id = base;
    let n = 2;
    while (specs.has(id)) id = `${base}-${n++}`;
    return id;
  }

  function logStrategies(spec: SpecRecord) {
    for (const op of spec.operations) {
      spinner.succeed(`${op.route} has method ${op.method}`);
      if (op.responses.length === 0) {
        spinner.warn(`${op.route}:${op.method} has no responses, skipping`);
        continue;
      }
      for (const response of op.responses) {
        spinner.succeed(
          `${op.route}:${op.method} will produce a '${response.code}' response code`
        );
        if (!response.hasBody) {
          spinner.warn(`${op.route}:${op.method} has no body, skipping`);
        } else if (response.examples.length === 0) {
          spinner.warn(`${op.route}:${op.method}:${response.code} has no examples, skipping`);
        } else {
          for (const example of response.examples) {
            spinner.succeed(
              `${op.route}:${op.method}:${response.code} contains an example named '${example.name}'`
            );
          }
        }
      }
    }
  }

  async function loadSpec(file: string): Promise<SpecRecord> {
    const absolute = path.resolve(file);
    const source = await fs.promises.readFile(absolute, "utf8");
    const api: any = await ramlParser.loadApi(absolute);

    let json: any;
    try {
      json =
        typeof api.expand === "function"
          ? api.expand(true).toJSON({ serializeMetadata: false })
          : api.toJSON({ serializeMetadata: false });
    } catch {
      json = api.toJSON ? api.toJSON({ serializeMetadata: false }) : api;
    }

    let warnings: string[] = [];
    try {
      const errors = typeof api.errors === "function" ? api.errors() : [];
      warnings = (errors || [])
        .slice(0, 10)
        .map((e: any) => (e?.message ? String(e.message) : String(e)));
    } catch {
      warnings = [];
    }

    const id = uniqueSpecId(absolute);
    // Types from previously loaded files remain visible, matching the original merge behaviour.
    const types = extractTypesMap(json);
    const typesForCatalogue = { ...knownTypes, ...types };

    return {
      id,
      file: absolute,
      name: path.basename(absolute),
      title: typeof json?.title === "string" ? json.title : undefined,
      version: json?.version !== undefined ? String(json.version) : undefined,
      ramlVersion: detectRamlVersion(source),
      enabled: specs.get(id)?.enabled ?? true,
      loadedAt: new Date().toISOString(),
      warnings,
      operations: buildCatalogue(json, id, typesForCatalogue),
      json,
      types
    };
  }

  function parseRAML(file: string): Promise<void> {
    spinner.succeed();
    spinner.start(`Parsing ${file}`);
    return loadSpec(file)
      .then(spec => {
        if (!sources.some(s => s.path === spec.file)) {
          // Files loaded through loadFolder are tracked by their folder instead.
          if (!sources.some(s => s.kind === "folder" && path.dirname(spec.file) === s.path)) {
            sources.push({ kind: "file", path: spec.file });
          }
        }
        specs.set(spec.id, spec);
        Object.assign(knownTypes, spec.types);

        spinner.succeed();
        spinner.start("Filling strategy queues");
        logStrategies(spec);
        applyDefaults(spec, false);

        spinner.succeed();
        spinner.start(`Creating HTTP mock services for ${file}`);
        rebuildMockRouter();
      })
      .catch((err: any) => {
        console.error(err);
        throw err;
      });
  }

  async function listRamlFiles(folderPath: string): Promise<string[]> {
    const files = await fs.promises.readdir(folderPath);
    return files
      .filter(el => /\.raml$/.test(el))
      .sort()
      .map(f => path.join(path.resolve(folderPath), f));
  }

  async function loadFolder(folderPath: string): Promise<void> {
    const absolute = path.resolve(folderPath);
    if (!sources.some(s => s.kind === "folder" && s.path === absolute)) {
      sources.push({ kind: "folder", path: absolute });
    }
    for (const file of await listRamlFiles(absolute)) {
      await parseRAML(file);
    }
  }

  async function doReload(): Promise<RamlizerState> {
    const wanted: string[] = [];
    for (const source of sources) {
      if (source.kind === "folder") {
        try {
          wanted.push(...(await listRamlFiles(source.path)));
        } catch {
          // Folder vanished: everything that came from it disappears below.
        }
      } else if (fs.existsSync(source.path)) {
        wanted.push(source.path);
      }
    }

    const previous = new Map(orderedSpecs().map(s => [s.file, s]));
    const next = new Map<string, SpecRecord>();
    for (const k of Object.keys(knownTypes)) delete knownTypes[k];

    for (const file of wanted) {
      const before = previous.get(file);
      try {
        const spec = await loadSpec(file);
        if (before) {
          spec.id = before.id;
          spec.enabled = before.enabled;
          for (const op of spec.operations) op.specId = before.id;
        }
        next.set(spec.id, spec);
        Object.assign(knownTypes, spec.types);
      } catch (err: any) {
        const message = err?.message ? String(err.message) : String(err);
        spinner.warn(`Could not reload ${file}: ${message}`);
        if (before) {
          next.set(before.id, { ...before, error: message });
        } else {
          const id = uniqueSpecId(file);
          next.set(id, {
            id,
            file,
            name: path.basename(file),
            enabled: true,
            loadedAt: new Date().toISOString(),
            error: message,
            warnings: [],
            operations: [],
            types: {}
          });
        }
      }
    }

    specs.clear();
    for (const [id, spec] of next) specs.set(id, spec);
    for (const spec of specs.values()) applyDefaults(spec, false);
    sanitisePlan();
    lastReload = new Date().toISOString();
    rebuildMockRouter();
    spinner.info(`Reloaded ${specs.size} RAML file(s)`);
    return getState();
  }

  function reload(): Promise<RamlizerState> {
    const run = reloadChain.then(doReload, doReload);
    reloadChain = run.catch(() => undefined);
    return run;
  }

  function setSpecEnabled(id: string, enabled: boolean): SpecSummary {
    const spec = specs.get(id);
    if (!spec) throw new Error(`No RAML file with id '${id}' is loaded.`);
    spec.enabled = Boolean(enabled);
    sanitisePlan();
    rebuildMockRouter();
    spinner.info(`${spec.name} ${spec.enabled ? "enabled" : "disabled"}`);
    return summariseSpec(spec);
  }

  function getRequestLog(sinceId = 0): RequestLogEntry[] {
    if (sinceId > 0 && requestLog.length > 0 && requestLog[requestLog.length - 1].id < sinceId) {
      return requestLog;
    }
    return requestLog.filter(entry => entry.id > sinceId);
  }

  /* ------------------------------------------------------------------ server wiring */

  let serverStarted = false;
  function startServer(config: RamlizerServerConfig = {}) {
    if (serverStarted) return;
    serverStarted = true;
    const port = config.port ? config.port : 8080;
    if (config.endpoint) {
      endpointName = config.endpoint.replace(/^\/+|\/+$/g, "") || "ramlizer";
    }
    const uiEnabled = (config.ui ?? options.ui) !== false;

    if (!silent) {
      app.use(morgan("combined"));
    }
    app.use(bodyParser.json());

    const ui = registerAdminRoutes(app, {
      basePath: `/${endpointName}`,
      ui: uiEnabled,
      plannedMethodResponseCodes,
      plannedMethodExampleNames,
      getState,
      selectScenario,
      resetScenarios,
      setSpecEnabled,
      reload,
      getRequestLog
    });

    spinner.succeed();
    spinner.start(
      `Listening for configuration requests on http://localhost:${port}/${endpointName}`
    );
    if (uiEnabled && ui.available) {
      spinner.succeed();
      spinner.info(`Admin interface at http://localhost:${port}/${endpointName}/`);
      spinner.start("Loading RAML");
    }
  }

  function listen(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      spinner.succeed();
      spinner.start("Launching HTTP server");
      const server = http.createServer((req, res) => {
        app(req, res, finalhandler(req, res));
      });
      server.once("error", reject);
      server.listen(port, () => {
        spinner.succeed();
        spinner.info(`Listening on http://localhost:${port}`);
        resolve(server);
      });
    });
  }

  return {
    app,
    plannedMethodResponseCodes,
    plannedMethodExampleNames,
    startServer,
    parseRAML,
    loadFolder,
    listen,
    getState,
    selectScenario,
    resetScenarios,
    setSpecEnabled,
    reload,
    getRequestLog
  };
}

export async function startRamlizer(
  argv: RamlizerOptions & { folder: string }
): Promise<StartedRamlizer> {
  const ramlizer = createRamlizer(argv);
  const port = argv.port ? argv.port : 8080;
  ramlizer.startServer(argv);
  await ramlizer.loadFolder(argv.folder);
  const server = await ramlizer.listen(port);
  return { ...ramlizer, server };
}
