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
const socket = require("socket.io");
const express = require("express");
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
const allResources = [];

// Set up app
const app = osprey.Router();

// Set CORS
app.use(cors());

// socket server
const appex = express();
const server = appex.listen(3200, function () {
  spinner.succeed(`Socket Server Listening on port ${3200}`);
});
// Socket setup
const io = socket(server);

let sequenceNumberByClient = new Map();
// event fired every time a new client connects:
io.on("connection", (socket) => {
  io.emit("server:info",
    `Client connected [id=${socket.id}]`
  );
  console.info(`Client connected [id=${socket.id}]`);
  // initialize this client's sequence number
  sequenceNumberByClient.set(socket, 1);

  // when socket disconnects, remove it from the list:
  socket.on("disconnect", () => {
    sequenceNumberByClient.delete(socket);
    io.emit("server:info",
      `Client disconnected [id=${socket.id}]`
    );
    console.info(`Client gone [id=${socket.id}]`);
  });
});

function mockHandler(handledRoute) {
  return (req, res) => {
    const { method } = handledRoute;
    const negotiator = new Negotiator(req);
    const route = req.route.path;

    io.emit("server:info",
      'received ' + method
    );

    const plannedMethodResponseCode =
      plannedMethodResponseCodes[`${method}:${route}`];

    const plannedResponse = handledRoute.responses[plannedMethodResponseCode];
    //console.log('plannedMethodResponseCode', plannedMethodResponseCode);
    //console.log('plannedResponse 1', plannedResponse);
    //console.log('plannedResponse 2', plannedResponse.body);
    //console.log('plannedMethodExampleNames 2', plannedMethodExampleNames);
    //console.log('plannedResponse 3', plannedResponse.body.type);

    const bodies = plannedResponse.body;
    const types = Object.keys(bodies);
    const type = negotiator.mediaType(types);
    const body = bodies[type];
    const { properties } = body;
    //console.log('plannedResponse 3', body);
    let response = {};

    if (body.examples) {
      const plannedExampleName =
        plannedMethodExampleNames[`${method}:${route}`];
      //console.log('plannedExampleName1', plannedExampleName);
      let plannedExample = body.examples.find(example => {
        //console.log('example', example.name);
        //console.log('plannedExampleName2', plannedExampleName);

        return example.name === plannedExampleName;
      });

      //console.log('plannedMethodExampleNames 3', plannedMethodExampleNames);
      //console.log('planned example ==== ', plannedExample);

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

    res.statusCode = plannedResponse.code;
    //console.log('plannedResponse.code', plannedResponse.code)
    io.emit("server:info",
      route + ' ' + method.toUpperCase() + ' ' + JSON.stringify(response)
    );
    let item = {};
    item.url = route;
    item.code = plannedResponse.code;
    item.method = method.toUpperCase();
    io.emit("server:route",
      item
    );
    setTimeout(function () {
      res.write(JSON.stringify(response));
      res.end();
    }, 1);
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

  io.emit("server:info",
    'received ' + method
  );

  //console.log('route', Object.values(route)[0])
  //console.log('nextExampleName ', nextExampleName)

  if (nextResponseCode) {
    const oldResponseCode =
      plannedMethodResponseCodes[`${method}:${route}`] || "none";
    plannedMethodResponseCodes[`${method}:${route}`] = nextResponseCode;

    response.nextResponseCode = nextResponseCode;
    response.oldResponseCode = oldResponseCode;
  }

  if (nextExampleName) {
    const oldExampleName =
      plannedMethodExampleNames[`${method}:${Object.values(route)[0]}`] || "none";
    plannedMethodExampleNames[`${method}:${Object.values(route)[0]}`] = Object.values(nextExampleName)[0];

    //console.log('nextExampleName> ', Object.values(nextExampleName)[0]);

    response.nextExampleName = Object.values(nextExampleName)[0];
    response.oldExampleName = oldExampleName;
  }

  io.emit("server:info",
    JSON.stringify(response)
  );
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
      let item = {};

      spinner.succeed(
        `${resource.completeRelativeUri()} has method ${method.method()}`
      );
      io.emit("server:info",
        `${resource.completeRelativeUri()} has method ${method.method()}`
      );

      if (method.responses().length === 0) {
        spinner.warn(
          `${resource.completeRelativeUri()}:${method.method()} has no responses, skipping`
        );
        io.emit("server:info",
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
        io.emit("server:info",
          `${resource.completeRelativeUri()}:${method.method()} will produce a '${response
            .code()
            .value()}' response code`
        );


        // update allResources
        item.method = method.method();
        item.url = resource.completeRelativeUri();
        item.code = response.code().value();

        //console.log('allResources ', allResources);

        const bodies = response.toJSON().body;

        if (!bodies) {
          spinner.warn(
            `${resource.completeRelativeUri()}:${method.method()} has no body, skipping`
          );
          io.emit("server:info",
            `${resource.completeRelativeUri()}:${method.method()} has no body, skipping`
          );
          return;
        }

        if (_.size(bodies) > 1) {
          spinner.warn(
            `${resource.completeRelativeUri()}:${method.method()} has multiple body types, picking the first`
          );
          io.emit("server:info",
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
          io.emit("server:info",
            `${resource.completeRelativeUri()}:${method.method()}:${response
              .code()
              .value()} has no examples, skipping`);
        }

        // Set defaults to be 200 response code and first example
        let examples = [];
        const selectedCode = response.code().value();
        const selectedExample =
          body.examples && body.examples[0] ? body.examples[0].name : "none";// hardcode to first

        plannedMethodResponseCodes[
          `${method.method()}:${resource.completeRelativeUri()}`
        ] = selectedCode;

        plannedMethodExampleNames[
          `${method.method()}:${resource.completeRelativeUri()}`
        ] = selectedExample;

        //console.log('plannedMethodExampleNames', plannedMethodExampleNames);

        if (body.examples) {
          // Loop through examples
          _.each(body.examples, example => {
            spinner.succeed(
              `${resource.completeRelativeUri()}:${method.method()}:${response
                .code()
                .value()} contains an example named '${example.name}'`
            );
            io.emit("server:info",
              `${resource.completeRelativeUri()}:${method.method()}:${response
                .code()
                .value()} contains an example named '${example.name}'`);
            examples.push(example.name);
          });
        }
        item.examples = examples;
        allResources.push(item);
      });
    });
  });
}

// output all resources to an array
function resourcesObj(req, res) {
  io.emit('server:api', JSON.stringify(allResources))

  res.statusCode = 200;
  res.write(JSON.stringify(allResources));
  res.end();
}

function startServer(argv) {
  const port = argv.port ? argv.port : 8080,
    endpoint = argv.endpoint ? argv.endpoint : "ramlizer";

  app.use(morgan("combined"));
  app.use(bodyParser.json());
  app.put(`/${endpoint}`, scenarioConfigurator);
  app.post(`/${endpoint}`, scenarioConfigurator);
  app.patch(`/${endpoint}`, scenarioConfigurator);
  app.post('/api/toObj', resourcesObj);

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
