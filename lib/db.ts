import { createClient } from "@insforge/sdk";
import { config } from "./config";

export const insforge = createClient({
  baseUrl: config.insforgeUrl,
  anonKey: config.insforgeAnonKey,
});
