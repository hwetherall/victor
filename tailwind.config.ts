import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        confidence: {
          high: "#10b981",
          mid: "#f59e0b",
          low: "#ef4444",
        },
      },
    },
  },
  plugins: [],
};

export default config;
