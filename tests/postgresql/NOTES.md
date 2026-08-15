# PostgreSQL connector - not implemented yet

This folder is a placeholder, not a working connector. It intentionally has **no `meta.js`** -
`server.js`'s `discoverConnectors()` only treats a `tests/<name>/` folder as a real connector once one
exists, so this stays correctly invisible (no broken "0 scenarios" card) until real scenario files are
added.

## Verified Peaka connection shape

Confirmed live against Peaka's Partner API (`listConnectionConfig()`, 2026-08) - not guessed:

```json
{
  "connectionType": "POSTGRES",
  "authorizationType": "custom",
  "configuration": [
    { "fieldName": "url", "required": true },
    { "fieldName": "port", "required": true, "fieldType": "number" },
    { "fieldName": "user", "required": true },
    { "fieldName": "password", "required": true },
    { "fieldName": "databaseName", "required": true },
    { "fieldName": "useSsl", "required": true, "fieldType": "boolean" }
  ]
}
```

Note `connectionType` is the literal string `"POSTGRES"` (uppercase) - confirmed this is what
`createConnection({ type: ... })` needs. **Not yet confirmed**: what `catalogType` a real (non-built-in)
Postgres catalog reports back as - the one Postgres catalog visible in the test project during this
research (`54fnfKrM`) was Peaka's own built-in `peaka_postgres_test` demo catalog (`connectionId: null`,
not a real external connection), which is NOT necessarily the same string a genuinely-connected Postgres
catalog would use. The dashboard's connector-card matching (`server.js`'s
`/api/peaka/projects/:projectId/connectors`) keys off `catalogType`, so **before naming this folder**,
create one real Postgres connection+catalog in a test project and check its actual `catalogType` via
`listCatalogs()` - name the folder to match exactly (almost certainly `POSTGRES`, but verify rather than
assume, the same way this whole app's design so far has insisted on).

**Differs from Stripe/HubSpot in one structural way worth planning for**: `CONNECTOR_SPECS` in
`helpers/env.js` currently assumes a single credential value per connector (`tokenVar` - one env var,
e.g. `STRIPE_TEST_TOKEN`). Postgres needs six (`url`/`port`/`user`/`password`/`databaseName`/`useSsl`).
`checkCredentials()`/`buildFreshCtx()` will need to grow multi-field credential support (or a small
per-connector credential-builder function) before a real `tests/POSTGRES/g-connections.js` can call
`createConnection({ credential: { url, port, user, password, databaseName, useSsl } })` - this isn't a
copy-paste of the Stripe/HubSpot pattern the way HubSpot was from Stripe.

## Otherwise, follow the existing pattern

See the README's "Adding another connector" section, and use `tests/hubspot/` as the template (closer
match than Stripe - both are non-bearer-token credentials).
