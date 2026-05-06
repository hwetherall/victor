function readRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env.local and fill in values, ` +
        `or run \`npx @insforge/cli secrets get ANON_KEY\` for the InsForge anon key.`,
    );
  }
  return value;
}

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const config = {
  get insforgeUrl() {
    return readRequired("NEXT_PUBLIC_INSFORGE_URL");
  },
  get insforgeAnonKey() {
    return readRequired("NEXT_PUBLIC_INSFORGE_ANON_KEY");
  },
  get insforgeApiKey() {
    return readOptional("INSFORGE_API_KEY");
  },
  get openRouterKey() {
    return readRequired("OPENROUTER_API_KEY");
  },
  get anthropicKey() {
    return readOptional("ANTHROPIC_API_KEY");
  },
  get openAiKey() {
    return readRequired("OPENAI_API_KEY");
  },
  get tavilyKey() {
    return readRequired("TAVILY_API_KEY");
  },
};
