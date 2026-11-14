# ramlizer

It's a strategizer for RAML.

## What?

More specifically it's an API mock service that supports the use of strategies, and allows configuration of the mocking service to follow specific strategies. For multiple RAML files, supporting version 1.0 of the RAML specification.

## Why?

Let's say you've got an API service with an endpoint. You've got some UI that displays differently depending on the response from that endpoint.

If your endpoint only behaves different due to backend changes, you don't have an easy way to trigger this from your UI, so how do you check your different UI states?

ramlizer solves this problem by letting you configure how a mock endpoint behaves, while the endpoint is still running. No stopping, changing conditions and restarting, it's all live and real-time.

## How?

ramlizer runs its own API alongside your mocked API (hopefully you don't have a `/ramlizer` endpoint!). Call this API to configure how your mocked API responds.

The POST endpoint takes four parameters in a JSON payload:

- route (The endpoint route to affect)
- method (The http method to affect)
- [nextResponseCode] (The next response code the endpoint should produce)
- [nextExampleName] (The next named example the endpoint should use)

Usually RAML endpoints only have one example, so how to define multiple ones?

#### Multiple RAML examples

We use the 'examples' attribute for for your endpoint responses. By default it will return the first of these. You can then select which example to run for the next call to the endpoint.

Here's an example of examples:

```raml
/login:
  post:
    responses:
      400:
        body:
          properties:
            errorList:
              type: object
              properties:
                fieldName:
                  type: string
                  example: 'field'
          examples:
            badUsername:
              errorList:
                -
                  fieldName: username
            badPassword:
              errorList:
                -
                  fieldName: password
```

And here's the JSON payload sent to ramlizer to select one of those examples:

```json
{
  "route": "/login",
  "method": "post",
  "nextResponseCode": "400",
  "nextExampleName": "badPassword"
}
```

And here's the JSON response when you call the `/login` endpoint:

```json
{
  "errorList": [
    {
      "fieldName": "password"
    }
  ]
}
```

#### Admin interface

Open **http://localhost:8080/ramlizer/** while ramlizer is running to switch scenarios from a browser instead of with `curl`:

- **Switch responses** – every endpoint lists each response code and named example declared in the RAML (plus "generated" for responses ramlizer synthesises). Click one and the very next call to that endpoint returns it.
- **Preview & try** – see the exact payload that will be served, and fire a real request at the mock from the page.
- **Switch RAML files** – turn whole files on or off. When two enabled files declare the same method and route, the one listed first serves it and the other is marked *shadowed*, so you can keep alternative versions of an API side by side and flip between them.
- **Reload RAML** – re-read the folder from disk to pick up edited, added or removed files without restarting.
- **Live requests** – a running log of calls to the mock, showing which status and example each one received.
- **Copy curl** – copies the configuration call for the current selection, ready to paste into a test script.

Pass `--no-ui` to turn the interface off; the API below stays available.

#### Admin API

The interface is built on a JSON API under the same endpoint (`/ramlizer` by default), which you can also call from test suites:

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| `GET` | `/ramlizer/api/state` | – | Loaded files, every operation with its responses and examples, and the current selection |
| `POST` | `/ramlizer/api/select` | `{ "method", "route", "code"?, "example"? }` or an array of them | Switch one or many endpoints. Unknown codes or example names return `400` |
| `POST` | `/ramlizer/api/reset` | `{}` or `{ "method", "route" }` | Restore defaults for everything, or for one endpoint |
| `POST` | `/ramlizer/api/spec` | `{ "id": "example_login.raml", "enabled": false }` | Turn a RAML file on or off |
| `POST` | `/ramlizer/api/reload` | `{}` | Re-read RAML files from disk |
| `GET` | `/ramlizer/api/log?since=<id>` | – | Mock requests received after `id` |

The original `POST /ramlizer` endpoint described above is unchanged.

The admin interface and API have no authentication, so only run ramlizer on networks you trust.

#### Multiple RAML files

If you add multiple files to the target RAML folder, Ramlizer will process them all and create multiple end-points from your files.

#### RAML specification support

Ramlizer supports RAML 1.0 specifications and provides backwards compatibility with RAML 0.8:
- **RAML 1.0 Data Types (`types:`)**: Reusable data models, type inheritance, array types (`type: Item[]`), union types, and property constraints. Examples and properties defined on types are automatically resolved and served.
- **Multiple & Single Examples**: Supports both named `examples:` (maps or lists) and single `example:` / `structuredExample` declarations on endpoints and custom types.
- **Auto-generated Mock Payloads**: When no explicit example is provided, Ramlizer synthesizes realistic mock responses from property declarations (handling strings, numbers, booleans, arrays, nested types, and enums).
- **RAML 0.8 Compatibility**: Supports legacy `#%RAML 0.8` specifications with `schemas:` and JSON examples.

#### Included Examples

The `example_raml/` folder contains ready-to-run specifications demonstrating these features:
- `example_login.raml`: RAML 1.0 endpoint with multiple named response examples (`badUsername`, `badPassword`).
- `example_logout.raml`: RAML 1.0 endpoint showing default response codes and example switching.
- `example_users.raml`: RAML 1.0 Data Types (`types:`), type inheritance (`AdminUser` extending `BaseUser`), type-level named examples (`CustomerUser` with `goldMember` and `silverMember`), array payloads (`Product[]`), and synthesized mock responses (`Product`).
- `example_legacy.raml`: Legacy RAML 0.8 specification with JSON Schema and example response running alongside RAML 1.0 files.

Run them live with:

```bash
npm run example
```

#### Script options

_--folder_

This option sets the destination folder where the Ramlizer script will look for RAML files.

_--port_

This option sets the port Ramlizer will use. By default this is '8080'.

_--endpoint_

This option sets the endpoint Ramlizer will use for its endpoint. By default this is 'ramlizer'.

_--no-ui_

Don't serve the graphical admin interface. The admin API is still available.
