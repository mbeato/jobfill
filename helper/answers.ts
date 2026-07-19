// Deterministic answer-library matching/grouping logic. Pure functions, no db access —
// callers (server.ts) pass plain row arrays. Mirrors normalizeUrl()'s defensive shape.

export interface AnswerRow {
  id: number;
  question: string;
  question_key: string;
  answer: string;
  pinned: number;
  created_at: string;
}

export function normalizeQuestion(q: string): string {
  try {
    return String(q ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 300);
  } catch {
    return '';
  }
}

export function tokenOverlap(a: string, b: string): number {
  const setA = new Set(String(a ?? '').split(/\s+/).filter(Boolean));
  const setB = new Set(String(b ?? '').split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// pinned desc, then created_at desc, then id desc.
function pickBest(rows: AnswerRow[]): AnswerRow {
  return [...rows].sort((a, b) => {
    if (b.pinned !== a.pinned) return b.pinned - a.pinned;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return b.id - a.id;
  })[0];
}

// Greedy fuzzy grouping: rows sorted created_at desc/id desc; each row joins the first
// existing group whose representative (first-added, i.e. most recent) question_key
// matches at >= threshold, else starts a new group.
function greedyGroup(rows: AnswerRow[], threshold: number): AnswerRow[][] {
  const sorted = [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return b.id - a.id;
  });
  const groups: AnswerRow[][] = [];
  for (const row of sorted) {
    const group = groups.find(g => tokenOverlap(row.question_key, g[0].question_key) >= threshold);
    if (group) group.push(row);
    else groups.push([row]);
  }
  return groups;
}

export function matchLibrary(
  questions: string[],
  rows: AnswerRow[],
  threshold = 0.6,
): { question: string; answer: string }[] {
  const chosenIds = new Set<number>();
  const results: { question: string; answer: string }[] = [];
  for (const q of questions) {
    const nq = normalizeQuestion(q);
    const candidates = rows.filter(r => tokenOverlap(nq, r.question_key) >= threshold);
    if (!candidates.length) continue;
    const best = pickBest(candidates);
    if (chosenIds.has(best.id)) continue;
    chosenIds.add(best.id);
    results.push({ question: best.question, answer: best.answer });
  }
  return results;
}

export function selectFewShot(rows: AnswerRow[], n = 5): { question: string; answer: string }[] {
  const groups = greedyGroup(rows, 0.6);
  const reps = groups.map(g => pickBest(g));
  const ordered = [...reps].sort((a, b) => {
    if (b.pinned !== a.pinned) return b.pinned - a.pinned;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return b.id - a.id;
  });
  return ordered.slice(0, n).map(r => ({ question: r.question, answer: r.answer }));
}

export function groupByQuestion(
  rows: AnswerRow[],
  threshold = 0.6,
): { question: string; best: AnswerRow; versions: AnswerRow[] }[] {
  const groups = greedyGroup(rows, threshold);
  return groups.map(g => {
    const best = pickBest(g);
    const versions = g
      .filter(r => r.id !== best.id)
      .sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return b.id - a.id;
      });
    return { question: best.question, best, versions };
  });
}
