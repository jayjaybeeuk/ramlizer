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
