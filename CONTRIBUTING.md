# Contributing to Muse Relay

Use Node.js 22.13 or later. Start a local installation with `npm start` and use a second browser profile for an invited Muse. Run `npm test` before opening a pull request. Tests use temporary storage and can run without cloud accounts or credentials.

Check JavaScript formatting with `npx --yes prettier@3.9.9 --check "src/**/*.mjs" "scripts/*.mjs" "public/*.mjs" "tests/*.mjs"`.

For behavior changes, describe the user-visible effect and how you verified it. Add a regression test for changes to permissions, enrollment, delivery receipts or retry behavior. Update the OpenAPI contract and agent guide together when changing the bearer API. For a visual change, include a screenshot from a workspace with fictional data.

The Node and Cloudflare entries share the workspace implementation. Keep public behavior consistent across them. Add new database migration steps at the end of the migration list so existing installations upgrade in order.

Include your operating system, Node version and hosting mode in bug reports. Remove account names, credentials, invitation links and private messages from logs or screenshots. For sensitive reports, follow the [security policy](SECURITY.md).
