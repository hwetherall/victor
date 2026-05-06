import { createClient } from "@insforge/sdk";
import { config } from "./config";

type InsforgeClient = ReturnType<typeof createClient>;

let cached: InsforgeClient | undefined;

function getInsforge(): InsforgeClient {
  if (!cached) {
    cached = createClient({
      baseUrl: config.insforgeUrl,
      anonKey: config.insforgeAnonKey,
    });
  }
  return cached;
}

/** Lazy client so `next build` does not require InsForge env at module load (e.g. Vercel). */
export const insforge: InsforgeClient = new Proxy({} as InsforgeClient, {
  get(_target, prop) {
    const client = getInsforge();
    const value = Reflect.get(client, prop, client);
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});
