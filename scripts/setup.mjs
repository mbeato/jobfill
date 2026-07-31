// scripts/setup.mjs
//
// One-command bootstrap for a fresh clone. Copies each shipped *.example.*
// template to its gitignored local counterpart, then prints what to do next.
//
// Zero dependencies, plain node ESM — same constraint as the rest of scripts/:
// it must run before anything project-specific is configured.
//
// Never overwrites an existing local file. Re-running is safe and is the
// intended way to pick up a template that was added after your first setup.
//
// Usage: npm run setup

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// [template, destination, what it holds]
const TEMPLATES = [
  ['profile.example.json', 'profile.local.json', 'your name, contact details and history'],
  ['seek.config.example.json', 'seek.config.json', 'which job boards to search (all disabled by default)'],
  ['jobfill.config.example.json', 'jobfill.config.json', 'where your resume and generated documents live'],
];

let copied = 0;
let kept = 0;
const missing = [];

console.log('jobfill setup\n');

for (const [template, dest, what] of TEMPLATES) {
  const src = join(ROOT, template);
  const dst = join(ROOT, dest);

  if (!existsSync(src)) {
    missing.push(template);
    console.log(`  !  ${template} is missing from this clone — cannot create ${dest}`);
    continue;
  }
  if (existsSync(dst)) {
    console.log(`  =  ${dest} already exists, left untouched`);
    kept++;
    continue;
  }
  copyFileSync(src, dst);
  console.log(`  +  ${dest}  — ${what}`);
  copied++;
}

if (missing.length > 0) {
  console.error(
    `\nsetup failed: ${missing.length} template(s) missing from this clone: ${missing.join(', ')}.\n` +
      'This clone looks incomplete — re-clone rather than hand-creating the files.',
  );
  process.exit(1);
}

console.log(`\n${copied} file(s) created, ${kept} left as-is.\n`);
console.log('Next:\n');
console.log('  1. Edit profile.local.json with your own details.');
console.log('     Everything you leave blank is left blank on a form rather than guessed.');
console.log('     workAuth ships blank on purpose — those are legal attestations, set them yourself.');
console.log('     (You can also edit this later from the dashboard, which is friendlier.)\n');
console.log('  2. npm run helper');
console.log('     First boot mints your per-install token and prints it. Dashboard: http://127.0.0.1:7877\n');
console.log('  3. Load extension/ as an unpacked extension at chrome://extensions');
console.log('     (Developer mode -> Load unpacked), then paste the token from step 2 into');
console.log('     Details -> Extension options -> Helper token, and Save.\n');
console.log('Nothing runs on its own: every job board ships disabled, and jobfill never submits');
console.log('an application for you. See README.md for the full picture.\n');
