import _ from "lodash";

import type {
  Endpoint,
  EndpointOperation,
  RamlResource,
  NormalizedExample,
  ResolvedTypeDefinition
} from "./types";

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

