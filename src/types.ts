import type http from "node:http";

export interface EndpointOperation {
  method: {
    value: () => string;
  };
  withMethod: (newMethod: string) => void;
  [key: string]: any;
}

export interface Endpoint {
  path: {
    value: () => string;
  };
  parameters: any[];
  operations: EndpointOperation[];
}

export interface RamlResource {
  relativeUri?: string;
  methods?: any[];
  resources?: RamlResource[];
  uriParameters?: any[];
  [key: string]: any;
}

export interface RamlizerOptions {
  silent?: boolean;
  /** Serve the graphical admin interface at `/<endpoint>/` (default: true). */
  ui?: boolean;
  folder?: string;
  port?: number;
  endpoint?: string;
  [key: string]: any;
}

export interface RamlizerServerConfig {
  port?: number;
  endpoint?: string;
  [key: string]: any;
}

export interface RamlizerInstance {
  app: any;
  plannedMethodResponseCodes: Record<string, string>;
  plannedMethodExampleNames: Record<string, string>;
  startServer: (config?: RamlizerServerConfig) => void;
  parseRAML: (file: string) => Promise<void>;
  loadFolder: (folderPath: string) => Promise<void>;
  listen: (port: number) => Promise<http.Server>;
  /** Snapshot of every loaded spec, operation and the scenario currently selected for each. */
  getState: () => RamlizerState;
  /** Switch one or more operations to a response code / named example. */
  selectScenario: (selection: ScenarioSelection | ScenarioSelection[]) => OperationState[];
  /** Restore defaults for one operation, or for every operation when no filter is given. */
  resetScenarios: (filter?: { method?: string; route?: string }) => number;
  /** Enable or disable a loaded RAML file without restarting. */
  setSpecEnabled: (id: string, enabled: boolean) => SpecSummary;
  /** Re-read every loaded folder and file from disk. */
  reload: () => Promise<RamlizerState>;
  /** Most recent mock requests, newest last. */
  getRequestLog: (sinceId?: number) => RequestLogEntry[];
}

export interface StartedRamlizer extends RamlizerInstance {
  server: http.Server;
}

export interface ScenarioConfigBody {
  method: string;
  route: string;
  nextResponseCode?: string;
  nextExampleName?: string;
}

export interface ScenarioConfigResponse {
  route: string;
  nextResponseCode?: string;
  oldResponseCode?: string;
  nextExampleName?: string;
  oldExampleName?: string;
}

export interface NormalizedExample {
  name: string;
  value: any;
}

export interface ResolvedTypeDefinition {
  name: string;
  type?: any;
  items?: any;
  properties?: Record<string, any>;
  examples?: any[];
  example?: any;
  structuredExample?: any;
}

/** A single named example (or synthesised payload) that a response can serve. */
export interface CatalogueExample {
  name: string;
  value: any;
}

/** One response code declared for an operation, with everything the admin UI needs to preview it. */
export interface CatalogueResponse {
  code: string;
  description?: string;
  contentTypes: string[];
  hasBody: boolean;
  examples: CatalogueExample[];
  /** Synthesised payload, present only when the response has a body but no explicit examples. */
  generated?: any;
}

/** One HTTP method on one route, as declared by a single RAML file. */
export interface CatalogueOperation {
  /** `${method}:${route}` – the same key used by the scenario planner. */
  key: string;
  method: string;
  route: string;
  specId: string;
  displayName?: string;
  description?: string;
  responses: CatalogueResponse[];
  defaultCode: string;
  defaultExample: string;
}

export interface SpecRecord {
  id: string;
  file: string;
  name: string;
  title?: string;
  version?: string;
  ramlVersion?: string;
  enabled: boolean;
  loadedAt: string;
  error?: string;
  warnings: string[];
  operations: CatalogueOperation[];
  json?: any;
  types: Record<string, any>;
}

export type SpecSummary = Omit<SpecRecord, "json" | "types" | "operations"> & {
  operationCount: number;
};

export interface OperationState extends CatalogueOperation {
  selectedCode: string;
  /** The example that will actually be served (falls back to the first example of the selected code). */
  selectedExample: string;
  modified: boolean;
  /** False when the spec is disabled or another enabled spec already serves this method + route. */
  active: boolean;
  shadowedBy?: string;
}

export interface RamlizerState {
  endpoint: string;
  specs: SpecSummary[];
  operations: OperationState[];
  lastReload?: string;
}

export interface ScenarioSelection {
  method: string;
  route: string;
  code?: string;
  example?: string;
}

export interface RequestLogEntry {
  id: number;
  time: string;
  method: string;
  path: string;
  route: string;
  status: number;
  example: string;
  specId?: string;
  contentType?: string;
}
