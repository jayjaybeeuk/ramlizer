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
  ScenarioConfigResponse
} from "./types";

export * from "./types";

const ora = (oraModule as any)?.default || oraModule;

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
      const body = (type ? bodies[type] : Object.values(bodies)[0]) || {};
      const { properties } = body;

      let response: any = {};

      if (body.examples) {
        const plannedExampleName =
          plannedMethodExampleNames[`${method}:${route}`];

        let plannedExample = body.examples.find((example: any) => {
          return example.name === plannedExampleName;
        });

        if (!plannedExample) {
          plannedExample = _.sample(body.examples);
        }

        Object.assign(response, plannedExample.structuredValue);
      } else if (body.example) {
        response = body.example;
      } else {
        _.each(properties, (property: any) => {
          response[property.name] = "";

          if (property.enum) {
            response[property.name] = _.sample(property.enum);
          }
        });
      }

      res.statusCode = Number(plannedMethodResponseCode) || 200;
      if (type) {
        res.setHeader("Content-Type", type);
      }
      res.write(JSON.stringify(response));
      res.end();
    };
  }

  function mockServer(raml: any) {
    const endpoints = ramlResourcesToEndpoints(raml.resources);
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

  function fillStrategies(api: any) {
    for (const resource of api.allResources()) {
      if (resource.methods().length === 0) {
        spinner.info(
          `${resource.completeRelativeUri()} has no methods, skipping`
        );
        continue;
      }

      for (const method of resource.methods()) {
        spinner.succeed(
          `${resource.completeRelativeUri()} has method ${method.method()}`
        );

        if (method.responses().length === 0) {
          spinner.warn(
            `${resource.completeRelativeUri()}:${method.method()} has no responses, skipping`
          );
          continue;
        }

        for (const response of method.responses()) {
          spinner.succeed(
            `${resource.completeRelativeUri()}:${method.method()} will produce a '${response
              .code()
              .value()}' response code`
          );

          const bodies = response.toJSON().body;

          if (!bodies) {
            spinner.warn(
              `${resource.completeRelativeUri()}:${method.method()} has no body, skipping`
            );
            continue;
          }

          if (_.size(bodies) > 1) {
            spinner.warn(
              `${resource.completeRelativeUri()}:${method.method()} has multiple body types, picking the first`
            );
          }

          const body = bodies[Object.keys(bodies)[0]];

          if (!body.examples) {
            spinner.warn(
              `${resource.completeRelativeUri()}:${method.method()}:${response
                .code()
                .value()} has no examples, skipping`
            );
          }

          // Set defaults to be 200 response code and first example
          const selectedCode = response.code().value();
          const selectedExample = body.examples?.[0]
            ? body.examples[0].name
            : "none";

          const routeKey = `${method.method()}:${resource.completeRelativeUri()}`;
          if (!plannedMethodResponseCodes[routeKey] || selectedCode === "200") {
            plannedMethodResponseCodes[routeKey] = selectedCode;
            plannedMethodExampleNames[routeKey] = selectedExample;
          }

          if (body.examples) {
            // Loop through examples
            for (const example of body.examples) {
              spinner.succeed(
                `${resource.completeRelativeUri()}:${method.method()}:${response
                  .code()
                  .value()} contains an example named '${example.name}'`
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
        fillStrategies(api);
        applyRAML(
          api.expand(true).toJSON({
            serializeMetadata: false
          }),
          file
        );
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
