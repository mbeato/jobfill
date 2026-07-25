// Pure, allowlisted read-merge of profile.local.json's five editable
// sections (D-11). No imports beyond types — this module does no I/O and is
// the reason PATCH /profile in server.ts stays three lines.
//
// The merge iterates PROFILE_SECTIONS' hardcoded section/field names, never
// the patch's own keys — this is what makes work[]/education[]/projects[]/
// skills[]/resumeText structurally unreachable (D-11) and what makes
// prototype pollution unreachable by construction (T-18-06-02). See the
// belt-and-braces guards below.

type FieldType = 'string' | 'boolean';

// Mirrors the live profile.local.json shape field-for-field (18-06-PLAN.md
// interfaces block). Booleans are the four genuine workAuth flags; every
// other editable field is a string.
export const PROFILE_SECTIONS: Readonly<Record<string, Readonly<Record<string, FieldType>>>> = Object.freeze({
  contact: Object.freeze({
    firstName: 'string',
    lastName: 'string',
    pronouns: 'string',
    email: 'string',
    phone: 'string',
    city: 'string',
    state: 'string',
    country: 'string',
    location: 'string',
  }),
  links: Object.freeze({
    linkedin: 'string',
    github: 'string',
    portfolio: 'string',
  }),
  workAuth: Object.freeze({
    authorizedUS: 'boolean',
    status: 'string',
    needsSponsorship: 'boolean',
    needsFutureSponsorship: 'boolean',
    over18: 'boolean',
  }),
  eeo: Object.freeze({
    gender: 'string',
    race: 'string',
    veteran: 'string',
    disability: 'string',
    hispanicLatino: 'string',
    sexualOrientation: 'string',
  }),
  answers: Object.freeze({
    salaryExpectation: 'string',
    startDate: 'string',
    willingToRelocate: 'string',
    howDidYouHear: 'string',
  }),
});

// Belt-and-braces (T-18-06-02): the merge below never iterates a patch's own
// keys, so these names can never actually be reached — but a future refactor
// to key-iteration must not silently reopen the hole, so the guard stays.
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Pure, allowlisted read-merge. Never throws — a malformed patch yields
// `existing` unchanged. Never adds a section key that neither `existing` nor
// `patch` had, and never reaches work/education/projects/skills/resumeText
// because those names are not in PROFILE_SECTIONS.
export function mergeProfilePatch(existing: unknown, patch: unknown): Record<string, unknown> {
  // Every top-level key already in `existing` (including the untouched
  // .tex-derived ones) is carried through as-is — this is what keeps D-11
  // byte-identical across a save.
  const base: Record<string, unknown> = {};
  if (isPlainObject(existing)) {
    for (const key of Object.keys(existing)) {
      base[key] = existing[key];
    }
  }

  if (!isPlainObject(patch)) return base;

  for (const sectionName of Object.keys(PROFILE_SECTIONS)) {
    if (UNSAFE_NAMES.has(sectionName)) continue; // unreachable — belt-and-braces

    const patchSection = patch[sectionName];
    if (!isPlainObject(patchSection)) continue; // patch didn't touch this section

    const existingSection = isPlainObject(base[sectionName]) ? (base[sectionName] as Record<string, unknown>) : {};
    const fieldSpec = PROFILE_SECTIONS[sectionName];

    // Built field-by-field from the hardcoded allowlist, never from the
    // patch's own keys — a patch key not in the field list is dropped
    // silently (e.g. contact.ssn).
    const mergedSection: Record<string, unknown> = {};
    for (const fieldName of Object.keys(fieldSpec)) {
      if (UNSAFE_NAMES.has(fieldName)) continue; // unreachable — belt-and-braces
      const type = fieldSpec[fieldName];
      if (Object.prototype.hasOwnProperty.call(patchSection, fieldName)) {
        const raw = patchSection[fieldName];
        mergedSection[fieldName] = type === 'boolean' ? Boolean(raw) : String(raw ?? '');
      } else if (Object.prototype.hasOwnProperty.call(existingSection, fieldName)) {
        mergedSection[fieldName] = existingSection[fieldName];
      }
    }
    base[sectionName] = mergedSection;
  }

  return base;
}
