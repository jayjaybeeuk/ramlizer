import _ from "lodash";
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

import type {
  Endpoint,
  EndpointOperation,
  RamlResource,
  RamlizerOptions,
  RamlizerServerConfig,
  RamlizerInstance,
  StartedRamlizer,
  ScenarioConfigBody,
  ScenarioConfigResponse,
  NormalizedExample,
  ResolvedTypeDefinition
} from "./types";

export * from "./types";

const ora = (oraModule as any)?.default || oraModule;

export function normalizeExampleValue(ex: any): any {
  if (ex === null || ex === undefined) return ex;

  // RAML 1.0 structuredValue
  if (typeof ex === "object" && "structuredValue" in ex) {
    return normalizeExampleValue(ex.structuredValue);
  }

  // RAML 1.0 example object wrapper with value property
  if (
    typeof ex === "object" &&
    "value" in ex &&
    ("strict" in ex ||
      "displayName" in ex ||
      "description" in ex ||
      "annotations" in ex ||
      Object.keys(ex).length <= 4)
  ) {
    return normalizeExampleValue(ex.value);
  }

  // If example is a JSON-encoded string (common in RAML 0.8 / 1.0 schema examples)
  if (typeof ex === "string") {
    const trimmed = ex.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return ex;
      }
    }
  }

  return ex;
}

export function extractTypesMap(json: any): Record<string, any> {
  const map: Record<string, any> = {};
  if (!json) return map;

  const typeEntries = [...(json.types || []), ...(json.schemas || [])];
  for (const entry of typeEntries) {
    if (!entry) continue;
    if (typeof entry === "object") {
      const keys = Object.keys(entry);
      if (keys.length === 1 && typeof entry[keys[0]] === "object") {
        map[keys[0]] = entry[keys[0]];
      } else if (entry.name) {
        map[entry.name] = entry;
      } else {
        Object.assign(map, entry);
      }
    }
  }
  return map;
}

export function cleanTypeName(rawType: any): { typeName: string; isArray: boolean } {
  if (!rawType) return { typeName: "", isArray: false };
  let typeStr =
    typeof rawType === "string"
      ? rawType
      : Array.isArray(rawType) && typeof rawType[0] === "string"
        ? rawType[0]
        : "";
  if (!typeStr) return { typeName: "", isArray: false };
  typeStr = typeStr.trim();

  // Handle union types (take the first variant)
  if (typeStr.includes("|")) {
    typeStr = typeStr.split("|")[0].trim();
  }

  let isArray = false;
  if (typeStr.endsWith("[]")) {
    isArray = true;
    typeStr = typeStr.slice(0, -2).trim();
  }

  return { typeName: typeStr, isArray };
}

export function resolveTypeDefinition(
  typeName: string,
  typesMap: Record<string, any> = {},
  visited = new Set<string>()
): ResolvedTypeDefinition | null {
  if (!typeName || typeof typeName !== "string" || visited.has(typeName)) {
    return null;
  }
  const def = typesMap[typeName];
  if (!def || typeof def !== "object") return null;

  visited.add(typeName);
  const resolved: ResolvedTypeDefinition = {
    name: typeName,
    type: def.type,
    items: def.items,
    properties: {},
    examples: def.examples ? _.cloneDeep(def.examples) : undefined,
    example: def.example !== undefined ? def.example : undefined,
    structuredExample: def.structuredExample
  };

  const parents = Array.isArray(def.type) ? def.type : [def.type];
  for (const parent of parents) {
    if (parent && typeof parent === "string" && typesMap[parent]) {
      const parentResolved = resolveTypeDefinition(parent, typesMap, new Set(visited));
      if (parentResolved) {
        resolved.properties = { ...parentResolved.properties, ...resolved.properties };
        if (resolved.examples === undefined && parentResolved.examples !== undefined) {
          resolved.examples = _.cloneDeep(parentResolved.examples);
        }
        if (resolved.example === undefined && parentResolved.example !== undefined) {
          resolved.example = parentResolved.example;
          resolved.structuredExample = parentResolved.structuredExample;
        }
      }
    }
  }

  if (def.properties && typeof def.properties === "object") {
    resolved.properties = { ...resolved.properties, ...def.properties };
  }

  return resolved;
}

export function mockValueFromProperty(
  prop: any,
  typesMap: Record<string, any> = {},
  depth = 0
): any {
  if (depth > 5 || !prop) return "";
  if (prop.example !== undefined) return normalizeExampleValue(prop.example);
  if (prop.structuredExample !== undefined) return normalizeExampleValue(prop.structuredExample);
  if (prop.default !== undefined) return prop.default;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return _.sample(prop.enum);

  const rawType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  const { typeName, isArray } = cleanTypeName(rawType || prop.typePropertyKind || "string");
  const lower = typeName.toLowerCase();

  if (isArray || lower === "array") {
    const rawItems = Array.isArray(prop.items) ? prop.items[0] : prop.items;
    const itemClean = cleanTypeName(rawItems);
    if (itemClean.typeName && typesMap[itemClean.typeName]) {
      const itemResolved = resolveTypeDefinition(itemClean.typeName, typesMap);
      if (itemResolved) {
        return [mockValueFromResolvedType(itemResolved, typesMap, depth + 1)];
      }
    }
    return [];
  }

  if (lower === "integer" || lower === "number") return 0;
  if (lower === "boolean") return true;
  if (lower === "object") {
    if (prop.properties && typeof prop.properties === "object") {
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries(prop.properties)) {
        obj[k] = mockValueFromProperty(v, typesMap, depth + 1);
      }
      return obj;
    }
    return {};
  }

  if (typeName && typesMap[typeName]) {
    const customResolved = resolveTypeDefinition(typeName, typesMap);
    if (customResolved) {
      return mockValueFromResolvedType(customResolved, typesMap, depth + 1);
    }
  }

  return prop.name || "";
}

export function mockValueFromResolvedType(
  resolved: ResolvedTypeDefinition,
  typesMap: Record<string, any> = {},
  depth = 0
): any {
  if (resolved.example !== undefined) return normalizeExampleValue(resolved.example);
  if (resolved.structuredExample !== undefined) return normalizeExampleValue(resolved.structuredExample);
  if (Array.isArray(resolved.examples) && resolved.examples.length > 0) {
    return normalizeExampleValue(resolved.examples[0]);
  }

  const { typeName, isArray } = cleanTypeName(resolved.type);
  if (isArray || typeName.toLowerCase() === "array") {
    const rawItems = Array.isArray(resolved.items) ? resolved.items[0] : resolved.items;
    const itemClean = cleanTypeName(rawItems);
    if (itemClean.typeName && typesMap[itemClean.typeName]) {
      const itemResolved = resolveTypeDefinition(itemClean.typeName, typesMap);
      if (itemResolved) {
        return [mockValueFromResolvedType(itemResolved, typesMap, depth + 1)];
      }
    }
    return [];
  }

  const obj: Record<string, any> = {};
  for (const [k, v] of Object.entries(resolved.properties || {})) {
    obj[k] = mockValueFromProperty(v, typesMap, depth + 1);
  }
  return obj;
}

export function extractExamples(
  body: any,
  typesMap: Record<string, any> = {}
): NormalizedExample[] {
  if (!body) return [];
  const results: NormalizedExample[] = [];

  // 1. Explicit body.examples (array or object map)
  if (body.examples) {
    if (Array.isArray(body.examples)) {
      for (let i = 0; i < body.examples.length; i++) {
        const ex = body.examples[i];
        const name = ex?.name || `example${i + 1}`;
        results.push({
          name,
          value: normalizeExampleValue(ex)
        });
      }
    } else if (typeof body.examples === "object") {
      for (const [name, ex] of Object.entries(body.examples)) {
        results.push({
          name,
          value: normalizeExampleValue(ex)
        });
      }
    }
  }

  // 2. Explicit body.example or body.structuredExample
  if (
    results.length === 0 &&
    (body.example !== undefined || body.structuredExample !== undefined)
  ) {
    const raw =
      body.structuredExample !== undefined ? body.structuredExample : body.example;
    const name = raw?.name || "default";
    results.push({
      name,
      value: normalizeExampleValue(raw)
    });
  }

  // 3. Examples from referenced RAML 1.0 type
  if (results.length === 0 && body.type) {
    const { typeName, isArray } = cleanTypeName(body.type);
    let resolved = resolveTypeDefinition(typeName, typesMap);

    if (!resolved && (body.items || isArray)) {
      const rawItems = Array.isArray(body.items) ? body.items[0] : body.items;
      const itemClean = cleanTypeName(rawItems);
      resolved = resolveTypeDefinition(itemClean.typeName, typesMap);
      if (resolved) {
        const typeExamples = extractExamples(resolved, typesMap);
        for (const ex of typeExamples) {
          results.push({
            name: ex.name,
            value: [ex.value]
          });
        }
        return results;
      }
    }

    if (resolved) {
      const typeExamples = extractExamples(resolved, typesMap);
      for (const ex of typeExamples) {
        results.push({
          name: ex.name,
          value: isArray ? [ex.value] : ex.value
        });
      }
    }
  }

  return results;
}

export function generateMockResponse(
  body: any,
  typesMap: Record<string, any> = {}
): any {
  if (!body) return {};

  // If RAML 0.8 schemaContent is present without explicit properties
  if (body.schemaContent && (!body.properties || Object.keys(body.properties).length === 0)) {
    try {
      const parsed = JSON.parse(body.schemaContent);
      if (parsed.properties && typeof parsed.properties === "object") {
        body.properties = parsed.properties;
      }
    } catch {}
  }

  const { typeName, isArray } = cleanTypeName(body.type);
  const isExplicitArray = isArray || typeName.toLowerCase() === "array";

  // If body has explicit properties
  if (body.properties && Object.keys(body.properties).length > 0) {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(body.properties)) {
      res[k] = mockValueFromProperty(v, typesMap);
    }
    return isExplicitArray ? [res] : res;
  }

  // If body is an array referencing an items type
  if (isExplicitArray) {
    const rawItems = Array.isArray(body.items) ? body.items[0] : body.items;
    const itemClean = cleanTypeName(rawItems);
    if (itemClean.typeName && typesMap[itemClean.typeName]) {
      const resolved = resolveTypeDefinition(itemClean.typeName, typesMap);
      if (resolved) {
        return [mockValueFromResolvedType(resolved, typesMap)];
      }
    }
    return [];
  }

  // If body references a custom type in typesMap
  if (typeName && typesMap[typeName]) {
    const resolved = resolveTypeDefinition(typeName, typesMap);
    if (resolved) {
      return mockValueFromResolvedType(resolved, typesMap);
    }
  }

  // Built-in primitive types
  const lower = typeName.toLowerCase();
  if (lower === "integer" || lower === "number") return 0;
  if (lower === "boolean") return true;
  if (lower === "string") return "";

  return {};
}

export function ramlResourcesToEndpoints(
  resList?: RamlResource[] | null,
  prefix = ""
): Endpoint[] {
  let endpoints: Endpoint[] = [];
  for (const resource of resList || []) {
    const fullPath = prefix + (resource.relativeUri || "");
    if (resource.methods && resource.methods.length > 0) {
      endpoints.push({
        path: { value: () => fullPath },
        parameters: resource.uriParameters || [],
        operations: resource.methods.map((methodObj: any): EndpointOperation => {
          let currentMethod = (methodObj.method || "get").toLowerCase();
          const op: EndpointOperation = Object.create(methodObj);
          op.method = { value: () => currentMethod };
          op.withMethod = (newMethod: string) => {
            currentMethod = newMethod;
          };
          return op;
        })
      });
    }
    if (resource.resources) {
      endpoints = endpoints.concat(
        ramlResourcesToEndpoints(resource.resources, fullPath)
      );
    }
  }
  return endpoints;
}

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

  const plannedMethodResponseCodes: Record<string, string> = {};
  const plannedMethodExampleNames: Record<string, string> = {};
  const knownTypes: Record<string, any> = {};

  const app = osprey.Router();
  app.use(cors());

  function mockHandler(handledRoute: any) {
    return (req: any, res: any) => {
      const rawMethod = handledRoute.method;
      const method =
        typeof rawMethod === "function"
          ? rawMethod()
          : rawMethod?.value
            ? rawMethod.value()
            : rawMethod;
      const negotiator = new Negotiator(req);
      const route = req.route ? req.route.path : req.url;

      const plannedMethodResponseCode =
        plannedMethodResponseCodes[`${method}:${route}`];

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
      const examples = extractExamples(body, knownTypes);

      if (examples.length > 0) {
        const plannedExampleName =
          plannedMethodExampleNames[`${method}:${route}`];

        let plannedExample = examples.find((example: any) => {
          return example.name === plannedExampleName;
        });

        if (!plannedExample) {
          plannedExample = examples[0];
        }

        response = plannedExample.value;
      } else {
        response = generateMockResponse(body, knownTypes);
      }

      res.statusCode = Number(plannedMethodResponseCode) || 200;
      if (chosenType) {
        res.setHeader("Content-Type", chosenType);
      }

      if (typeof response === "string" && chosenType && !chosenType.includes("json")) {
        res.write(response);
      } else {
        res.write(JSON.stringify(response));
      }
      res.end();
    };
  }

  function mockServer(raml: any) {
    if (raml) {
      Object.assign(knownTypes, extractTypesMap(raml));
    }
    const endpoints = ramlResourcesToEndpoints(raml?.resources);
    return resources(endpoints, mockHandler);
  }

  function scenarioConfigurator(req: any, res: any) {
    const { method, nextExampleName, nextResponseCode, route }: ScenarioConfigBody = req.body;
    const response: ScenarioConfigResponse = {
      route
    };

    if (nextResponseCode) {
      const oldResponseCode =
        plannedMethodResponseCodes[`${method}:${route}`] || "none";
      plannedMethodResponseCodes[`${method}:${route}`] = nextResponseCode;

      response.nextResponseCode = nextResponseCode;
      response.oldResponseCode = oldResponseCode;
    }

    if (nextExampleName) {
      const oldExampleName =
        plannedMethodExampleNames[`${method}:${route}`] || "none";
      plannedMethodExampleNames[`${method}:${route}`] = nextExampleName;

      response.nextExampleName = nextExampleName;
      response.oldExampleName = oldExampleName;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.write(JSON.stringify(response));
    res.end();
  }

  function fillStrategies(api: any, typesMap: Record<string, any> = knownTypes) {
    for (const resource of api.allResources()) {
      if (typeof resource.methods !== "function" || resource.methods().length === 0) {
        spinner.info(
          `${resource.completeRelativeUri()} has no methods, skipping`
        );
        continue;
      }

      for (const method of resource.methods()) {
        spinner.succeed(
          `${resource.completeRelativeUri()} has method ${method.method()}`
        );

        if (typeof method.responses !== "function" || method.responses().length === 0) {
          spinner.warn(
            `${resource.completeRelativeUri()}:${method.method()} has no responses, skipping`
          );
          continue;
        }

        for (const response of method.responses()) {
          const codeVal = response.code ? response.code().value() : "200";
          spinner.succeed(
            `${resource.completeRelativeUri()}:${method.method()} will produce a '${codeVal}' response code`
          );

          const responseJson = response.toJSON ? response.toJSON() : response;
          const bodies = responseJson.body;

          const routeKey = `${method.method()}:${resource.completeRelativeUri()}`;

          if (!bodies) {
            spinner.warn(
              `${resource.completeRelativeUri()}:${method.method()} has no body, skipping`
            );
            if (!plannedMethodResponseCodes[routeKey] || codeVal === "200") {
              plannedMethodResponseCodes[routeKey] = codeVal;
              plannedMethodExampleNames[routeKey] = "none";
            }
            continue;
          }

          if (_.size(bodies) > 1) {
            spinner.warn(
              `${resource.completeRelativeUri()}:${method.method()} has multiple body types, picking the first`
            );
          }

          const body = bodies[Object.keys(bodies)[0]];
          const examples = extractExamples(body, typesMap);

          const selectedCode = codeVal;
          const selectedExample = examples.length > 0 ? examples[0].name : "none";

          if (!plannedMethodResponseCodes[routeKey] || selectedCode === "200") {
            plannedMethodResponseCodes[routeKey] = selectedCode;
            plannedMethodExampleNames[routeKey] = selectedExample;
          }

          if (examples.length === 0) {
            spinner.warn(
              `${resource.completeRelativeUri()}:${method.method()}:${codeVal} has no examples, skipping`
            );
          } else {
            for (const example of examples) {
              spinner.succeed(
                `${resource.completeRelativeUri()}:${method.method()}:${codeVal} contains an example named '${example.name}'`
              );
            }
          }
        }
      }
    }
  }

  function startServer(config: RamlizerServerConfig = {}) {
    const port = config.port ? config.port : 8080;
    const endpoint = config.endpoint ? config.endpoint : "ramlizer";

    if (!silent) {
      app.use(morgan("combined"));
    }
    app.use(bodyParser.json());
    app.post(`/${endpoint}`, scenarioConfigurator);

    spinner.succeed();
    spinner.start(
      `Listening for configuration requests on http://localhost:${port}/${endpoint}`
    );
  }

  function applyRAML(raml: any, file: string) {
    spinner.succeed();
    spinner.start(`Creating HTTP mock services for ${file}`);

    app.use(mockServer(raml));
    app.use(osprey.errorHandler());
  }

  function parseRAML(file: string): Promise<void> {
    return ramlParser
      .loadApi(file)
      .then((api: any) => {
        spinner.succeed();
        spinner.start("Filling strategy queues");

        let json: any;
        try {
          json = typeof api.expand === "function"
            ? api.expand(true).toJSON({ serializeMetadata: false })
            : api.toJSON({ serializeMetadata: false });
        } catch {
          json = api.toJSON ? api.toJSON({ serializeMetadata: false }) : api;
        }

        const fileTypes = extractTypesMap(json);
        Object.assign(knownTypes, fileTypes);

        fillStrategies(api, knownTypes);
        applyRAML(json, file);
      })
      .catch((err: any) => {
        console.error(err);
        throw err;
      });
  }

  async function loadFolder(folderPath: string): Promise<void> {
    const files = await fs.promises.readdir(folderPath);
    const ramlFiles = files.filter(el => /\.raml$/.test(el));
    for (const file of ramlFiles) {
      await parseRAML(path.join(folderPath, file));
    }
  }

  function listen(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      spinner.succeed();
      spinner.start("Launching HTTP server");
      const server = http.createServer((req, res) => {
        app(req, res, finalhandler(req, res));
      });
      server.listen(port, (err?: Error) => {
        if (err) return reject(err);
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
    listen
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
