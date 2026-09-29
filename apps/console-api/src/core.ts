// Server wasm: catalog, prices, and bundle overrides. Same artifact ingest uses.
import { readFileSync } from "node:fs";

export interface CatalogRule {
  id: string;
  title: string;
  provider: string;
  service: string;
  severity: string;
  category: string;
  evaluation: string;
  status: string;
  default_enabled: boolean;
  summary: string;
  description: string;
  fix: string;
  docs: string[];
  params: Record<string, number | boolean | string>;
  examples: unknown[];
}

export interface Catalog {
  rules: CatalogRule[];
}

export interface PriceLine {
  unit: string;
  amount: number;
  micros: number;
  unknown?: boolean;
}

export interface PriceResult {
  currency: string;
  micros: number;
  lines: PriceLine[];
}

export interface ServerCore {
  catalog(): Catalog;
  price(units: Record<string, number>, provider: string, service: string): PriceResult;
  applyOverrides(bundle: Uint8Array, overridesJson: string): Uint8Array;
}

interface WasmServer {
  initSync(options: { module: Buffer }): void;
  catalog_json(): string;
  price_json(unitsJson: string, provider: string, service: string): string;
  bundle_with_overrides(bundle: Uint8Array, overridesJson: string): Uint8Array;
}

let loaded: ServerCore | undefined;

export async function loadCore(): Promise<ServerCore> {
  if (loaded) return loaded;
  const pkg = new URL("../../ingest/wasm/", import.meta.url);
  const mod = (await import(new URL("readmeter_wasm_server.js", pkg).href).catch(() => {
    throw new Error("Rust core not built: run ./scripts/build-wasm-server.sh");
  })) as WasmServer;
  mod.initSync({ module: readFileSync(new URL("readmeter_wasm_server_bg.wasm", pkg)) });
  loaded = {
    catalog() {
      return JSON.parse(mod.catalog_json()) as Catalog;
    },
    price(units, provider, service) {
      const integers: Record<string, number> = {};
      for (const [unit, amount] of Object.entries(units)) {
        integers[unit] = Math.max(0, Math.round(amount));
      }
      return JSON.parse(mod.price_json(JSON.stringify(integers), provider, service)) as PriceResult;
    },
    applyOverrides(bundle, overridesJson) {
      const out = mod.bundle_with_overrides(bundle, overridesJson);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    },
  };
  return loaded;
}

/** Sum of priced groups. Each group is one provider, service, and its units. */
export function priceGroups(
  core: ServerCore,
  groups: { provider: string; service: string; unit: string; amount: number }[],
): number {
  const byService = new Map<string, Record<string, number>>();
  for (const group of groups) {
    const key = `${group.provider}\0${group.service}`;
    const units = byService.get(key) ?? {};
    units[group.unit] = (units[group.unit] ?? 0) + group.amount;
    byService.set(key, units);
  }
  let micros = 0;
  for (const [key, units] of byService) {
    const split = key.indexOf("\0");
    micros += core.price(units, key.slice(0, split), key.slice(split + 1)).micros;
  }
  return micros;
}
