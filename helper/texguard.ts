// Safety gate for model-authored LaTeX (review 2 CR-01).
//
// The .tex this guards is written by a model from a prompt that inlines an
// untrusted scraped JD, and pdflatex then renders it into a PDF that is
// base64'd back and attached to a real employer's application. \input and
// \include read an arbitrary file INTO that PDF and need no shell escape at
// all, so -no-shell-escape on the compile is necessary but not sufficient.
// This TeX install also runs restricted shell escape (`kpsewhich -var-value
// shell_escape` returns `p`) and the 14-command whitelist carries known
// \write18 vectors (l3sys-query, latexminted, memoize-extract.py,
// texosquery-jre8).
//
// The first version of this guard rejected these primitives outright, on the
// stated grounds that "the base resume contains ZERO of these, so rejecting
// them cannot break a legitimate tailoring". That was wrong: the base resume
// has `\input{glyphtounicode}` on line 14, paired with `\pdfgentounicode=1`,
// which is what makes the PDF's glyphs parse correctly for ATS keyword
// extraction. The prompt also tells the model to keep the preamble exactly. So
// the blanket ban rejected 100% of correct tailorings — every one of the 32
// tailored .tex files on disk carries that line. It went unnoticed only
// because the helper runs under launchd and had not been restarted since the
// guard was committed.
//
// The fix is an allowlist anchored to the base resume rather than a wider ban:
// a file-reading directive is permitted only if the SAME directive already
// appears in the base resume, which the operator controls and the JD cannot influence.
// That keeps the security property exactly — an injected JD still cannot
// introduce `\input{/etc/passwd}`, because that directive is not in the base —
// while letting the model preserve the preamble it is told to preserve.
//
// Deliberately NOT done: telling the model in the prompt to avoid \input. That
// would "fix" the error by making it drop glyphtounicode, silently costing ATS
// parseability on every tailored resume — a worse outcome that looks like a
// success.

// Write and execute primitives. None appear in the base resume, and none has a
// legitimate use in a one-page resume, so these stay unconditionally refused.
const ALWAYS_FORBIDDEN = /\\(write18|openin|openout|immediate)(?![A-Za-z])/;

// File-reading primitives, allowed only when the base resume already uses the
// identical directive. The negative lookahead is TeX's own control-sequence
// rule — a control word is a maximal run of letters — so `\inputencoding` is a
// different command and is not matched here.
const READ_DIRECTIVE = /\\(input|include)(?![A-Za-z])\s*(?:\{\s*([^}]*?)\s*\}|([^\s{}\\%]+))?/g;

/**
 * Canonical key for one file-reading directive, e.g. `input:glyphtounicode`.
 * TeX accepts `\input{name}`, `\input {name}` and the braceless `\input name`,
 * so all three normalize to the same key and cannot be used to smuggle a
 * different argument past a comparison.
 */
function directiveKeys(tex: string): string[] {
  const keys: string[] = [];
  for (const m of tex.matchAll(READ_DIRECTIVE)) {
    const arg = (m[2] ?? m[3] ?? '').trim();
    keys.push(`${m[1]}:${arg}`);
  }
  return keys;
}

/**
 * Throws if `tex` carries a file-reading or file-writing primitive that
 * `baseTex` does not already justify. Returns silently when the .tex is safe.
 */
export function assertSafeTex(tex: string, baseTex: string): void {
  const forbidden = tex.match(ALWAYS_FORBIDDEN);
  if (forbidden) {
    throw new Error(
      `Tailoring returned a .tex containing ${forbidden[0]}, which can read or write arbitrary files during compile — refusing to write it.`,
    );
  }
  const allowed = new Set(directiveKeys(baseTex));
  for (const key of directiveKeys(tex)) {
    if (!allowed.has(key)) {
      const [cmd, arg] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      throw new Error(
        `Tailoring returned a .tex containing \\${cmd}{${arg}}, which is not in the base resume and can read an arbitrary file into the PDF — refusing to write it.`,
      );
    }
  }
}
