import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, "..");
const fixtures = path.join(testDirectory, "fixtures");

let port;
let server;
let serverOutput = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port: availablePort } = probe.address();
      probe.close(() => resolve(availablePort));
    });
  });
}

async function waitForOutput(expected, timeout = 20000) {
  const startedAt = Date.now();

  while (!serverOutput.includes(expected)) {
    if (Date.now() - startedAt > timeout) {
      throw new Error(
        `Timed out waiting for '${expected}'.\nServer output:\n${serverOutput}`
      );
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function configure(body) {
  const response = await fetch(`http://localhost:${port}/ramlizer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  assert.equal(response.status, 200);

  return response.json();
}

async function mock(method, route) {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : "{}"
  });

  return { response, body: await response.json() };
}

before(async () => {
  port = await freePort();

  server = spawn(
    process.execPath,
    [
      path.join(projectRoot, "ramlizer.js"),
      "--folder",
      fixtures,
      "--port",
      String(port)
    ],
    { cwd: projectRoot }
  );

  server.stdout.on("data", chunk => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", chunk => {
    serverOutput += chunk.toString();
  });

  await waitForOutput(`Listening on http://localhost:${port}`);
});

after(() => {
  server?.kill();
});

test("mocks the last response code of a method by default", async () => {
  const { response, body } = await mock("POST", "/login");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(body, { errorList: [{ fieldName: "userName" }] });
});

test("switches response code and example at runtime", async () => {
  const configured = await configure({
    route: "/login",
    method: "post",
    nextResponseCode: "400",
    nextExampleName: "badPassword"
  });

  assert.equal(configured.nextResponseCode, "400");
  assert.equal(configured.nextExampleName, "badPassword");

  const { body } = await mock("POST", "/login");

  assert.deepEqual(body, { errorList: [{ fieldName: "password" }] });
});

test("samples property enums when a response has no examples", async () => {
  await configure({
    route: "/login",
    method: "post",
    nextResponseCode: "200"
  });

  const { body } = await mock("POST", "/login");

  assert.deepEqual(body, { response: "success" });
});

test("routes RAML resources with uri parameters", async () => {
  const { response, body } = await mock("GET", "/users/42");

  assert.equal(response.status, 200);
  assert.deepEqual(body, { id: "" });
});

test("routes nested RAML resources", async () => {
  const { response, body } = await mock("GET", "/users/42/posts");

  assert.equal(response.status, 200);
  assert.deepEqual(body, { postId: "" });
});

test("returns 404 for routes that are not in the RAML", async () => {
  const response = await fetch(`http://localhost:${port}/unknown`);

  assert.equal(response.status, 404);
});
