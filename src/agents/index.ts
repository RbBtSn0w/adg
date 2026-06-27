import { registerAgent } from "./registry.ts";
import { claudeAgent } from "./claude.ts";
import { codexAgent } from "./codex.ts";
import { antigravityAgent } from "./antigravity.ts";

// Built-in agents register on import. Third-party agents can `registerAgent()`
// their own implementation (stage 2: discover from config without core edits).
registerAgent(claudeAgent);
registerAgent(codexAgent);
registerAgent(antigravityAgent);

export * from "./types.ts";
export { registerAgent, getAgent, allAgents, detectedAgents, resolveAgents, agentsForComponents } from "./registry.ts";
export { claudeMarketplaceName, writeClaudeCatalog } from "./claude.ts";
export { codexMarketplaceName, writeCodexMarketplaceName } from "./codex.ts";
