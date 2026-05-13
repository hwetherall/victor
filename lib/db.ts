import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";

// Shim: callers use insforge.database.from() and insforge.storage.from()
// The Supabase client exposes .from() directly, so database = the client itself.
type InsforgeShim = {
  database: SupabaseClient;
  storage: SupabaseClient["storage"];
};

let cached: InsforgeShim | undefined;

function getClient(): InsforgeShim {
  if (!cached) {
    const client = createClient(config.insforgeUrl, config.insforgeAnonKey);
    cached = { database: client, storage: client.storage };
  }
  return cached;
}

export const insforge: InsforgeShim = new Proxy({} as InsforgeShim, {
  get(_target, prop) {
    return Reflect.get(getClient(), prop);
  },
});
