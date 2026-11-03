import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import cp from "node:child_process";
import {
  createRamlizer,
  ramlResourcesToEndpoints,
  type RamlizerInstance
} from "../src/index";

interface HttpResponse {
  status: number | undefined;
  data: any;
  raw: string;
}

function request(
  options: http.RequestOptions,
  body?: any
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        ...options,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(options.headers || {})
        }
      },
      res => {
        let resData = "";
        res.on("data", chunk => (resData += chunk));
        res.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(resData);
          } catch {
            parsed = resData;
          }
          resolve({ status: res.statusCode, data: parsed, raw: resData });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("ramlResourcesToEndpoints", () => {
  test("adapts flat RAML resources into webapi-parser endpoint format", () => {
    const mockResources = [
      {
        relativeUri: "/users",
        methods: [
          {
            method: "POST",
            responses: { 200: {} }
          }
        ]
      }
    ];

    const endpoints = ramlResourcesToEndpoints(mockResources);
    assert.strictEqual(endpoints.length, 1);
    assert.strictEqual(endpoints[0].path.value(), "/users");
    assert.strictEqual(endpoints[0].operations.length, 1);

    const op = endpoints[0].operations[0];
    assert.strictEqual(op.method.value(), "post");
    assert.strictEqual(typeof op.withMethod, "function");

    op.withMethod("get");
    assert.strictEqual(op.method.value(), "get");
  });

  test("recursively adapts nested RAML resources with concatenated paths", () => {
    const mockResources = [
      {
        relativeUri: "/api",
        methods: [],
        resources: [
          {
            relativeUri: "/v1",
            methods: [
              {
                method: "GET",
                responses: { 200: {} }
              }
            ],
            resources: [
              {
                relativeUri: "/items",
                methods: [
                  {
                    method: "DELETE",
                    responses: { 204: {} }
                  }
                ]
              }
            ]
          }
        ]
      }
    ];

    const endpoints = ramlResourcesToEndpoints(mockResources);
    assert.strictEqual(endpoints.length, 2);
    assert.strictEqual(endpoints[0].path.value(), "/api/v1");
    assert.strictEqual(endpoints[0].operations[0].method.value(), "get");
    assert.strictEqual(endpoints[1].path.value(), "/api/v1/items");
    assert.strictEqual(endpoints[1].operations[0].method.value(), "delete");
  });

  test("handles empty or missing resource lists gracefully", () => {
    assert.deepStrictEqual(ramlResourcesToEndpoints([]), []);
    assert.deepStrictEqual(ramlResourcesToEndpoints(null), []);
    assert.deepStrictEqual(ramlResourcesToEndpoints(undefined), []);
  });
});

describe("ramlizer server integration", () => {
  let ramlizer: RamlizerInstance;
  let server: http.Server;
  const testPort = 8765;
  const exampleFolder = path.resolve(__dirname, "../example_raml");

  before(async () => {
    ramlizer = createRamlizer({ silent: true });
    ramlizer.startServer({ port: testPort, endpoint: "ramlizer" });
    await ramlizer.loadFolder(exampleFolder);
    server = await ramlizer.listen(testPort);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  });

  test("GET /unknown returns 404", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/non-existent",
      method: "GET"
    });
    assert.strictEqual(res.status, 404);
  });

  test("POST /login returns default 200 response with success", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/login",
      method: "POST"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { response: "success" });
  });

  test("POST /logout returns default 200 response", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/logout",
      method: "POST"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { response: "default" });
  });

  test("POST /ramlizer reconfigures /login scenario to 400 badPassword", async () => {
    const configRes = await request(
      {
        hostname: "localhost",
        port: testPort,
        path: "/ramlizer",
        method: "POST"
      },
      {
        route: "/login",
        method: "post",
        nextResponseCode: "400",
        nextExampleName: "badPassword"
      }
    );

    assert.strictEqual(configRes.status, 200);
    assert.deepStrictEqual(configRes.data, {
      route: "/login",
      nextResponseCode: "400",
      oldResponseCode: "200",
      nextExampleName: "badPassword",
      oldExampleName: "none"
    });

    const loginRes = await request({
      hostname: "localhost",
      port: testPort,
      path: "/login",
      method: "POST"
    });

    assert.strictEqual(loginRes.status, 400);
    assert.deepStrictEqual(loginRes.data, {
      errorList: [{ fieldName: "password" }]
    });
  });

  test("POST /ramlizer reconfigures /logout scenario to 400 badPassword", async () => {
    const configRes = await request(
      {
        hostname: "localhost",
        port: testPort,
        path: "/ramlizer",
        method: "POST"
      },
      {
        route: "/logout",
        method: "post",
        nextResponseCode: "400",
        nextExampleName: "badPassword"
      }
    );

    assert.strictEqual(configRes.status, 200);

    const logoutRes = await request({
      hostname: "localhost",
      port: testPort,
      path: "/logout",
      method: "POST"
    });

    assert.strictEqual(logoutRes.status, 400);
    assert.deepStrictEqual(logoutRes.data, {
      errorList: [{ failureType: "badPassword" }]
    });
  });
});

describe("ramlizer CLI process execution", () => {
  const cliPort = 8766;
  const exampleFolder = path.resolve(__dirname, "../example_raml");
  let child: cp.ChildProcess | undefined;

  after(() => {
    if (child && !child.killed) {
      child.kill();
    }
  });

  test("runs as standalone CLI and responds to HTTP requests", async () => {
    child = cp.spawn(
      process.execPath,
      [
        path.resolve(__dirname, "../dist/cli.js"),
        "--folder",
        exampleFolder,
        "--port",
        String(cliPort)
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("CLI process startup timed out"));
      }, 8000);

      child?.stderr?.on("data", chunk => {
        if (
          chunk.toString().includes("Listening on http://localhost:" + cliPort)
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });

      child?.on("error", err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const res = await request({
      hostname: "localhost",
      port: cliPort,
      path: "/login",
      method: "POST"
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { response: "success" });
  });
});
