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

const http = require("http");
const ramlParser = require("raml-1-parser");
const osprey = require("osprey");
const resources = require("osprey-resources");
const finalhandler = require("finalhandler");
const morgan = require("morgan");
const bodyParser = require("body-parser");
const Negotiator = require("negotiator");

spinner.succeed();
spinner.start("Loading RAML");

const plannedMethodResponseCodes = {};
const plannedMethodExampleNames = {};

// Set up app
const app = osprey.Router();

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

    const response = {};

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
    } else {
      _.each(properties, property => {
        response[property.name] = "";

        if (property.enum) {
          response[property.name] = _.sample(property.enum);
        }
      });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");

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
  api.allResources().forEach(resource => {
    if (resource.methods().length === 0) {
      spinner.info(
        `${resource.completeRelativeUri()} has no methods, skipping`
      );
      return;
    }

    resource.methods().forEach(method => {
      spinner.succeed(
        `${resource.completeRelativeUri()} has method ${method.method()}`
      );

      if (method.responses().length === 0) {
        spinner.warn(
          `${resource.completeRelativeUri()}:${method.method()} has no responses, skipping`
        );
        return;
      }

      method.responses().forEach(response => {
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
          return;
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

        // Loop through examples
        _.each(body.examples, example => {
          spinner.succeed(
            `${resource.completeRelativeUri()}:${method.method()}:${response
              .code()
              .value()} contains an example named '${example.name}'`
          );

          let selectedCode = "200";

          // if (!method.method().responses["200"]) {
          //   selectedCode = _.sample(method.method().responses).code;
          // }

          plannedMethodResponseCodes[
            `${method.method()}:${resource.completeRelativeUri()}`
          ] = selectedCode;

          plannedMethodExampleNames[
            `${method.method()}:${resource.completeRelativeUri()}`
          ] = "default";
        });
      });
    });
  });
}

function startServer(argv) {
  const port = argv.port ? argv.port : 8080,
    endpoint = argv.endpoint ? argv.endpoint : "ramlizer";

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
const fs = require("fs");

startServer(argv);

fs.readdir(argv.folder, function (err, files) {
  const ramlFiles = files.filter(el => /\.raml$/.test(el));

  ramlFiles.forEach(file => {
    parseRAML(ramlFolder + file);
  });

  setTimeout(function () {
    portListener(argv);
  }, 4000);
});
