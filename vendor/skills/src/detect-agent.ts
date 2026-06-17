import { determineAgent } from '@vercel/detect-agent';
import { setDetectedAgent } from './telemetry.ts';
import type { AgentType } from './types.ts';

// ADG patch: the pinned @vercel/detect-agent@0.1.0 exposes only
// `determineAgent(): Promise<string | false>` and does NOT export `AgentResult`.
// The upstream fork was written against a newer API that returns a rich object,
// so importing the type broke typecheck and `cachedResult.isAgent` was always
// undefined at runtime (agent auto-detection silently never fired). We define
// the shape locally and adapt the `string | false` result in `detectAgent()`.
// See vendor/skills/PROVENANCE.md.
export interface AgentResult {
  isAgent: boolean;
  agent: { name: string };
}

let cachedResult: AgentResult | null = null;

/**
 * Map from @vercel/detect-agent names to skills-cli AgentType identifiers.
 * Only includes agents that exist in both systems.
 */
const agentNameToType: Record<string, AgentType> = {
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  claude: 'claude-code',
  cowork: 'claude-code',
  devin: 'universal', // Devin not in skills-cli agent list, use universal
  replit: 'replit',
  gemini: 'gemini-cli',
  codex: 'codex',
  antigravity: 'antigravity',
  'augment-cli': 'augment',
  opencode: 'opencode',
  'github-copilot': 'github-copilot',
};

/**
 * Detect if the CLI is being run inside an AI agent environment.
 * Results are cached after the first call. Also updates telemetry with the agent name.
 */
export async function detectAgent(): Promise<AgentResult> {
  if (cachedResult) return cachedResult;
  // determineAgent() returns the agent name (e.g. 'cursor', 'claude') or false.
  const name = await determineAgent();
  cachedResult = name ? { isAgent: true, agent: { name } } : { isAgent: false, agent: { name: '' } };
  if (cachedResult.isAgent) {
    setDetectedAgent(cachedResult.agent.name);
  }
  return cachedResult;
}

/**
 * Returns true if the CLI is running inside a detected AI agent.
 * When true, the CLI should skip interactive prompts and use sensible defaults.
 */
export async function isRunningInAgent(): Promise<boolean> {
  const result = await detectAgent();
  return result.isAgent;
}

/**
 * Returns the name of the detected agent, or null if not running in an agent.
 */
export async function getAgentName(): Promise<string | null> {
  const result = await detectAgent();
  return result.isAgent ? result.agent.name : null;
}

/**
 * Maps a detected agent name to the corresponding skills-cli AgentType.
 * Returns null if the agent can't be mapped to a specific skills-cli agent.
 */
export function getAgentType(agentName: string): AgentType | null {
  return agentNameToType[agentName] ?? null;
}
