import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class Problem extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export function need(condition, status, message, extra) {
  if (!condition) throw new Problem(status, message, extra);
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const randomHex = (bytes = 32) => randomBytes(bytes).toString('hex');
export const newId = () => crypto.randomUUID();
export function sameDigest(a, b) {
  const x = Buffer.from(String(a ?? '')),
    y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const patterns = {
  workspace: /^[0-9a-f]{16}$/,
  key: /^mrk_([0-9a-f]{16})_[0-9a-f]{64}$/,
  invite: /^mri_([0-9a-f]{16})_[0-9a-f]{64}$/,
  beacon: /^mrb_([0-9a-f]{16})_[0-9a-f]{32}$/,
  masterInvite: /^mrm_[0-9a-f]{64}$/,
  rootKey: /^mrr_[0-9a-f]{64}$/,
  secret: /^[0-9a-f]{64}$/,
  requestId: /^[A-Za-z0-9._:-]{8,128}$/,
};
export const accessKey = (workspace, secret = randomHex(32)) => 'mrk_' + workspace + '_' + secret;
export const inviteCode = (workspace, secret = randomHex(32)) => 'mri_' + workspace + '_' + secret;

export function workspaceOf(token) {
  if (typeof token !== 'string') return null;
  const match = patterns.key.exec(token) || patterns.invite.exec(token) || patterns.beacon.exec(token);
  return match ? match[1] : null;
}

export function text(value, max, label) {
  need(
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max,
    400,
    'Send "' + label + '" as text of 1 to ' + max + ' characters.',
  );
  return value.trim();
}
export function optionalText(value, max, label) {
  if (value === undefined || value === null || value === '') return '';
  need(
    typeof value === 'string' && value.trim().length <= max,
    400,
    '"' + label + '" may be up to ' + max + ' characters.',
  );
  return value.trim();
}
export function requestId(value) {
  need(
    typeof value === 'string' && patterns.requestId.test(value),
    400,
    'Send "requestId": any unique string of 8 to 128 letters, digits, dots, dashes, colons or underscores (a UUID works). Reuse the same one when you retry the same action.',
  );
  return value;
}
export function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const number = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  need(
    Number.isSafeInteger(number) && number >= min && number <= max,
    400,
    '"' + label + '" must be a whole number from ' + min + ' to ' + max + '.',
  );
  return number;
}
