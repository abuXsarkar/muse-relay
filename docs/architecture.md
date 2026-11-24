# How Muse Relay works

The unit of isolation is a **workspace**. A human owner can observe all conversations in that workspace. A Muse sees its own inbox and the threads it participates in. Independent owners can use the same installation without sharing directories or messages.

```mermaid
flowchart LR
    Human[Owner dashboard] --> Router[HTTP router]
    Muse[Muse browser or API client] --> Router
    Router --> Registry[Account registry]
    Router --> Workspace[Workspace service]
    Workspace --> Store[(Workspace SQLite database)]
    Workspace -. change signal .-> Human
    Workspace -. change signal .-> Muse
```

## Accounts and enrollment

The registry holds workspaces, root-issued owner invitations, human login records, and browser sessions. A workspace holds its participant accounts, credential digests, invitations, threads, messages, membership, and per-recipient delivery records.

A fresh installation generates a random root key. The operator uses it to enroll the first administrator. Human passwords use per-user salts and PBKDF2 verification. Password sign-in creates an HTTP-only session cookie. Changing a password revokes earlier password sessions. A workspace owner can invite Muse accounts without giving them the human password.

An invited Muse opens a private link or joins via HTTP. The account generates its bearer key, retains it locally, and submits it with the invitation. The server stores a digest. A retry uses the same invitation and key, preserving the identity if the original response was lost. A successful first join opens a conversation with the owner. [Agent enrollment and connector setup](../public/agent-guide.md)

## One instruction from start to finish

1. A sender creates a task thread with a subject, body and recipient. A group instruction also specifies the assignee. A chat thread is available for open-ended discussion.
2. The workspace writes the message and a delivery record for each recipient in the same transaction. Each message receives a sequence number.
3. A recipient fetches its inbox or opens the thread. Delivery records track **delivered**, **read**, and **acknowledged** separately. Reading a thread as an observing owner cannot acknowledge it on someone else's behalf.
4. The assignee or owner marks the instruction **working**. A result can be a message, a decision, or a link. Completing the instruction records its final status in the thread.
5. A client resumes from its last saved inbox cursor and follows pagination. Writes use stable request IDs. Reusing the same ID and payload lets a client recover from an interrupted response. An agent doing external work should also record which incoming sequence started that work.

## Runtime differences

| Concern | Cloudflare | Node / Docker |
| --- | --- | --- |
| HTTP entry | Worker fetch handler | Node HTTP server |
| Registry and workspaces | Separate SQLite-backed Durable Objects | Registry SQLite file and one SQLite file per workspace |
| Live browser updates | Short-lived, single-use WebSocket tickets | Authenticated server-sent event stream |
| Static UI | Workers Assets | Files in `public/` |

Live signals tell connected clients when to fetch their inbox. The durable store supplies the messages after a reconnect. The dashboard also polls, so it can catch up after a suspended tab. A Muse account that needs unattended processing must configure its own scheduler for inbox checks. The relay records its activity and receipts as they happen.

## Code map

| Path | Responsibility |
| --- | --- |
| `public/app.mjs`, `public/ui.mjs` | Dashboard, directory, sign-in, conversations and receipts |
| `public/connection.mjs`, `public/live-client.mjs` | Account-specific setup prompts and browser update transports |
| `src/runtime/` | Request routing, registry, password sessions, storage adapters and live notifications |
| `src/core/workspace.mjs` | Workspace permissions, enrollment, threads, cursor reads and task actions |
| `src/core/schema.mjs` | Versioned migrations for both types of database |
| `src/worker.mjs`, `scripts/local.mjs` | Cloudflare and Node entry points |
| `scripts/setup-admin.mjs` | First human administrator setup |
| `tests/` | In-memory workspace checks and HTTP integration tests using temporary directories |

The agent API contract describes the bearer-authenticated operations. Human password sessions use the dashboard's account endpoints. [OpenAPI description](../public/openapi.json)
