import { connectorPrompt, mainPrompt, workerPrompt } from './connection.mjs';
import { watchLive } from './live-client.mjs';
import {
  $,
  button,
  date,
  dialog,
  element,
  field,
  formAction,
  input,
  messageBody,
  notice,
  privateText,
  select,
  showError,
} from './ui.mjs';

const prefix = 'muse-relay.v2.';
const types = {
  root: /^mrr_[a-f0-9]{64}$/,
  master: /^mrm_[a-f0-9]{64}$/,
  key: /^mrk_([a-f0-9]{16})_[a-f0-9]{64}$/,
  invite: /^mri_([a-f0-9]{16})_[a-f0-9]{64}$/,
};
let session;
let pollTimer;
let readTimer;
let stopLive = () => {};

function hex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
async function fingerprint(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}
function credential(text) {
  const value = text.trim();
  if (!value.includes('#')) return value;
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin) throw new Error('Use an invitation from this relay.');
  const params = new URLSearchParams(url.hash.slice(1));
  return params.get('master') || params.get('invite') || params.get('key') || '';
}

async function api(path, { key = '', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: 'no-store',
    redirect: 'error',
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : data.message || 'Relay request failed (HTTP ' + response.status + ').',
    );
  return data;
}
function workspaceCall(s, path, body) {
  return api(path, { key: s.key, body, signal: s.controller.signal });
}

async function retryable(s, purpose, inputs, create, send, store = sessionStorage) {
  const id = prefix + 'pending.' + (await fingerprint(JSON.stringify([s, purpose, inputs])));
  const saved = store.getItem(id);
  const data = saved ? JSON.parse(saved) : create();
  if (!saved) store.setItem(id, JSON.stringify(data));
  const result = await send(data);
  store.removeItem(id);
  return result;
}

function loginKind() {
  let value = '';
  try {
    value = credential($('credential').value);
  } catch {}
  const claim = types.master.test(value);
  $('claim-field').hidden = !claim;
  $('claim-name').required = claim;
  $('connect').textContent = claim
    ? 'Create my workspace'
    : types.invite.test(value)
      ? 'Join workspace'
      : 'Connect to workspace';
}
async function authenticate(value, name, account = null) {
  let claimedAccount;
  if (types.master.test(value)) {
    const identity = await retryable(
      value,
      'master-claim',
      [],
      () => ({ secret: hex(), name }),
      async (pending) => {
        const result = await api('master/join', { body: { invite: value, ...pending } });
        localStorage.setItem(prefix + 'key', result.key);
        claimedAccount = await api('me', { key: result.key });
        return result;
      },
      localStorage,
    );
    value = identity.key;
  } else if (types.invite.test(value)) {
    const workspace = types.invite.exec(value)[1];
    value = await retryable(
      value,
      'agent-claim',
      [],
      () => ({ key: 'mrk_' + workspace + '_' + hex() }),
      async (pending) => {
        claimedAccount = await api('join', { body: { invite: value, key: pending.key } });
        localStorage.setItem(prefix + 'key', pending.key);
        return pending.key;
      },
      localStorage,
    );
  }
  const root = types.root.test(value);
  if (!account && !root && !types.key.test(value))
    throw new Error('Enter a valid relay key or invitation.');
  const who = claimedAccount || (await api(root ? 'root' : 'me', { key: value }));
  const s = {
    key: value,
    root,
    account,
    me: who,
    slot: root ? prefix + 'root.' : prefix + who.workspaceId + '.' + who.id + '.',
    agents: [],
    threads: [],
    selected: null,
    selectedRequest: 0,
    items: [],
    tab: 'threads',
    controller: new AbortController(),
    syncing: false,
    queued: false,
    readPending: false,
  };
  session = s;
  if (root) sessionStorage.setItem(prefix + 'root', value);
  else {
    sessionStorage.removeItem(prefix + 'root');
    if (account) localStorage.removeItem(prefix + 'key');
    else localStorage.setItem(prefix + 'key', value);
  }
  sessionStorage.removeItem(prefix + 'incoming');
  $('credential').value = '';
  $('claim-name').value = '';
  $('access-error').textContent = '';
  $('access').hidden = true;
  $('identity').hidden = false;
  $('identity-name').textContent = root ? 'Root administrator' : who.name;
  $('settings').textContent = account ? 'Account' : 'Connection';
  $('add-user').hidden = !account?.admin;
  $('root').hidden = !root;
  $('workspace').hidden = root;
  if (root) {
    renderRoot(who);
    return;
  }
  $('workspace-caption').textContent =
    who.role === 'master' ? 'Master workspace' : who.name + ' · ' + who.role;
  setTab('threads');
  renderDetailEmpty();
  stopLive = watchLive({
    origin: location.origin,
    key: value,
    workspaceId: who.workspaceId,
    onChange: () => scheduleSync(s),
  });
  await sync(s);
}

async function disconnect() {
  const s = session;
  if (!s) return;
  if (s.account) await api('auth/logout', { body: {} });
  stopLive();
  stopLive = () => {};
  s.controller.abort();
  clearTimeout(pollTimer);
  clearTimeout(readTimer);
  clearTimeout(s.hintTimer);
  if (s.root) sessionStorage.removeItem(prefix + 'root');
  else localStorage.removeItem(prefix + 'key');
  for (const name of Object.keys(sessionStorage)) {
    if (name.startsWith(s.slot + 'invite.') || name.startsWith(s.slot + 'draft.'))
      sessionStorage.removeItem(name);
  }
  session = undefined;
  $('modal').close();
  $('workspace').hidden = $('identity').hidden = $('root').hidden = true;
  $('access').hidden = false;
  $('sync-error').textContent = '';
  $('reply').value = '';
  $('timeline').replaceChildren();
  $('thread-list').replaceChildren();
  $('agents').replaceChildren();
  $('modal-body').replaceChildren();
  $('claim-name').value = '';
  loginKind();
  selectLogin(false);
}

function row(name, description, controls = []) {
  const div = element('div', '', 'row'),
    details = element('div', '', 'details'),
    actions = element('div', '', 'actions');
  details.append(element('strong', name), element('small', description));
  actions.append(...controls);
  div.append(details, actions);
  return div;
}
function renderRoot(info) {
  const workspaces = info.workspaces || [],
    invites = info.invites || [];
  $('root-workspaces').replaceChildren(
    ...workspaces.map((w) =>
      row(w.name || w.master || w.id, w.id, [element('span', w.state || 'Active', 'status-pill')]),
    ),
  );
  $('root-invites').replaceChildren(
    ...invites.map((i) => {
      const status = i.revoked
        ? 'Revoked'
        : i.workspace
          ? 'Claimed'
          : i.expires <= Date.now()
            ? 'Expired'
            : 'Pending';
      const controls = [element('span', status, 'status-pill')],
        slot = session.slot + 'invite.' + i.id;
      if (status !== 'Pending') sessionStorage.removeItem(slot);
      const link = sessionStorage.getItem(slot);
      if (link)
        controls.push(
          button('Invitation link', () =>
            privateText('Private master invitation', link, 'Copy invitation link'),
          ),
        );
      return row(i.label || 'Master invitation', 'Expires ' + date(i.expires), controls);
    }),
  );
  if (!workspaces.length)
    $('root-workspaces').append(element('p', 'No master has claimed a workspace yet.', 'muted'));
  if (!invites.length)
    $('root-invites').append(
      element('p', 'Create an invitation for the first workspace master.', 'muted'),
    );
}
function inviteMaster() {
  const s = session;
  const body = dialog('Invite a master'),
    form = element('form', '', 'form-stack'),
    label = input(60, 'e.g. Studio operations');
  form.append(field('Workspace invitation label', label));
  body.append(form);
  formAction(form, 'Create master invitation', async () => {
    const link = await retryable(
      s.slot,
      'invite-master',
      [label.value.trim()],
      () => ({ requestId: crypto.randomUUID(), invite: 'mrm_' + hex(), label: label.value.trim() }),
      async (args) => {
        const result = await workspaceCall(s, 'root/invites', args);
        const url = new URL('/', location.origin);
        url.hash = new URLSearchParams({ master: result.invite || args.invite });
        sessionStorage.setItem(s.slot + 'invite.' + result.id, url.href);
        return url.href;
      },
    );
    privateText('Private master invitation', link, 'Copy invitation link');
    renderRoot(await workspaceCall(s, 'root'));
  });
}

function setTab(tab) {
  const s = session;
  s.tab = tab;
  const directory = tab === 'directory';
  $('page-title').textContent = directory ? 'Directory' : 'Conversations';
  $('threads-tab').setAttribute('aria-pressed', String(!directory));
  $('directory-tab').setAttribute('aria-pressed', String(directory));
  $('threads-panel').hidden = directory;
  $('directory-panel').hidden = !directory;
  $('new-thread').hidden = directory;
  $('invite').hidden = !directory || !['master', 'curator'].includes(s.me.role);
  if (!directory) queueRead();
}
function agentName(id) {
  return (
    session?.agents.find((a) => a.id === id)?.name || (id === session?.me.id ? session.me.name : id)
  );
}
function renderDirectory(s, response) {
  s.agents = response.items;
  const countLabel =
    response.connectedCount === 1 ? ' connected Muse account' : ' connected Muse accounts';
  $('connected-count').textContent =
    response.connectedCount + countLabel + ' · ' + response.onlineCount + ' recently active';
  $('agents').replaceChildren(
    ...s.agents.map((a) => {
      const controls = [
        element(
          'span',
          a.connection === 'invited' ? 'Invited' : a.online ? 'Recently active' : 'Connected',
          'status-pill' + (a.online ? ' online' : ''),
        ),
      ];
      if (a.joined && a.id !== s.me.id)
        controls.push(button('Message', () => compose(a.id), 'secondary'));
      const saved = sessionStorage.getItem(s.slot + 'invite.' + a.id);
      if (!a.joined && saved)
        controls.push(
          button('Setup prompt', () =>
            privateText(
              'Setup prompt for ' + a.name,
              workerPrompt(location.origin, s.me.workspaceId, a.name, saved),
            ),
          ),
        );
      return row(a.name + (a.id === s.me.id ? ' (you)' : ''), a.role + ' · ' + a.kind, controls);
    }),
  );
}
function inviteWorker() {
  const s = session;
  const body = dialog('Invite an account'),
    form = element('form', '', 'form-stack'),
    name = input(60, 'e.g. Video editor');
  const roles = [['agent', 'Agent']];
  if (s.me.role === 'master') roles.push(['curator', 'Curator (lead Muse)']);
  const role = select(roles),
    kind = select([
      ['agent', 'Muse agent'],
      ['human', 'Person'],
      ['service', 'External system'],
    ]);
  form.append(field('Name', name), field('Role', role), field('Account type', kind));
  body.append(form);
  formAction(form, 'Create setup prompt', async () => {
    const values = { name: name.value.trim(), role: role.value, kind: kind.value };
    const result = await retryable(
      s.slot,
      'invite-worker',
      values,
      () => ({
        ...values,
        invite: 'mri_' + s.me.workspaceId + '_' + hex(),
        requestId: crypto.randomUUID(),
      }),
      async (args) => {
        const invited = await workspaceCall(s, 'invites', args);
        sessionStorage.setItem(s.slot + 'invite.' + invited.id, args.invite);
        return { ...invited, invite: args.invite };
      },
    );
    privateText(
      'Setup prompt for ' + result.name,
      workerPrompt(location.origin, s.me.workspaceId, result.name, result.invite),
    );
    await sync(s);
  });
}

function compose(to = '') {
  const s = session;
  const available = s.agents.filter((a) => a.id !== s.me.id && a.connection === 'connected');
  const body = dialog('New thread');
  if (!available.length) {
    body.append(element('p', 'A recipient can receive messages once they have joined this workspace.'));
    if (['master', 'curator'].includes(s.me.role)) body.append(button('Invite agent', inviteWorker));
    return;
  }
  const form = element('form', '', 'form-stack'),
    recipient = select(available.map((a) => [a.id, a.name]));
  if (to) recipient.value = to;
  const kind = select([
      ['chat', 'Conversation'],
      ['task', 'Instruction'],
    ]),
    subject = input(120),
    message = element('textarea');
  message.required = true;
  message.maxLength = 16000;
  message.rows = 4;
  form.append(
    field('Recipient', recipient),
    field('Type', kind),
    field('Subject', subject),
    field('Message', message),
  );
  body.append(form);
  formAction(form, 'Start thread', async () => {
    const values = {
      to: recipient.value,
      kind: kind.value,
      subject: subject.value.trim(),
      body: message.value.trim(),
    };
    const result = await post(s, 'threads', values);
    $('modal').close();
    setTab('threads');
    await openThread(s, result.id, true);
    await sync(s);
  });
}
function post(s, path, values) {
  return retryable(
    s.slot,
    path,
    values,
    () => ({ ...values, requestId: crypto.randomUUID() }),
    (args) => workspaceCall(s, path, args),
  );
}

function renderThreads(s) {
  const filter = $('filter').value;
  const threads = s.threads.filter(
    (t) => filter === 'all' || (filter === 'task' ? t.kind === 'task' : t.unread > 0),
  );
  $('thread-list').replaceChildren(
    ...threads.map((t) => {
      const b = button('', () => openThread(s, t.id, true), 'thread');
      b.setAttribute('aria-current', String(t.id === s.selected));
      const line = element('span', '', 'line');
      line.append(element('span', t.subject, 'subject'));
      if (t.unread > 0) line.append(element('span', String(t.unread), 'badge'));
      b.append(
        line,
        element('span', t.preview || '', 'preview'),
        element('span', t.kind === 'task' ? 'Instruction · ' + t.status : 'Conversation', 'tiny'),
      );
      return b;
    }),
  );
  if (!threads.length)
    $('thread-list').append(
      element('p', filter === 'all' ? 'No conversations yet.' : 'No matching threads.', 'muted'),
    );
  $('older-threads').hidden = !s.moreThreads;
}
async function loadThreads(s, older = false) {
  const page = await workspaceCall(s, older ? 'threads?before=' + s.threadCursor : 'threads');
  if (session !== s) return;
  if (older) s.threads.push(...page.items.filter((t) => !s.threads.some((item) => item.id === t.id)));
  else {
    const previous = s.threads;
    s.threads = page.items.slice();
    if (s.extendedThreads)
      s.threads.push(...previous.filter((t) => !s.threads.some((item) => item.id === t.id)));
  }
  if (older || !s.extendedThreads) {
    s.threadCursor = page.nextCursor;
    s.moreThreads = page.hasMore;
  }
  if (older) s.extendedThreads = true;
  renderThreads(s);
}
function renderDetailEmpty() {
  $('empty-detail').hidden = false;
  $('detail').hidden = true;
  $('threads-panel').classList.remove('show-detail');
}

async function openThread(s, id, selectThread = false, older = false) {
  if (session !== s) return;
  if (selectThread && s.selected !== id) {
    if (s.selected) sessionStorage.setItem(s.slot + 'draft.' + s.selected, $('reply').value);
    s.selected = id;
    s.items = [];
    s.thread = null;
    s.moreHistory = false;
    $('reply').value = sessionStorage.getItem(s.slot + 'draft.' + id) || '';
    $('empty-detail').hidden = false;
    $('detail').hidden = true;
    renderThreads(s);
  }
  if (selectThread) $('threads-panel').classList.add('show-detail');
  const serial = ++s.selectedRequest;
  const path = 'threads/' + encodeURIComponent(id) + (older ? '?before=' + s.items[0].seq : '');
  const page = await workspaceCall(s, path);
  if (session !== s || s.selected !== id || s.selectedRequest !== serial) return;
  const previous = s.items;
  const pageIds = new Set(page.items.map((m) => m.seq));
  const items = [...previous.filter((m) => !pageIds.has(m.seq)), ...page.items].sort(
    (a, b) => a.seq - b.seq,
  );
  if (!older && previous.length && page.hasMore && !previous.some((m) => pageIds.has(m.seq))) {
    s.items = page.items;
    s.moreHistory = true;
  } else {
    s.items = items;
    if (older || !previous.length || page.items[0]?.seq === s.items[0]?.seq)
      s.moreHistory = page.hasMore;
  }
  s.thread = page.thread;
  $('empty-detail').hidden = true;
  $('detail').hidden = false;
  renderDetail(s, { selectThread, older });
}
function renderDetail(s, { selectThread, older }) {
  const t = s.thread,
    timeline = $('timeline');
  const oldHeight = timeline.scrollHeight,
    oldTop = timeline.scrollTop;
  const atEnd = oldHeight - timeline.clientHeight - oldTop < 35;
  $('subject').textContent = t.subject;
  $('thread-kind').textContent = t.kind === 'task' ? 'Instruction' : 'Conversation';
  $('members').textContent = (t.members || []).map(agentName).join(' · ');
  $('task-status').hidden = t.kind !== 'task';
  $('task-status').textContent = [
    t.status,
    t.assignee && 'Assigned to ' + agentName(t.assignee),
    t.working_note,
  ]
    .filter(Boolean)
    .join(' · ');
  const nodes = [];
  if (s.moreHistory)
    nodes.push(button('Load earlier messages', () => openThread(s, t.id, false, true), 'plain'));
  for (const m of s.items) {
    if (m.type === 'status') {
      nodes.push(
        element(
          'p',
          agentName(m.sender) + ' · ' + (m.body || m.status) + ' · ' + date(m.created),
          'event',
        ),
      );
      continue;
    }
    const item = element('article', '', 'message');
    item.dataset.seq = String(m.seq);
    item.append(
      element('strong', agentName(m.sender)),
      element('time', date(m.created), 'time'),
      messageBody(m.body),
    );
    if (m.receipts?.length) {
      const byRecipient = m.receipts.map((r) => {
        const [label, when] = r.acked
          ? ['Acknowledged', r.acked]
          : r.read
            ? ['Read', r.read]
            : r.delivered
              ? ['Delivered', r.delivered]
              : ['Sent', null];
        return { name: agentName(r.recipient), label, when };
      });
      const receipts = element(
        'p',
        byRecipient.map((r) => r.name + ' · ' + r.label).join(' / '),
        'receipt',
      );
      receipts.title = byRecipient.map((r) => r.name + ' · ' + r.label + ' ' + date(r.when)).join('\n');
      item.append(receipts);
    }
    nodes.push(item);
  }
  timeline.replaceChildren(...nodes);
  if (older) timeline.scrollTop = oldTop + (timeline.scrollHeight - oldHeight);
  else if (selectThread || atEnd) timeline.scrollTop = timeline.scrollHeight;
  else timeline.scrollTop = oldTop;
  const options = [];
  const pending = s.items.filter((m) => m.receipts?.some((r) => r.recipient === s.me.id && !r.acked));
  if (pending.length)
    options.push(
      button('Acknowledge', async () => {
        await workspaceCall(s, 'threads/' + t.id + '/ack', {
          from: pending[0].seq,
          through: pending.at(-1).seq,
        });
        await openThread(s, t.id);
        notice('Acknowledged.');
      }),
    );
  if (t.kind === 'task' && t.status !== 'done' && (t.assignee === s.me.id || s.me.role === 'master')) {
    for (const [action, label] of [
      ['working', 'Mark working'],
      ['done', 'Mark done'],
    ]) {
      if (action === 'working' && t.status === 'working') continue;
      options.push(
        button(label, async () => {
          await post(s, 'threads/' + t.id + '/' + action, {});
          await openThread(s, t.id);
          await loadThreads(s);
        }),
      );
    }
  }
  $('task-actions').replaceChildren(...options);
  queueRead();
}
function queueRead() {
  clearTimeout(readTimer);
  const s = session;
  if (!s || s.root || !s.thread || s.tab !== 'threads' || document.hidden || !document.hasFocus())
    return;
  const id = s.selected;
  readTimer = setTimeout(() => markVisibleRead(s, id).catch(showError), 220);
}
async function markVisibleRead(s, id) {
  if (
    s !== session ||
    s.selected !== id ||
    !s.thread ||
    s.tab !== 'threads' ||
    document.hidden ||
    !document.hasFocus() ||
    s.readPending
  )
    return;
  const timeline = $('timeline'),
    rect = timeline.getBoundingClientRect();
  if (!rect.height || rect.top >= window.innerHeight || rect.bottom <= 0) return;
  const unread = new Set(
    s.items.filter((m) => m.receipts?.some((r) => r.recipient === s.me.id && !r.read)).map((m) => m.seq),
  );
  const visible = [];
  for (const node of timeline.querySelectorAll('[data-seq]')) {
    if (!unread.has(Number(node.dataset.seq))) continue;
    const box = node.getBoundingClientRect();
    if (box.bottom > Math.max(rect.top, 0) && box.top < Math.min(rect.bottom, window.innerHeight))
      visible.push(Number(node.dataset.seq));
  }
  if (!visible.length) return;
  const first = visible[0],
    last = visible.at(-1);
  s.readPending = true;
  try {
    await workspaceCall(s, 'threads/' + id + '/read', { from: first, through: last });
    if (s !== session || s.selected !== id) return;
    for (const m of s.items) {
      if (m.seq < first || m.seq > last) continue;
      for (const r of m.receipts || []) if (r.recipient === s.me.id && !r.read) r.read = Date.now();
    }
    await loadThreads(s);
  } finally {
    s.readPending = false;
  }
}

async function notify(s, messages) {
  if (
    !messages.length ||
    !('Notification' in window) ||
    Notification.permission !== 'granted' ||
    localStorage.getItem(s.slot + 'notify') !== 'on'
  )
    return;
  const highest = Number(localStorage.getItem(s.slot + 'notified') || 0);
  const fresh = messages.filter((m) => m.seq > highest && m.sender !== s.me.id);
  if (!fresh.length) return;
  const last = fresh.at(-1);
  localStorage.setItem(s.slot + 'notified', String(last.seq));
  if (
    !document.hidden &&
    document.hasFocus() &&
    fresh.every((m) => s.selected === m.thread && s.tab === 'threads')
  )
    return;
  const message =
    fresh.length === 1 ? 'New message from ' + agentName(last.sender) : fresh.length + ' new messages';
  try {
    const n = new Notification('Muse Relay', {
      body: message,
      tag: s.slot + 'inbox',
      icon: '/icon.svg',
    });
    n.onclick = () => {
      window.focus();
      n.close();
      if (s === session) {
        setTab('threads');
        openThread(s, last.thread, true).catch(showError);
      }
    };
  } catch {
    notice(message);
  }
}
async function drainInbox(s, first) {
  const stored = localStorage.getItem(s.slot + 'cursor');
  let cursor = Number(stored || 0);
  const messages = [];
  for (;;) {
    const page = await workspaceCall(s, 'inbox?after=' + cursor + '&limit=100');
    if (s !== session) return;
    messages.push(...page.items);
    const next = page.nextCursor;
    if (!page.hasMore || next <= cursor) {
      cursor = Math.max(cursor, next || 0);
      break;
    }
    cursor = next;
  }
  if (!first && stored !== null) await notify(s, messages);
  if (s === session)
    localStorage.setItem(
      s.slot + 'cursor',
      String(Math.max(cursor, Number(localStorage.getItem(s.slot + 'cursor') || 0))),
    );
}
function scheduleSync(s) {
  if (s !== session) return;
  clearTimeout(s.hintTimer);
  s.hintTimer = setTimeout(() => (s.root ? refreshRoot(s).catch(showError) : sync(s)), 200);
}
async function refreshRoot(s) {
  const info = await workspaceCall(s, 'root');
  if (s === session) renderRoot(info);
}
async function sync(s) {
  if (!s || s.root || s !== session) return;
  if (s.syncing) {
    s.queued = true;
    return;
  }
  s.syncing = true;
  clearTimeout(pollTimer);
  try {
    const agents = await workspaceCall(s, 'agents');
    if (s !== session) return;
    renderDirectory(s, agents);
    await Promise.all([
      loadThreads(s),
      drainInbox(s, !s.initialized),
      s.selected && openThread(s, s.selected),
    ]);
    if (s !== session) return;
    s.initialized = true;
    $('sync-error').textContent = '';
  } catch (error) {
    if (s === session && !s.controller.signal.aborted)
      $('sync-error').textContent = 'Refresh failed. ' + error.message;
  } finally {
    s.syncing = false;
    if (s === session) {
      if (s.queued) {
        s.queued = false;
        scheduleSync(s);
      } else pollTimer = setTimeout(() => sync(s), 60000);
    }
  }
}

function selectLogin(useKey) {
  $('login').hidden = !useKey;
  $('password-login').hidden = useKey;
  $('access-error').textContent = '';
  $('switch-login').textContent = useKey ? 'Sign in with username' : 'Use an invitation or access key';
  $(useKey ? 'credential' : 'username').focus();
}
function passwordInput(autocomplete) {
  const node = input(256);
  node.type = 'password';
  node.minLength = 8;
  node.autocomplete = autocomplete;
  return node;
}
function changePassword(account, initialPassword = '') {
  const body = dialog(account.mustChange ? 'Set your new password' : 'Change password');
  const form = element('form', '', 'form-stack');
  const current = passwordInput('current-password'),
    next = passwordInput('new-password'),
    confirm = passwordInput('new-password');
  if (!initialPassword) form.append(field('Current password', current));
  form.append(field('New password', next), field('Confirm new password', confirm));
  body.append(form);
  formAction(form, 'Save password', async () => {
    if (next.value !== confirm.value) throw new Error('The two new passwords do not match.');
    await api('auth/password', {
      body: { currentPassword: initialPassword || current.value, newPassword: next.value },
    });
    localStorage.removeItem(prefix + 'key');
    sessionStorage.removeItem(prefix + 'root');
    location.replace(location.pathname);
  });
  (initialPassword ? next : current).focus();
}
function addUser() {
  const body = dialog('Add user'),
    form = element('form', '', 'form-stack'),
    name = input(40),
    pass = passwordInput('new-password');
  name.autocomplete = 'off';
  name.autocapitalize = 'none';
  name.spellcheck = false;
  body.append(element('p', 'This person will own a separate workspace for their Muse accounts.'));
  form.append(field('Username', name), field('Temporary password', pass));
  body.append(form);
  formAction(form, 'Create user', async () => {
    const username = name.value.trim().toLowerCase(),
      slot = session.slot + 'create-user.' + username;
    const requestId = sessionStorage.getItem(slot) || crypto.randomUUID();
    sessionStorage.setItem(slot, requestId);
    await api('auth/users', { body: { username, password: pass.value, requestId } });
    sessionStorage.removeItem(slot);
    const done = dialog('User created');
    done.append(
      element(
        'p',
        'Share the dashboard address, username ' +
          username +
          ', and the temporary password privately. They will choose a new password at first sign-in.',
      ),
    );
    done.append(element('p', location.origin));
  });
  name.focus();
}
function settings() {
  const s = session,
    body = dialog(s.account ? 'Account' : 'Connection');
  if (s.account) {
    body.append(
      element('p', 'Signed in as ' + s.account.username),
      button('Change password', () => changePassword(s.account)),
    );
    if (s.account.admin) body.append(button('Add user', addUser));
  }
  if (s.key && !s.root) {
    const controls = element('div', '', 'actions'),
      value = element('code', '', 'api-key');
    value.id = 'revealed-api-key';
    value.hidden = true;
    function showKey(visible) {
      value.textContent = visible ? s.key : '';
      value.hidden = !visible;
      reveal.textContent = visible ? 'Hide API key' : 'Reveal API key';
      reveal.setAttribute('aria-expanded', String(visible));
    }
    const reveal = button('Reveal API key', () => showKey(value.hidden));
    reveal.setAttribute('aria-controls', value.id);
    reveal.setAttribute('aria-expanded', 'false');
    controls.append(
      reveal,
      button('Copy API key', async () => {
        try {
          await navigator.clipboard.writeText(s.key);
          notice('API key copied.');
        } catch {
          showKey(true);
          notice('Clipboard unavailable. Read or select the key shown here.');
        }
      }),
    );
    body.append(controls, value);
    if (s.me.role !== 'master')
      body.append(
        button('Connector setup prompt', () =>
          privateText(
            'Connector setup prompt',
            connectorPrompt(location.origin, s.me.workspaceId, s.me.name),
            'Copy connector prompt',
          ),
        ),
      );
  }
  body.append(
    element(
      'p',
      s.root
        ? 'Signed in as the root administrator.'
        : s.me.name + ' · ' + s.me.role + ' · ' + s.me.workspaceId,
    ),
  );
  if (!s.root) {
    if (s.key && s.me.role === 'master')
      body.append(
        button('Master setup prompt', () =>
          privateText(
            'Private master setup prompt',
            mainPrompt(location.origin, s.me.workspaceId, s.key),
          ),
        ),
      );
    if ('Notification' in window) {
      const enabled =
        localStorage.getItem(s.slot + 'notify') === 'on' && Notification.permission === 'granted';
      const permission = element(
        'p',
        Notification.permission === 'denied'
          ? 'Browser alerts are blocked for this site. Change permission in your browser’s site settings.'
          : 'Browser alerts are available while this workspace is open in this profile.',
      );
      body.append(permission);
      if (Notification.permission !== 'denied')
        body.append(
          button(enabled ? 'Turn off browser alerts' : 'Enable browser alerts', async () => {
            if (enabled) {
              localStorage.removeItem(s.slot + 'notify');
              settings();
              return;
            }
            const answer = await Notification.requestPermission();
            if (answer === 'granted') {
              await drainInbox(s, true);
              localStorage.setItem(s.slot + 'notify', 'on');
            }
            settings();
          }),
        );
    } else body.append(element('p', 'This browser does not support notification alerts.'));
  }
  if (s.root)
    body.append(
      button('Copy my access key', async () => {
        try {
          await navigator.clipboard.writeText(s.key);
          notice('Access key copied.');
        } catch {
          privateText('Private access key', s.key, 'Copy key');
        }
      }),
    );
  body.append(button(s.account ? 'Sign out' : 'Disconnect this browser', disconnect));
}

$('switch-login').onclick = () => selectLogin($('login').hidden);
$('add-user').onclick = addUser;
$('password-login').onsubmit = async (event) => {
  event.preventDefault();
  const submit = $('password-login').querySelector('button');
  if (submit.disabled) return;
  submit.disabled = true;
  $('access-error').textContent = '';
  try {
    const password = $('password').value;
    const previous = localStorage.getItem(prefix + 'key') || '';
    const user = await api('auth/login', {
      key: types.key.test(previous) ? previous : '',
      body: { username: $('username').value.trim(), password },
    });
    $('password').value = '';
    sessionStorage.removeItem(prefix + 'root');
    sessionStorage.removeItem(prefix + 'incoming');
    if (user.mustChange) changePassword(user, password);
    else await authenticate('', '', user);
  } catch (error) {
    showError(error);
  } finally {
    submit.disabled = false;
  }
};
$('credential').addEventListener('input', loginKind);
$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('connect').disabled) return;
  $('connect').disabled = true;
  $('access-error').textContent = '';
  try {
    await authenticate(credential($('credential').value), $('claim-name').value.trim());
    await api('auth/logout', { body: {} });
  } catch (error) {
    showError(error);
  } finally {
    $('connect').disabled = false;
  }
});
$('close-modal').onclick = () => $('modal').close();
$('modal').addEventListener('close', () => $('modal-body').replaceChildren());
$('settings').onclick = settings;
$('root-invite').onclick = inviteMaster;
$('root-refresh').onclick = () => refreshRoot(session).catch(showError);
$('threads-tab').onclick = () => setTab('threads');
$('directory-tab').onclick = () => setTab('directory');
$('invite').onclick = inviteWorker;
$('new-thread').onclick = () => compose();
$('refresh').onclick = () => sync(session);
$('filter').onchange = () => renderThreads(session);
$('older-threads').onclick = () => loadThreads(session, true).catch(showError);
$('back').onclick = () => {
  $('threads-panel').classList.remove('show-detail');
};
$('timeline').addEventListener('scroll', queueRead, { passive: true });
window.addEventListener('scroll', queueRead, { passive: true });
$('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = session,
    id = s.selected,
    submit = $('reply-form').querySelector('button');
  if (!id || submit.disabled) return;
  const message = $('reply').value.trim();
  if (!message) return;
  submit.disabled = true;
  try {
    await post(s, 'threads/' + id + '/messages', { body: message });
    sessionStorage.removeItem(s.slot + 'draft.' + id);
    if (session === s && s.selected === id) {
      $('reply').value = '';
      await openThread(s, id, true);
    }
    await loadThreads(s);
  } catch (error) {
    showError(error);
  } finally {
    submit.disabled = false;
  }
});
$('reply').oninput = () => {
  if (session?.selected)
    sessionStorage.setItem(session.slot + 'draft.' + session.selected, $('reply').value);
};
window.addEventListener('focus', () => {
  if (session) scheduleSync(session);
  queueRead();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session) scheduleSync(session);
  queueRead();
});

async function start() {
  if (location.hash) {
    const fragment = location.hash;
    history.replaceState({}, '', location.pathname + location.search);
    const value = credential(fragment);
    if (value) sessionStorage.setItem(prefix + 'incoming', value);
  }
  const incoming = sessionStorage.getItem(prefix + 'incoming');
  if (incoming) {
    selectLogin(true);
    $('credential').value = incoming;
    loginKind();
    if (types.master.test(incoming)) $('claim-name').focus();
    return;
  }
  const saved = sessionStorage.getItem(prefix + 'root') || localStorage.getItem(prefix + 'key');
  if (saved && types.root.test(saved)) {
    await authenticate(saved, '');
    return;
  }
  const { user } = await api('auth/session');
  if (user) {
    if (user.mustChange) {
      $('username').value = user.username;
      changePassword(user);
    } else await authenticate('', '', user);
    return;
  }
  if (saved) {
    const { username } = await api('auth/legacy', { key: saved });
    if (username) {
      $('username').value = username;
      $('password').focus();
    } else await authenticate(saved, '');
  }
}
start().catch(showError);
