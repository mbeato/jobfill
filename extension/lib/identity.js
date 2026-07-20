const EXCLUDE_RE = /emergency|reference|referr(al|ed|er)|friend|contact person|manager|supervisor|recruiter/i;
const EMAIL_RE = /\be-?mail\b/i;
const PHONE_RE = /\b(phone|mobile|cell)\b/i;
const LINKEDIN_RE = /linkedin/i;
const GITHUB_RE = /github/i;
const PORTFOLIO_RE = /\b(portfolio|personal (web ?site|website)|personal site)\b/i;
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'textarea']);
// Catches the model's frame-exclusion reason including phrasing drift ("unrelated iframe",
// "third-party chat widget", "cookie consent embed", ...). A fuzzy match fails safe: we
// just don't inject.
export const UNRELATED_FRAME_RE = /unrelated|third[\s-]?party|widget|embed|chat|survey|cookie|consent|iframe/i;

function frameKey(id) {
  const i = String(id).indexOf(':');
  return i === -1 ? '' : String(id).slice(0, i);
}

// Gates which skipped fields captureAnswers may bank: never an unrelated-frame widget
// (third-party chat/support/cookie-consent) and never a field the model skipped because it
// was already filled (pre-filled/autofilled PII), even under phrasing drift.
export function isBankableSkip(reason) {
  return !UNRELATED_FRAME_RE.test(reason || '') && !/already filled/i.test(reason || '');
}

export function identityCategory(descriptor) {
  if (!TEXT_TYPES.has(descriptor.type)) return null;
  const label = descriptor.label || '';
  if (EXCLUDE_RE.test(label)) return null;
  if (descriptor.type === 'email' || EMAIL_RE.test(label)) return 'email';
  if (descriptor.type === 'tel' || PHONE_RE.test(label)) return 'phone';
  if (LINKEDIN_RE.test(label)) return 'linkedin';
  if (GITHUB_RE.test(label)) return 'github';
  if (PORTFOLIO_RE.test(label)) return 'portfolio';
  return null;
}

function constantFor(category, profile) {
  switch (category) {
    case 'email': return profile.contact?.email;
    case 'phone': return profile.contact?.phone;
    case 'linkedin': return profile.links?.linkedin;
    case 'github': return profile.links?.github;
    case 'portfolio': return profile.links?.portfolio;
    default: return null;
  }
}

export function enforceIdentity(mapping, fields, profile) {
  const mappedFields = [...mapping.fields];
  const skipped = [...mapping.skipped];
  const corrections = [];
  const byId = new Map(mappedFields.map((m, i) => [m.id, i]));
  // Frames where the model chose to fill at least one field. Injecting into any other
  // frame would make the guard the sole writer somewhere the model excluded — the exact
  // PII-into-third-party-widget leak the frame-safety rule exists to prevent.
  const mappedFrames = new Set(mapping.fields.map(m => frameKey(m.id)));

  for (const descriptor of fields) {
    const category = identityCategory(descriptor);
    if (!category) continue;
    const constant = constantFor(category, profile);
    if (!constant) continue;

    const idx = byId.get(descriptor.id);
    if (idx === undefined) {
      const skipIdx = skipped.findIndex(s => s.id === descriptor.id);
      if (skipIdx !== -1 && UNRELATED_FRAME_RE.test(skipped[skipIdx].reason || '')) continue;
      if (skipIdx === -1 && !mappedFrames.has(frameKey(descriptor.id))) continue;
      mappedFields.push({ id: descriptor.id, value: constant, kind: 'profile', confidence: 1 });
      byId.set(descriptor.id, mappedFields.length - 1);
      if (skipIdx !== -1) skipped.splice(skipIdx, 1);
      corrections.push({ id: descriptor.id, category, from: null, to: constant });
    } else {
      const entry = mappedFields[idx];
      if (String(entry.value) !== String(constant)) {
        corrections.push({ id: descriptor.id, category, from: entry.value, to: constant });
        mappedFields[idx] = { ...entry, value: constant };
      }
    }
  }

  return { fields: mappedFields, skipped, corrections };
}
