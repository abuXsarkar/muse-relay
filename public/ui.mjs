export const $ = (id) => document.getElementById(id);

export function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text !== '') node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(text, action, className = 'secondary') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await action();
    } catch (error) {
      showError(error);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

export function showError(error) {
  const target = $('modal').open ? 'modal-error' : $('access').hidden ? 'sync-error' : 'access-error';
  $(target).textContent = error.message || 'The request failed. Try again.';
}

export function dialog(title) {
  const modal = $('modal');
  $('modal-title').textContent = title;
  $('modal-error').textContent = '';
  $('modal-body').replaceChildren();
  if (!modal.open) modal.showModal();
  return $('modal-body');
}

export function field(caption, input) {
  const label = element('label', caption);
  input.setAttribute('aria-label', caption);
  label.append(input);
  return label;
}
export function input(max, placeholder = '') {
  const node = element('input');
  node.required = true;
  node.maxLength = max;
  node.placeholder = placeholder;
  return node;
}
export function select(options) {
  const node = element('select');
  for (const [value, label] of options) node.add(new Option(label, value));
  return node;
}

export function formAction(form, title, action) {
  const submit = element('button', title, 'primary');
  form.append(submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    $('modal-error').textContent = '';
    try {
      await action();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
}

let noticeTimer;
export function notice(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 3500);
}

export function privateText(title, value, label = 'Copy setup prompt') {
  const body = dialog(title);
  const area = element('textarea');
  area.readOnly = true;
  area.setAttribute('aria-label', title);
  area.value = value;
  body.append(
    area,
    button(
      label,
      async () => {
        try {
          await navigator.clipboard.writeText(value);
          notice('Copied.');
        } catch {
          area.focus();
          area.select();
          notice('Selected. Use your browser’s copy command.');
        }
      },
      'primary',
    ),
  );
}

export function date(value) {
  if (!value) return '';
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function messageBody(value) {
  const p = element('p', '', 'body');
  for (const part of String(value || '').split(/(https?:\/\/[^\s<>"']+)/gi)) {
    if (/^https?:\/\//i.test(part)) {
      const link = element('a', part);
      link.href = part;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      p.append(link);
    } else {
      p.append(document.createTextNode(part));
    }
  }
  return p;
}
