import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import cp from "node:child_process";
import {
  createRamlizer,
  ramlResourcesToEndpoints,
  normalizeExampleValue,
  extractTypesMap,
  cleanTypeName,
  resolveTypeDefinition,
  extractExamples,
  generateMockResponse,
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

describe("RAML specification helpers", () => {
  test("normalizeExampleValue unpacks structuredValue, wrapped value, and parses JSON strings", () => {
    assert.strictEqual(normalizeExampleValue(null), null);
    assert.strictEqual(normalizeExampleValue(undefined), undefined);
    assert.strictEqual(normalizeExampleValue(123), 123);
    assert.strictEqual(normalizeExampleValue("plain text"), "plain text");

    // structuredValue wrapper
    assert.deepStrictEqual(
      normalizeExampleValue({ structuredValue: { foo: "bar" } }),
      { foo: "bar" }
    );

    // explicit value wrapper
    assert.deepStrictEqual(
      normalizeExampleValue({ strict: true, value: { id: 1 } }),
      { id: 1 }
    );

    // JSON encoded string
    assert.deepStrictEqual(
      normalizeExampleValue('{"key": "value", "count": 5}'),
      { key: "value", count: 5 }
    );
    assert.deepStrictEqual(
      normalizeExampleValue('[1, 2, 3]'),
      [1, 2, 3]
    );
  });

  test("cleanTypeName extracts clean type name, identifies array types, and handles unions", () => {
    assert.deepStrictEqual(cleanTypeName("User"), { typeName: "User", isArray: false });
    assert.deepStrictEqual(cleanTypeName(["User"]), { typeName: "User", isArray: false });
    assert.deepStrictEqual(cleanTypeName("User[]"), { typeName: "User", isArray: true });
    assert.deepStrictEqual(cleanTypeName(["User[]"]), { typeName: "User", isArray: true });
    assert.deepStrictEqual(cleanTypeName("Cat | Dog"), { typeName: "Cat", isArray: false });
    assert.deepStrictEqual(cleanTypeName(null), { typeName: "", isArray: false });
  });

  test("extractTypesMap and resolveTypeDefinition resolve inheritance across types", () => {
    const rawJson = {
      types: [
        {
          Base: {
            name: "Base",
            properties: { id: { name: "id", type: ["integer"] } }
          }
        },
        {
          Child: {
            name: "Child",
            type: ["Base"],
            properties: { name: { name: "name", type: ["string"] } },
            example: { id: 1, name: "Alice" }
          }
        }
      ]
    };

    const typesMap = extractTypesMap(rawJson);
    assert.ok(typesMap.Base);
    assert.ok(typesMap.Child);

    const resolved = resolveTypeDefinition("Child", typesMap);
    assert.ok(resolved);
    assert.strictEqual(resolved.name, "Child");
    assert.ok(resolved.properties?.id);
    assert.ok(resolved.properties?.name);
    assert.deepStrictEqual(resolved.example, { id: 1, name: "Alice" });
  });

  test("extractExamples resolves examples from body and referenced types", () => {
    const typesMap = {
      User: {
        name: "User",
        examples: [
          { name: "first", structuredValue: { id: 1 } },
          { name: "second", structuredValue: { id: 2 } }
        ]
      }
    };

    // Resolves from referenced type
    const fromType = extractExamples({ type: ["User"] }, typesMap);
    assert.strictEqual(fromType.length, 2);
    assert.strictEqual(fromType[0].name, "first");
    assert.deepStrictEqual(fromType[0].value, { id: 1 });
    assert.strictEqual(fromType[1].name, "second");
    assert.deepStrictEqual(fromType[1].value, { id: 2 });

    // Resolves array of referenced type
    const fromArrayType = extractExamples({ type: ["User[]"] }, typesMap);
    assert.strictEqual(fromArrayType.length, 2);
    assert.deepStrictEqual(fromArrayType[0].value, [{ id: 1 }]);

    // Direct body.examples takes precedence
    const override = extractExamples(
      {
        type: ["User"],
        examples: {
          custom: { id: 99 }
        }
      },
      typesMap
    );
    assert.strictEqual(override.length, 1);
    assert.strictEqual(override[0].name, "custom");
    assert.deepStrictEqual(override[0].value, { id: 99 });
  });

  test("generateMockResponse synthesizes mock values for properties and types", () => {
    const typesMap = {
      Address: {
        name: "Address",
        properties: {
          city: { name: "city", type: ["string"] },
          zip: { name: "zip", type: ["integer"] }
        }
      }
    };

    const mock = generateMockResponse(
      {
        properties: {
          name: { name: "name", type: ["string"] },
          age: { name: "age", type: ["integer"] },
          active: { name: "active", type: ["boolean"] },
          status: { name: "status", type: ["string"], enum: ["online", "offline"] },
          addr: { name: "addr", type: ["Address"] }
        }
      },
      typesMap
    );

    assert.strictEqual(mock.name, "name");
    assert.strictEqual(mock.age, 0);
    assert.strictEqual(mock.active, true);
    assert.ok(["online", "offline"].includes(mock.status));
    assert.deepStrictEqual(mock.addr, { city: "city", zip: 0 });
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

  test("GET /admins from example_raml returns typed AdminUser", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/admins",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
      id: 1,
      email: "admin@example.com",
      role: "superadmin",
      active: true
    });
  });

  test("GET /customers from example_raml returns goldMember and reconfigures to silverMember", async () => {
    const defaultRes = await request({
      hostname: "localhost",
      port: testPort,
      path: "/customers",
      method: "GET"
    });
    assert.strictEqual(defaultRes.status, 200);
    assert.deepStrictEqual(defaultRes.data, {
      id: 101,
      email: "gold@example.com",
      tier: "gold"
    });

    const configRes = await request(
      {
        hostname: "localhost",
        port: testPort,
        path: "/ramlizer",
        method: "POST"
      },
      {
        route: "/customers",
        method: "get",
        nextExampleName: "silverMember"
      }
    );
    assert.strictEqual(configRes.status, 200);

    const silverRes = await request({
      hostname: "localhost",
      port: testPort,
      path: "/customers",
      method: "GET"
    });
    assert.strictEqual(silverRes.status, 200);
    assert.deepStrictEqual(silverRes.data, {
      id: 102,
      email: "silver@example.com",
      tier: "silver"
    });
  });

  test("GET /products/catalog from example_raml returns array of typed mock products", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/products/catalog",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.strictEqual(res.data[0].sku, "sku");
    assert.strictEqual(res.data[0].stock, 0);
    assert.strictEqual(res.data[0].inStock, true);
  });

  test("GET /legacy/status from example_raml serves RAML 0.8 endpoint", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/legacy/status",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
      status: "operational",
      uptime: 86400
    });
  });
});

describe("RAML 1.0 advanced specification server integration", () => {
  let ramlizer: RamlizerInstance;
  let server: http.Server;
  let tmpDir: string;
  const testPort = 8767;

  const raml10Content = `#%RAML 1.0
title: RAML 1.0 Advanced Spec
version: v1
mediaType: application/json

types:
  BaseUser:
    properties:
      id: integer
      email: string
  AdminUser:
    type: BaseUser
    properties:
      role:
        type: string
        enum: [superadmin, moderator]
    example:
      id: 100
      email: admin@example.com
      role: superadmin
  CustomerUser:
    type: BaseUser
    properties:
      tier: string
    examples:
      goldCustomer:
        id: 200
        email: gold@example.com
        tier: gold
      silverCustomer:
        id: 201
        email: silver@example.com
        tier: silver
  Product:
    properties:
      sku: string
      stock: integer
      active: boolean
      category:
        enum: [electronics, books]

/admins:
  get:
    responses:
      200:
        body:
          type: AdminUser

/customers:
  get:
    responses:
      200:
        body:
          type: CustomerUser

/products:
  get:
    responses:
      200:
        body:
          type: Product

/product-list:
  get:
    responses:
      200:
        body:
          type: Product[]

/empty-status:
  get:
    responses:
      204:
`;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ramlizer-spec10-"));
    await fs.writeFile(path.join(tmpDir, "api.raml"), raml10Content, "utf8");

    ramlizer = createRamlizer({ silent: true });
    ramlizer.startServer({ port: testPort, endpoint: "ramlizer" });
    await ramlizer.loadFolder(tmpDir);
    server = await ramlizer.listen(testPort);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("GET /admins returns typed single example with inherited properties", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/admins",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
      id: 100,
      email: "admin@example.com",
      role: "superadmin"
    });
  });

  test("GET /customers returns first named example by default", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/customers",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
      id: 200,
      email: "gold@example.com",
      tier: "gold"
    });
  });

  test("POST /ramlizer reconfigures typed endpoint example", async () => {
    const configRes = await request(
      {
        hostname: "localhost",
        port: testPort,
        path: "/ramlizer",
        method: "POST"
      },
      {
        route: "/customers",
        method: "get",
        nextExampleName: "silverCustomer"
      }
    );

    assert.strictEqual(configRes.status, 200);
    assert.strictEqual(configRes.data.nextExampleName, "silverCustomer");

    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/customers",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
      id: 201,
      email: "silver@example.com",
      tier: "silver"
    });
  });

  test("GET /products generates mock response with types, booleans, integers and enums", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/products",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.sku, "sku");
    assert.strictEqual(res.data.stock, 0);
    assert.strictEqual(res.data.active, true);
    assert.ok(["electronics", "books"].includes(res.data.category));
  });

  test("GET /product-list returns array of typed mock objects", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/product-list",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.strictEqual(res.data.length, 1);
    assert.strictEqual(res.data[0].sku, "sku");
    assert.strictEqual(res.data[0].stock, 0);
  });

  test("GET /empty-status produces 204 response", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/empty-status",
      method: "GET"
    });
    assert.strictEqual(res.status, 204);
  });
});

describe("RAML 0.8 specification compatibility", () => {
  let ramlizer: RamlizerInstance;
  let server: http.Server;
  let tmpDir: string;
  const testPort = 8768;

  const raml08Content = `#%RAML 0.8
title: Legacy RAML 0.8 API
version: v0.8
schemas:
  - UserSchema: |
      {
        "$schema": "http://json-schema.org/draft-04/schema#",
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "username": { "type": "string" }
        }
      }
/legacy-user:
  get:
    responses:
      200:
        body:
          application/json:
            schema: UserSchema
            example: |
              {
                "id": 42,
                "username": "retro_dev"
              }
`;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ramlizer-spec08-"));
    await fs.writeFile(path.join(tmpDir, "legacy.raml"), raml08Content, "utf8");

    ramlizer = createRamlizer({ silent: true });
    ramlizer.startServer({ port: testPort, endpoint: "ramlizer" });
    await ramlizer.loadFolder(tmpDir);
    server = await ramlizer.listen(testPort);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("GET /legacy-user successfully serves parsed JSON example from RAML 0.8", async () => {
    const res = await request({
      hostname: "localhost",
      port: testPort,
      path: "/legacy-user",
      method: "GET"
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
      id: 42,
      username: "retro_dev"
    });
  });
});

describe("ramlizer CLI process execution", () => {
  const cliPort = 8766;
  let child: cp.ChildProcess | null = null;
  const exampleFolder = path.resolve(__dirname, "../example_raml");

  before(async () => {
    const cliPath = path.resolve(__dirname, "../dist/cli.js");

    child = cp.spawn(
      process.execPath,
      [cliPath, "--folder", exampleFolder, "--port", String(cliPort)],
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
  });

  after(async () => {
    if (child) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => {
        child?.on("exit", () => resolve());
        setTimeout(resolve, 1000);
      });
    }
  });

  test("runs as standalone CLI and responds to HTTP requests", async () => {
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
