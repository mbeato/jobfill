import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeDocPath } from './docpath';

test('safeDocPath returns the resolved path for a real in-root file with matching extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'docpath-'));
  const file = join(root, 'CoverLetter_acme_2026-07-24.pdf');
  writeFileSync(file, '%PDF-1.4');
  expect(safeDocPath(file, root, '.pdf')).toBe(file);
  rmSync(root, { recursive: true, force: true });
});

test('safeDocPath rejects a ../ traversal candidate that resolves outside root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'docpath-parent-'));
  const root = join(parent, 'rounds');
  mkdirSync(root);
  const outsideFile = join(parent, 'escaped.pdf');
  writeFileSync(outsideFile, '%PDF-1.4');
  const traversal = join(root, '..', 'escaped.pdf');
  expect(safeDocPath(traversal, root, '.pdf')).toBeNull();
  rmSync(parent, { recursive: true, force: true });
});

test('safeDocPath rejects a wrong-extension file even if it is in-root and exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'docpath-'));
  const file = join(root, 'notes.txt');
  writeFileSync(file, 'plain text');
  expect(safeDocPath(file, root, '.pdf')).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test('safeDocPath rejects a non-existent in-root path', () => {
  const root = mkdtempSync(join(tmpdir(), 'docpath-'));
  const missing = join(root, 'never_written.pdf');
  expect(safeDocPath(missing, root, '.pdf')).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

// WR-03: a file lexically under root that is ACTUALLY a symlink pointing
// outside root must be rejected — lexical resolve() containment alone would
// pass this (the symlink's own path starts with root), letting the real
// target's contents stream out.
test('safeDocPath rejects a symlink under root that escapes root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'docpath-symlink-parent-'));
  const root = join(parent, 'rounds');
  mkdirSync(root);
  const outsideFile = join(parent, 'secret.pdf');
  writeFileSync(outsideFile, '%PDF-1.4 secret');
  const linkPath = join(root, 'CoverLetter_acme_2026-07-24.pdf');
  symlinkSync(outsideFile, linkPath);
  expect(safeDocPath(linkPath, root, '.pdf')).toBeNull();
  rmSync(parent, { recursive: true, force: true });
});
