import { extractExamples, generateMockResponse } from "./raml";
import type {
  CatalogueOperation,
  CatalogueResponse,
  OperationState,
  RamlResource,
  SpecRecord
} from "./types";

/** Route key shared by the scenario planner, the mock handler and the admin API. */
export function operationKey(method: string, route: string): string {
  return `${String(method).toLowerCase()}:${route}`;
}

/** Reads the `#%RAML x.y` header so the UI can show which spec version a file uses. */
export function detectRamlVersion(source: string): string | undefined {
  const match = /^\s*#%RAML\s+([0-9.]+)/.exec(source);
  return match ? match[1] : undefined;
}

function textOf(value: any): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.value === "string") return value.value;
  return undefined;
}

function normaliseResponses(raw: any): Array<[string, any]> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((r: any) => [String(r?.code ?? "200"), r]);
  }
  return Object.entries(raw).map(([code, r]: [string, any]) => [String(r?.code ?? code), r]);
}

export function buildResponse(
  code: string,
  response: any,
  typesMap: Record<string, any>
): CatalogueResponse {
  const bodies = response?.body && typeof response.body === "object" ? response.body : {};
  const contentTypes = Object.keys(bodies);
  const preferredType = contentTypes.find(t => t.includes("json")) || contentTypes[0];
  const firstBody = preferredType ? bodies[preferredType] : undefined;
  const examples = firstBody ? extractExamples(firstBody, typesMap) : [];

  const result: CatalogueResponse = {
    code,
    description: textOf(response?.description),
    contentTypes,
    hasBody: contentTypes.length > 0,
    examples: examples.map(ex => ({ name: ex.name, value: ex.value }))
  };

  if (firstBody && examples.length === 0) {
    // generateMockResponse mutates the body it is given, so work on a copy.
    result.generated = generateMockResponse(structuredClone(firstBody), typesMap);
  }

  return result;
}

/**
 * Flattens a parsed RAML document into one entry per method + route, recording every response
 * code and named example so they can be listed and switched from the admin interface.
 */
export function buildCatalogue(
  json: any,
  specId: string,
  typesMap: Record<string, any> = {}
): CatalogueOperation[] {
  const operations: CatalogueOperation[] = [];

  const walk = (resList: RamlResource[] | undefined | null, prefix: string) => {
    for (const resource of resList || []) {
      const route = prefix + (resource.relativeUri || "");
      for (const methodObj of resource.methods || []) {
        const method = String(methodObj.method || "get").toLowerCase();
        const responses = normaliseResponses(methodObj.responses).map(([code, r]) =>
          buildResponse(code, r, typesMap)
        );

        const defaultResponse =
          responses.find(r => r.code === "200") || responses[0];
        const defaultCode = defaultResponse ? defaultResponse.code : "200";
        const defaultExample =
          defaultResponse && defaultResponse.examples.length > 0
            ? defaultResponse.examples[0].name
            : "none";

        operations.push({
          key: operationKey(method, route),
          method,
          route,
          specId,
          displayName: textOf(methodObj.displayName),
          description: textOf(methodObj.description) || textOf(resource.description),
          responses,
          defaultCode,
          defaultExample
        });
      }
      walk(resource.resources, route);
    }
  };

  walk(json?.resources, "");
  return operations;
}

/** The example that the mock handler will actually serve for a given code + requested example. */
export function effectiveExample(
  operation: CatalogueOperation,
  code: string,
  requestedExample?: string
): string {
  const response = operation.responses.find(r => r.code === code);
  if (!response || response.examples.length === 0) return "none";
  const match = response.examples.find(ex => ex.name === requestedExample);
  return match ? match.name : response.examples[0].name;
}

/**
 * Combines every loaded spec with the live scenario plan. Specs are evaluated in load order, so
 * when two enabled files declare the same method + route the first one serves it and the others
 * are reported as shadowed.
 */
export function buildOperationStates(
  specs: SpecRecord[],
  plannedCodes: Record<string, string>,
  plannedExamples: Record<string, string>
): OperationState[] {
  const servedBy = new Map<string, string>();
  const states: OperationState[] = [];

  for (const spec of specs) {
    for (const op of spec.operations) {
      let active = spec.enabled && !spec.error;
      let shadowedBy: string | undefined;
      if (active) {
        const owner = servedBy.get(op.key);
        if (owner) {
          active = false;
          shadowedBy = owner;
        } else {
          servedBy.set(op.key, spec.id);
        }
      }

      const rawCode = plannedCodes[op.key];
      const hasCode = rawCode && op.responses.some(r => r.code === rawCode);
      const selectedCode = hasCode ? rawCode : op.defaultCode;
      const selectedExample = effectiveExample(op, selectedCode, plannedExamples[op.key]);
      const modified =
        selectedCode !== op.defaultCode ||
        selectedExample !== effectiveExample(op, op.defaultCode, op.defaultExample);

      states.push({
        ...op,
        selectedCode,
        selectedExample,
        modified,
        active,
        ...(shadowedBy ? { shadowedBy } : {})
      });
    }
  }

  return states;
}
