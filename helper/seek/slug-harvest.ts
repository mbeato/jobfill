// The single apply-URL -> ATS-token extractor shared by the SimplifyJobs
// harvest (D-11) and the Getro harvest (D-14). Pure, no-I/O, never throws —
// mirrors normalize.ts's `try { new URL(raw) } catch` defensive style.
//
// The `/embed/` exclusion is a security control (T-16-02), not a tidiness
// rule: boards.greenhouse.io/embed/job_app?token=<jobId> is a job ID, not a
// company slug. Harvesting it would insert a permanently-404ing "embed" board
// and let an attacker-crafted apply URL steer a later ATS probe.

export interface HarvestedBoard {
  ats: 'greenhouse' | 'lever' | 'ashby';
  token: string;
}

// All three live Greenhouse host forms: job-boards.greenhouse.io,
// boards.greenhouse.io, job-boards.eu.greenhouse.io — matching only
// boards.greenhouse.io silently loses ~28 of 384 Greenhouse-hosted
// SimplifyJobs entries.
const GREENHOUSE_HOSTS = /^(job-boards|boards)(\.eu)?\.greenhouse\.io$/;

export function extractAtsToken(rawUrl: string): HarvestedBoard | null {
  let u: URL;
  try {
    u = new URL(String(rawUrl ?? ''));
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  if (GREENHOUSE_HOSTS.test(host)) {
    // boards.greenhouse.io/embed/job_app?token=<jobId> trap — not a company slug.
    if (segs[0] === 'embed') return null;
    return segs[0] ? { ats: 'greenhouse', token: segs[0] } : null;
  }
  if (host === 'jobs.lever.co') {
    return segs[0] ? { ats: 'lever', token: segs[0] } : null;
  }
  if (host === 'jobs.ashbyhq.com') {
    return segs[0] ? { ats: 'ashby', token: segs[0] } : null;
  }
  return null;
}
