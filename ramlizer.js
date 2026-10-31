#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import bodyParser from "body-parser";
import cors from "cors";
import finalhandler from "finalhandler";
import _ from "lodash";
import morgan from "morgan";
import Negotiator from "negotiator";
import ora from "ora";
import osprey from "osprey";
import ramlParser from "raml-1-parser";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("folder", {
    alias: "f",
    describe: "path to the raml files to mock",
    requiresArg: true,
    type: "string"
  })
  .option("port", {
    alias: "p",
    describe: "port to listen on",
    requiresArg: true,
    type: "number"
  })
  .option("endpoint", {
    alias: "e",
    describe: "endpoint used to configure the mock responses",
    requiresArg: true,
    type: "string"
  })
  .demandOption("folder")
  .parse();

const spinner = ora("Launching").start();

spinner.succeed();
spinner.start("Loading RAML");

const plannedMethodResponseCodes = {};
const plannedMethodExampleNames = {};

// Set up app
const app = osprey.Router();

// Set CORS
app.use(cors());

function mockHandler(handledMethod) {
  return (req, res) => {
    const { method } = handledMethod;
    const negotiator = new Negotiator(req);
    const route = req.route.path;

    const plannedMethodResponseCode =
      plannedMethodResponseCodes[`${method}:${route}`];

    const plannedResponse = handledMethod.responses[plannedMethodResponseCode];

    const bodies = plannedResponse.body;
    const types = Object.keys(bodies);
    const type = negotiator.mediaType(types);
    const body = bodies[type];
    const { properties } = body;

    let response = {};

    if (body.examples) {
      const plannedExampleName =
        plannedMethodExampleNames[`${method}:${route}`];

      let plannedExample = body.examples.find(example => {
        return example.name === plannedExampleName;
      });

      if (!plannedExample) {
        plannedExample = _.sample(body.examples);
      }

      Object.assign(response, plannedExample.structuredValue);
    } else if (body.example) {
      response = body.example;
    } else {
      _.each(properties, property => {
        response[property.name] = "";

        if (property.enum) {
          response[property.name] = _.sample(property.enum);
        }
      });
    }

    res.write(JSON.stringify(response));
    res.end();
  };
}

/**
 * Register every method of every (nested) RAML resource on the router.
 *
 * `osprey-resources` 1.0.0 moved to the AML model, so the equivalent
 * routing for the JSON produced by `raml-1-parser` lives here instead.
 */
function addResources(router, resources, handler, prefix = "") {
  for (const resource of resources || []) {
    const route = prefix + (resource.relativeUri || "");

    for (const method of resource.methods || []) {
      const handle = handler(method, route);

      // Enables the ability to skip a handler by returning null.
      if (handle) {
        router[method.method](route, handle);
      }
    }

    addResources(router, resource.resources, handler, route);
  }

  return router;
}

function mockServer(raml) {
  return addResources(osprey.Router(), raml.resources, mockHandler);
}

function scenarioConfigurator(req, res) {
  const { method, nextExampleName, nextResponseCode, route } = req.body;
  const response = {
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

  res.write(JSON.stringify(response));

  res.end();
}

function fillStrategies(api) {
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

        plannedMethodResponseCodes[
          `${method.method()}:${resource.completeRelativeUri()}`
        ] = selectedCode;

        plannedMethodExampleNames[
          `${method.method()}:${resource.completeRelativeUri()}`
        ] = selectedExample;

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

function startServer(argv) {
  const port = argv.port ? argv.port : 8080;
  const endpoint = argv.endpoint ? argv.endpoint : "ramlizer";

  app.use(morgan("combined"));
  app.use(bodyParser.json());
  app.post(`/${endpoint}`, scenarioConfigurator);

  spinner.succeed();
  spinner.start(
    `Listening for configuration requests on http://localhost:${port}/${endpoint}`
  );
}

function applyRAML(raml, file) {
  // Start servers
  spinner.succeed();
  spinner.start(`Creating HTTP mock services for ${file}`);

  app.use(mockServer(raml));
  app.use(osprey.errorHandler());
}

function portListener(argv) {
  spinner.succeed();
  spinner.start("Launching HTTP server");
  const server = http.createServer((req, res) => {
    app(req, res, finalhandler(req, res));
  });
  const port = argv.port ? argv.port : 8080;

  server.listen(port, () => {
    spinner.succeed();
    spinner.info(`Listening on http://localhost:${port}`);
  });
}

async function parseRAML(file) {
  try {
    const api = await ramlParser.loadApi(file);

    spinner.succeed();
    spinner.start("Filling strategy queues");

    fillStrategies(api);

    // Apply RAML strategies to server
    applyRAML(
      api.expand(true).toJSON({
        serializeMetadata: false
      }),
      file
    );
  } catch (err) {
    spinner.fail(`Unable to parse ${file}`);
    console.log(err);
  }
}

startServer(argv);

try {
  const ramlFolder = String(argv.folder);
  const files = await readdir(ramlFolder);
  const ramlFiles = files.filter(file => /\.raml$/.test(file));

  await Promise.all(
    ramlFiles.map(file => parseRAML(path.join(ramlFolder, file)))
  );

  portListener(argv);
} catch (err) {
  spinner.fail(`Unable to read RAML files from ${argv.folder}`);
  console.log(err);
  process.exitCode = 1;
}
