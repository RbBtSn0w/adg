import { existsSync } from "node:fs";
import { join } from "node:path";
import { ADG_MANIFEST_PATH, ADG_MARKETPLACE_PATH } from "../manifest.ts";
import { writeJson, writeText } from "../fsutil.ts";
import { ADG_SCHEMA_VERSION, type AdgManifest, type Marketplace } from "../types.ts";

/**
 * Authoring scenario — what `.agents/` artifact to scaffold. Vendor projections
 * (.claude-plugin / .codex-plugin) are never produced here: they are a
 * consumption/publish concern, generated at install time or via explicit
 * `adapt`.
 */
export type InitType = "plugin" | "marketplace" | "all";

export interface InitOptions {
  name: string;
  dir: string;
  description?: string;
  author?: string;
  skill?: string;
  /** Which `.agents/` artifact(s) to scaffold. Default: "plugin". */
  type?: InitType;
}

export interface InitResult {
  /** The root directory created for this scaffold. */
  pluginDir: string;
  created: string[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Dispatch on the authoring scenario: a plugin (`.agents/.plugin.json`), a
 * marketplace catalog (`.agents/.marketplace.json`), or `all` — a catalog root
 * with one starter member plugin in a subdirectory.
 */
export function initScaffold(opts: InitOptions): InitResult {
  switch (opts.type ?? "plugin") {
    case "plugin":
      return initPlugin(opts);
    case "marketplace":
      return initMarketplace(opts);
    case "all":
      return initAll(opts);
  }
}

/**
 * Scaffold a new ADG plugin directory: .agents/.plugin.json, a starter
 * skill (SKILL.md) and README.md.
 */
export function initPlugin(opts: InitOptions): InitResult {
  if (!NAME_RE.test(opts.name)) {
    throw new Error(`plugin name must be kebab-case, got "${opts.name}"`);
  }
  const pluginDir = join(opts.dir, opts.name);
  const manifestFile = join(pluginDir, ADG_MANIFEST_PATH);
  if (existsSync(manifestFile)) {
    throw new Error(`${manifestFile} already exists; refusing to overwrite`);
  }

  const skillName = opts.skill ?? "getting-started";
  const manifest: AdgManifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: opts.name,
    version: "0.1.0",
    description: opts.description ?? `${opts.name} plugin.`,
    author: { name: opts.author ?? "Agent Directory Group" },
    license: "Apache-2.0",
    skills: "./skills/",
    strict: true,
  };

  const created: string[] = [];

  writeJson(manifestFile, manifest);
  created.push(manifestFile);

  const skillFile = join(pluginDir, "skills", skillName, "SKILL.md");
  writeText(
    skillFile,
    `---\nname: ${skillName}\ndescription: Describe when this skill should trigger.\n---\n\n# ${skillName}\n\nDocument the skill's behavior here.\n`,
  );
  created.push(skillFile);

  const readme = join(pluginDir, "README.md");
  writeText(readme, `# ${opts.name}\n\n${manifest.description}\n`);
  created.push(readme);

  return { pluginDir, created };
}

/**
 * Scaffold a marketplace catalog: .agents/.marketplace.json (empty member list)
 * and README.md. Members are added later, or scaffold them with `--type all`.
 */
export function initMarketplace(opts: InitOptions): InitResult {
  if (!NAME_RE.test(opts.name)) {
    throw new Error(`marketplace name must be kebab-case, got "${opts.name}"`);
  }
  const catalogDir = join(opts.dir, opts.name);
  const catalogFile = join(catalogDir, ADG_MARKETPLACE_PATH);
  if (existsSync(catalogFile)) {
    throw new Error(`${catalogFile} already exists; refusing to overwrite`);
  }

  const description = opts.description ?? `${opts.name} marketplace.`;
  const catalog: Marketplace = {
    name: opts.name,
    description,
    ...(opts.author ? { owner: { name: opts.author } } : {}),
    plugins: [],
  };

  const created: string[] = [];
  writeJson(catalogFile, catalog);
  created.push(catalogFile);

  const readme = join(catalogDir, "README.md");
  writeText(readme, `# ${opts.name}\n\n${description}\n`);
  created.push(readme);

  return { pluginDir: catalogDir, created };
}

/**
 * Scaffold both: a catalog root plus one starter member plugin in a
 * subdirectory (a plugin and a marketplace cannot share one `.agents/` dir, so
 * the member lives under `<name>/<name>/`). The catalog lists the member.
 */
function initAll(opts: InitOptions): InitResult {
  const market = initMarketplace(opts);
  const member = initPlugin({ ...opts, dir: join(opts.dir, opts.name) });
  // Link the starter member into the catalog (source relative to the catalog's
  // grandparent, i.e. the repo root that holds `.agents/`).
  const catalogFile = join(opts.dir, opts.name, ADG_MARKETPLACE_PATH);
  const catalog: Marketplace = {
    name: opts.name,
    description: opts.description ?? `${opts.name} marketplace.`,
    ...(opts.author ? { owner: { name: opts.author } } : {}),
    plugins: [{ name: opts.name, source: { source: "local", path: `./${opts.name}` } }],
  };
  writeJson(catalogFile, catalog);
  return { pluginDir: join(opts.dir, opts.name), created: [...market.created, ...member.created] };
}
