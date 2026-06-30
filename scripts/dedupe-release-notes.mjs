#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const fileArg = args.find((arg) => arg !== '--check') ?? 'CHANGELOG.md';
const changelogPath = path.resolve(fileArg);

const input = fs.readFileSync(changelogPath, 'utf8');
const newline = input.includes('\r\n') ? '\r\n' : '\n';
const hadTrailingNewline = /\r?\n$/.test(input);
const lines = input.replace(/\r?\n$/, '').split(/\r?\n/);

const commitLinkPattern =
  /\s+\(\[[0-9a-f]{7,40}\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}\)\)/i;

function duplicateKey(line) {
  if (!/^\s*[*-]\s+/.test(line) || !commitLinkPattern.test(line)) {
    return null;
  }

  return line.replace(commitLinkPattern, '').replace(/\s+/g, ' ').trim();
}

const output = [];
let seen = new Map();
let removed = 0;

for (const line of lines) {
  if (/^##\s+/.test(line)) {
    seen = new Map();
  }

  const key = duplicateKey(line);
  if (key && seen.has(key)) {
    // release-please currently lists merge commits before their underlying
    // conventional commits, so keep the later entry with the direct commit SHA.
    const previousIndex = seen.get(key);
    output[previousIndex] = null;
    removed += 1;
  }

  if (key) {
    seen.set(key, output.length);
  }

  output.push(line);
}

const normalized = output.filter((line) => line !== null).join(newline) + (hadTrailingNewline ? newline : '');

if (checkOnly) {
  if (removed > 0) {
    console.error(`${path.relative(process.cwd(), changelogPath)} has ${removed} duplicate release note entr${removed === 1 ? 'y' : 'ies'}.`);
    process.exit(1);
  }

  console.log(`${path.relative(process.cwd(), changelogPath)} has no duplicate release note entries.`);
  process.exit(0);
}

if (normalized !== input) {
  fs.writeFileSync(changelogPath, normalized);
}

console.log(`${path.relative(process.cwd(), changelogPath)}: removed ${removed} duplicate release note entr${removed === 1 ? 'y' : 'ies'}.`);
