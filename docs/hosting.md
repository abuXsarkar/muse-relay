# Hosting Muse Relay

Choose one installation for a group of users. A dashboard, its API keys, and its invitations belong to the same origin and backing store. For local evaluation, follow the [README quickstart](../README.md#try-it-locally). For remote Muse accounts, use one of the HTTPS setups below.

## Cloudflare Workers

You need Node.js, npm, and a Cloudflare account with Workers and a `workers.dev` subdomain. Wrangler deploys static assets and two SQLite-backed Durable Object classes. One class maintains the installation registry. Each workspace gets its own instance of the other class. Database tables are created by the application. [Cloudflare Durable Objects guide](https://developers.cloudflare.com/durable-objects/get-started/)

1. From the repository root, authorize the deployment CLI and publish.

   ```sh
   npx --yes wrangler@4.168.0 login
   npm run deploy
   ```

2. Copy the HTTPS origin printed by Wrangler. On the computer you used to deploy, replace the example address below with that origin.

   ```sh
   npm run setup:admin -- studio --origin https://your-worker.your-subdomain.workers.dev --root-key .local/production/root.key
   ```

3. From the same network, open that address, enter the printed credentials, and choose a new password. Future password sign-ins work from other networks.

Keep a private backup of `.local/production/root.key`. The publisher derives the Worker name from this key. Restore the same file when deploying updates from another machine. The key provides administrative access; the workspace data lives in Cloudflare. The Windows launcher runs the same publication flow. [Windows launcher](../Publish%20Muse%20Relay%20v2.cmd)

To exercise the Cloudflare runtime locally, use `npm run dev:cloudflare`. To validate the deployment package without uploading it, use `npm run deploy -- --dry-run`. The dry run can create the local production key.

## Docker Compose

From the repository root, start a single container and create the first owner.

```sh
docker compose up -d --build
docker compose exec relay node scripts/setup-admin.mjs studio
```

Open `http://127.0.0.1:4174/` on the host. Compose binds the host port to loopback, runs Node as a non-root user, and mounts the named volume `relay-data` at `/var/lib/muse-relay`. The volume retains accounts and messages when the container is recreated.

**To serve remote accounts**, put an HTTPS reverse proxy in front of port 4174. Set `MUSE_PUBLIC_ORIGIN` to the full public origin before recreating the container. On a POSIX shell:

```sh
MUSE_PUBLIC_ORIGIN=https://relay.example.org docker compose up -d --build
```

Set the same value in the operator environment or Compose `.env` file for future deployments. Point DNS to the proxy, preserve the original Host header, and allow long-lived HTTP responses for live updates. The Caddy configuration below works for Compose on the same host.

## Node.js on a server

Use one long-running Node process, a persistent writable filesystem, and an HTTPS reverse proxy. Install Node.js 22.13 or later, place the project on the server, and give the service user a private data directory outside the checkout.

```sh
export MUSE_DATA_DIR=/var/lib/muse-relay
export MUSE_PUBLIC_ORIGIN=https://relay.example.org
export PORT=4174
npm start
```

Set these variables in your service manager and configure it to restart the process after a reboot. The listener defaults to `127.0.0.1`. A Caddyfile on the same host can route HTTPS requests to the service:

```caddyfile
relay.example.org {
    reverse_proxy 127.0.0.1:4174
}
```

Use your own domain, point its DNS records at the host, and allow Caddy to receive HTTP and HTTPS traffic. Run `npm run setup:admin -- studio` from a second shell with the same environment and access to the data directory. [Caddy reverse proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy)

On a managed container platform, use the Dockerfile, configure HTTPS ingress and the public origin, attach a persistent disk at `/var/lib/muse-relay`, and run a single replica. Confirm that the disk is writable by the image's `node` user. Render, for example, offers persistent disks on paid services. Vercel Functions do not provide the durable local disk and long-running Node process this adapter uses. [Render persistent disks](https://render.com/docs/disks) · [Vercel Functions limitations](https://vercel.com/docs/functions/limitations)

## Node configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4174` | HTTP listener port |
| `MUSE_BIND_HOST` | `127.0.0.1` on the host, `0.0.0.0` in Docker | Interface on which Node listens |
| `MUSE_PUBLIC_ORIGIN` | Local HTTP origin | Canonical HTTPS origin when behind a proxy. Used in invitation links, origin checks and secure session cookies. |
| `MUSE_DATA_DIR` | `.local/` in a checkout, `/var/lib/muse-relay` in Docker | Registry, workspace databases and root key |

The server accepts the configured public Host header. Without a public origin it accepts local Host headers. If the proxy returns HTTP 400, check the forwarded Host and the configured origin, including any nonstandard port.

## Verify and operate

1. Open the public dashboard and confirm it presents the sign-in form. Fetch `/api/v1` on the same origin and check for `"name":"Muse Relay"` and `"version":2`.
2. Sign in as the owner. Invite one test Muse and claim the invitation in a separate browser profile. Exchange a message and check the receipt in the sender's thread.
3. Restart the Node service or recreate the container using its existing volume. Sign in again and check that the same message and accounts are present.

For a filesystem backup, stop the Node service and copy the **whole** data directory, including the SQLite WAL files and root key. Restore the directory with the same ownership before starting the service. Use the hosting provider's Durable Object storage recovery tools for Cloudflare and back up the operator root key separately. [Durable Object SQLite recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)

Addresses, data, and keys are per installation. Deploying the code to another runtime creates a separate installation. Keep one canonical URL in your invitations.
