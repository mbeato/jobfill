import { test, expect } from 'bun:test';
import { mergeProfilePatch } from './profile-merge';

// A fixture shaped like the real profile.local.json (all ten top-level
// keys), used across several tests below.
function fixture() {
  return {
    contact: {
      firstName: 'the operator',
      lastName: 'Example',
      pronouns: 'he/him',
      email: 'max@example.com',
      phone: '555-1234',
      city: 'New York',
      state: 'NY',
      country: 'US',
      location: 'New York, NY',
    },
    links: { linkedin: 'li.com/max', github: 'github.com/max', portfolio: 'max.dev' },
    workAuth: { authorizedUS: true, status: 'citizen', needsSponsorship: false, needsFutureSponsorship: false, over18: true },
    eeo: { gender: '', race: '', veteran: '', disability: '', hispanicLatino: '', sexualOrientation: '' },
    answers: { salaryExpectation: '', startDate: '', willingToRelocate: '', howDidYouHear: '' },
    work: [{ title: 'Founder' }],
    education: [{ school: 'State University' }],
    projects: [{ name: 'jobfill' }],
    skills: ['TypeScript', 'Python'],
    resumeText: 'long resume text',
  };
}

test('a patch touching only contact.email leaves the .tex-derived keys and the other 8 contact fields intact', () => {
  const existing = fixture();
  const merged = mergeProfilePatch(existing, { contact: { email: 'new@example.com' } });
  expect(merged.work).toEqual(existing.work);
  expect(merged.education).toEqual(existing.education);
  expect(merged.projects).toEqual(existing.projects);
  expect(merged.skills).toEqual(existing.skills);
  expect(merged.resumeText).toEqual(existing.resumeText);
  expect((merged.contact as Record<string, unknown>).email).toBe('new@example.com');
  const { email, ...restExpected } = existing.contact;
  const { email: _e, ...restActual } = merged.contact as Record<string, unknown>;
  expect(restActual).toEqual(restExpected);
});

test('a patch containing resumeText, work or skills at the top level has no effect on them', () => {
  const existing = fixture();
  const merged = mergeProfilePatch(existing, { resumeText: 'HACKED', work: ['HACKED'], skills: ['HACKED'] });
  expect(merged.resumeText).toEqual(existing.resumeText);
  expect(merged.work).toEqual(existing.work);
  expect(merged.skills).toEqual(existing.skills);
});

test('a patch containing an unknown field inside a known section drops it', () => {
  const existing = fixture();
  const merged = mergeProfilePatch(existing, { contact: { ssn: '123-45-6789' } });
  expect((merged.contact as Record<string, unknown>).ssn).toBeUndefined();
});

test('workAuth.over18 coerces to boolean, contact.phone coerces to string', () => {
  const existing = fixture();
  const merged = mergeProfilePatch(existing, { workAuth: { over18: 'yes' }, contact: { phone: 12345 } });
  expect((merged.workAuth as Record<string, unknown>).over18).toBe(true);
  expect((merged.contact as Record<string, unknown>).phone).toBe('12345');
});

test('__proto__ as a section name and as a field name both leave Object.prototype unpolluted', () => {
  mergeProfilePatch({}, JSON.parse('{"__proto__":{"polluted":1}}'));
  mergeProfilePatch({ contact: {} }, JSON.parse('{"contact":{"__proto__":{"polluted":1}}}'));
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test('mergeProfilePatch(undefined, patch) returns an object with only the patched section key (fresh-install path)', () => {
  const merged = mergeProfilePatch(undefined, { contact: { email: 'a@b.c' } });
  expect(Object.keys(merged)).toEqual(['contact']);
  expect((merged.contact as Record<string, unknown>).email).toBe('a@b.c');
});

test('mergeProfilePatch(existing, null) and mergeProfilePatch(existing, "garbage") both return existing unchanged', () => {
  const existing = { work: [1] };
  expect(mergeProfilePatch(existing, null)).toEqual(existing);
  expect(mergeProfilePatch(existing, 'garbage')).toEqual(existing);
});

test('a full round trip over a fixture with an empty patch returns a value deep-equal to the fixture', () => {
  const existing = fixture();
  const merged = mergeProfilePatch(existing, {});
  expect(merged).toEqual(existing);
});

test('an empty patch does not introduce an empty section that was absent from existing', () => {
  const existing = { contact: { email: 'a@b.c' } };
  const merged = mergeProfilePatch(existing, {});
  expect(Object.keys(merged)).toEqual(['contact']);
  expect(merged.eeo).toBeUndefined();
});
