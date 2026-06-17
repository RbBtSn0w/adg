import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Marketplace, MarketplacePlugin } from "./types.ts";

export function emptyMarketplace(name: string): Marketplace {
  return { name, plugins: [] };
}

/**
 * Read a marketplace file. This file is the runtime-facing export (consumed by
 * Codex), kept in the de-facto shape; ADG never treats it as its own control
 * surface (that is the lock). The reader is tolerant: only structural fields are
 * checked and unknown fields are preserved.
 */
export function readMarketplace(file: string, fallbackName: string): Marketplace {
  if (!existsSync(file)) return emptyMarketplace(fallbackName);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Marketplace;
  if (typeof raw.name !== "string" || !Array.isArray(raw.plugins)) {
    throw new Error(`${file} is not a valid marketplace.json`);
  }
  return raw;
}

export function writeMarketplace(file: string, market: Marketplace): void {
  writeFileSync(file, JSON.stringify(market, null, 2) + "\n");
}

/** Insert or replace a plugin entry by name, preserving array order. */
export function upsertMarketplacePlugin(market: Marketplace, plugin: MarketplacePlugin): Marketplace {
  const idx = market.plugins.findIndex((p) => p.name === plugin.name);
  if (idx >= 0) market.plugins[idx] = plugin;
  else market.plugins.push(plugin);
  return market;
}

/** Remove a plugin entry by name. Returns true if one was removed. */
export function removeMarketplacePlugin(market: Marketplace, name: string): boolean {
  const idx = market.plugins.findIndex((p) => p.name === name);
  if (idx < 0) return false;
  market.plugins.splice(idx, 1);
  return true;
}
