const EXCLUDE_RE = /emergency|reference|referr(al|ed|er)|friend|contact person|manager|supervisor|recruiter/i;
const EMAIL_RE = /\be-?mail\b/i;
const PHONE_RE = /\b(phone|mobile|cell)\b/i;
const LINKEDIN_RE = /linkedin/i;
const GITHUB_RE = /github/i;
const PORTFOLIO_RE = /\b(portfolio|personal (web ?site|website)|personal site)\b/i;

export function identityCategory(descriptor) {
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

  for (const descriptor of fields) {
    const category = identityCategory(descriptor);
    if (!category) continue;
    const constant = constantFor(category, profile);
    if (!constant) continue;

    const idx = byId.get(descriptor.id);
    if (idx === undefined) {
      mappedFields.push({ id: descriptor.id, value: constant, kind: 'profile', confidence: 1 });
      byId.set(descriptor.id, mappedFields.length - 1);
      const skipIdx = skipped.findIndex(s => s.id === descriptor.id);
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
