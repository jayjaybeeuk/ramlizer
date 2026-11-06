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
