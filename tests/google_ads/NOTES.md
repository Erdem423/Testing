# Google Ads connector - not implemented yet

This folder is a placeholder, not a working connector. It intentionally has **no `meta.js`** -
`server.js`'s `discoverConnectors()` only treats a `tests/<name>/` folder as a real connector once one
exists, so this stays correctly invisible (no broken "0 scenarios" card) until real scenario files are
added.

## Verified Peaka connection shape

Confirmed live against Peaka's Partner API (`listConnectionConfig()`, 2026-08) - not guessed:

```json
{
  "connectionType": "google_ads",
  "authorizationType": "oauth2_google_ads",
  "configuration": [
    { "fieldName": "refreshToken", "required": false },
    { "fieldName": "accessToken", "required": false },
    { "fieldName": "redirectUrl", "required": false },
    { "fieldName": "clientId", "required": false },
    { "fieldName": "clientSecret", "required": false },
    { "fieldName": "developerToken", "required": false },
    { "fieldName": "customerId", "required": true }
  ]
}
```

Folder should be named `tests/google_ads/` to match `connectionType` - this one's already right
(unlike Postgres's uppercase `POSTGRES`). `catalogType` for a real Google Ads catalog wasn't directly
observed in this research (no Google Ads catalog existed in the test project), but Stripe and HubSpot
both showed `catalogType === connectionType` exactly, so `"google_ads"` is a well-supported guess, not a
confirmed one - verify against a real `listCatalogs()` result before relying on it.

**OAuth2, like HubSpot, not a simple bearer token like Stripe.** Every credential field above is marked
`required: false` in Peaka's schema except `customerId` - matching the same pattern already seen for
HubSpot (`getConnectionConfig("hubspot")`, see `helpers/env.js`'s comments): the schema doesn't mark
`accessToken` required even though it's practically necessary. Expect the same kind of "which exact
value do I put here" discovery HubSpot needed (a Google Ads **refresh token** obtained via Google's own
OAuth flow is the most likely credential, given `developerToken`+`customerId` are also required for
Google Ads API access specifically) - this hasn't been confirmed accepted by Peaka the way HubSpot's was
eventually pinned down.

**Same structural gap as Postgres**: `CONNECTOR_SPECS` in `helpers/env.js` assumes one credential value
per connector (`tokenVar`). Google Ads needs multiple (`accessToken` + `developerToken` + `customerId` at
minimum). Needs the same `checkCredentials()`/`buildFreshCtx()` extension work as Postgres before a real
`tests/google_ads/g-connections.js` can be written - not a Stripe-style copy-paste.

## Otherwise, follow the existing pattern

See the README's "Adding another connector" section, and use `tests/hubspot/` as the template (both are
OAuth2-shaped credentials, unlike Stripe's simple bearer token).
