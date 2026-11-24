const watchInstructions = `Set up one dedicated inbox-watcher subagent for this Muse account if your tools support it. Reuse the same watcher across sessions. Give it the job of checking this relay every 1 minute while waiting for a reply or actively coordinating, and every 5 minutes when idle. Keep it separate from the agent doing the assigned work so it can receive new instructions during a long job.

For unattended checks, create or update one recurring Muse task called “Muse Relay inbox” that invokes the watcher. Use the closest supported cadence if a requested interval is unavailable. Verify the saved schedule in Upcoming or by listing active tasks, test one check, and tell the owner the actual interval and next run. If the account cannot run subagents, have the recurring task check the inbox itself. If scheduling is unavailable, check on activation and tell the owner this account is only monitored while active. Stop or change the watcher when the owner asks. Enable browser notifications in the relay if available and permission is granted. Keep the dashboard open to receive immediate browser alerts.

With a working API, fetch the inbox after this account’s saved cursor, drain all pages and deduplicate by message sequence. Advance the cursor after a durable handoff. Reuse request IDs on retries. In browser mode, check Conversations, open new or unread threads, and track which instructions you have already handled. When switching modes, check the existing thread before repeating work. Stay quiet on empty checks. Acknowledge instructions you accept, set Working when execution starts, and post results in the same thread.`;

export function connectorPrompt(origin, workspaceId, name) {
  return `Create a custom connector named Muse Relay for this Muse account. Use the REST API at ${origin}/api/v1 and the OpenAPI description at ${origin}/openapi.json. Use HTTP Bearer authentication. Read this account’s API key in its signed-in relay browser under Connection → Reveal API key, or use the key already saved during an API-only join. Enter the key in the connector’s secure credential field and send it only to ${origin}. Keep the key out of chat and relay messages.

Test the saved connector by calling getIdentity (GET ${origin}/api/v1/me) through the connector. Confirm the response names ${JSON.stringify(name)} in workspace ${workspaceId}. Then check the inbox. If setup or verification fails, tell me what happened and keep handling work in the signed-in relay dashboard.`;
}

export function workerPrompt(origin, workspaceId, name, invite) {
  const fragment = new URLSearchParams({ workspace: workspaceId, invite });
  return `Connect this Muse account to my Muse Relay workspace as ${JSON.stringify(name)}. Open ${origin}/#${fragment} in this account’s own browser profile and join. If you have already joined, reopen ${origin}/ in that profile. Keep the invite private.

As soon as you join, open Conversations and reply in the connection thread with the workspace master. Introduce yourself by name, say what you can do, and start reading assignments. If you already introduced yourself there, continue that thread.

Now send the following ready-to-use prompt to the human who invited you, in your private Muse chat with them, so they can add the custom connector now. The same text is available under Connection → Connector setup prompt. Send the setup text only.

--- Connector prompt for the user ---
${connectorPrompt(origin, workspaceId, name)}
--- End connector prompt ---

Use Connection → Reveal API key yourself to read the full key on screen. Hide it after entering it in the secure credential field. A clipboard is optional. If Muse asks the user to authorize the connector or enter the key privately, tell them the exact step and continue working while they do it.

Report the connection status in your relay thread with the master. Claim “connector verified” only after getIdentity succeeds through that connector for your account and workspace. If setup is pending or fails, say “I’m working through the dashboard. The API connector is pending because …” and give the actual reason or observed error, without secrets. If the cause is unknown, say which step failed. Keep using Conversations to receive instructions, acknowledge work, reply, and deliver results. Post an update in the same thread when the connector is verified.

${watchInstructions}

For an API-only first join, follow ${origin}/agent-guide.md and save the generated key before POST /api/v1/join. A browser join already registered this account’s key. Use that same key for the connector. Accept general instructions, conversation, documents, and links. For requested video work, return the shareable Drive viewer link in the thread.`;
}

export function mainPrompt(origin, workspaceId, key) {
  const fragment = new URLSearchParams({ workspace: workspaceId, key });
  return `Connect as the master of my Muse Relay workspace using this private link in your own browser profile: ${origin}/#${fragment}. Keep the master key private.

Use the account directory to invite each Muse with a separate setup prompt. Choose a curator for a lead Muse. Check the dashboard for joined and recently active accounts. You can inspect threads anywhere in your workspace, message its accounts, delegate instructions, and do work yourself. Report progress and deliver results in the originating thread.

For HTTP access to your own workspace, read ${origin}/agent-guide.md. If the API is unavailable, continue your work in the dashboard. Give each invited Muse its own setup prompt and credential.

${watchInstructions}`;
}
