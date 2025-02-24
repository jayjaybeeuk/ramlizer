#!/usr/bin/env node
const { argv } = require("yargs")
  .option("folder", {
    alias: "f",
    describe: "path to the raml files to mock",
    requiresArg: true,
    type: "string"
  })
  .demandOption("folder");

const _ = require("lodash");
const ora = require("ora");

const spinner = ora("Launching").start();

const http = require("node:http");
const ramlParser = require("raml-1-parser");
const osprey = require("osprey");
const resources = require("osprey-resources");
const finalhandler = require("finalhandler");
const morgan = require("morgan");
const bodyParser = require("body-parser");
const Negotiator = require("negotiator");
const cors = require("cors");

spinner.succeed();
spinner.start("Loading RAML");

const plannedMethodResponseCodes = {};
const plannedMethodExampleNames = {};

// Set up app
const app = osprey.Router();

// Set CORS
app.use(cors());

function mockHandler(handledRoute) {
  return (req, res) => {
    const { method } = handledRoute;
    const negotiator = new Negotiator(req);
    const route = req.route.path;

    const plannedMethodResponseCode =
      plannedMethodResponseCodes[`${method}:${route}`];

    const plannedResponse = handledRoute.responses[plannedMethodResponseCode];

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

function mockServer(raml) {
  return resources(raml.resources, mockHandler);
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
        const selectedExample =
          body.examples?.[0] ? body.examples[0].name : "none";

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

function parseRAML(file) {
  ramlParser
    .loadApi(file)
    .then(api => {
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
    })
    .catch(err => {
      console.log(err);
    });
}

const ramlFolder = String(argv.folder);
const fs = require("node:fs");

startServer(argv);

fs.readdir(argv.folder, (err, files) => {
  const ramlFiles = files.filter(el => /\.raml$/.test(el));

  for (const file of ramlFiles) {
    parseRAML(ramlFolder + file);
  }

  setTimeout(() => {
    portListener(argv);
  }, 4000);
});
