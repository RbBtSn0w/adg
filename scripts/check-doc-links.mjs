#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "vendor/skills/PROVENANCE.md"];

function collectMarkdown(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(absolute, relative);
    else if (entry.name.endsWith(".md")) files.push(join("docs", relative));
  }
}

collectMarkdown(join(root, "docs"));

const failures = [];
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0].replace(/^<|>$/g, ""));
    if (!target) continue;
    const absolute = resolve(root, dirname(file), target);
    if (!existsSync(absolute)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: missing ${raw}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Broken documentation links:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(`doc-links: ${files.length} Markdown files checked. OK`);
