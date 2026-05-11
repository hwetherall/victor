// STORY-009: register the bottoms-up-financial-model skill with Anthropic.
//
// Reads files from skills/bottoms-up-financial-model/ and uploads them as a
// custom skill. SKILL.md must be at the root of the directory; the SDK
// extracts `name` and `description` from its frontmatter and uses the
// description as the routing signal in the agent's context.
//
// Run: npx tsx scripts/register-bottoms-up-skill.ts
// Idempotent: refuses to re-register if BOTTOMS_UP_SKILL_ID is already set.
// Run with --force to create a new version regardless.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";

const SKILL_DIR = path.resolve("skills/bottoms-up-financial-model");
const SKILL_FOLDER_NAME = "bottoms-up-financial-model"; // becomes the top-level dir Anthropic expects
// Anthropic enforces unique display_title across an org's skills, so each
// fresh upload (when versions.create isn't viable) gets a timestamp suffix.
const DISPLAY_TITLE = `Bottoms-up financial model (${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)})`;

interface SkillFile {
  /** Relative path from the skill root, e.g. "SKILL.md" or "scripts/build-model.py". */
  relPath: string;
  absPath: string;
  size: number;
}

/** Walk the skill directory and collect file paths. SKILL.md must be present. */
function collectSkillFiles(root: string): SkillFile[] {
  const out: SkillFile[] = [];
  function walk(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        out.push({ relPath: rel, absPath: abs, size: stat.size });
      }
    }
  }
  walk(root, "");
  if (!out.some((f) => f.relPath === "SKILL.md")) {
    throw new Error(`No SKILL.md at root of ${root}`);
  }
  return out;
}

async function main() {
  const force = process.argv.includes("--force");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("✗ ANTHROPIC_API_KEY missing from .env.local");
    process.exit(1);
  }

  if (process.env.BOTTOMS_UP_SKILL_ID && !force) {
    console.log(
      `• BOTTOMS_UP_SKILL_ID already set: ${process.env.BOTTOMS_UP_SKILL_ID}`,
    );
    console.log("  Re-run with --force to upload a new version.");
    return;
  }

  const files = collectSkillFiles(SKILL_DIR);
  console.log(`• Skill files (${files.length}):`);
  for (const f of files) {
    console.log(`  - ${f.relPath} (${f.size} bytes)`);
  }

  const client = new Anthropic();

  // Build the Uploadables. `skills.create` expects files inside a single
  // top-level directory (named after the skill folder) — `skills.versions.
  // create` for an existing skill rejects the prefix and wants the files
  // bare. The path prefix is the only difference between the two calls.
  async function buildUploadables(usePrefix: boolean) {
    return Promise.all(
      files.map((f) => {
        const buf = fs.readFileSync(f.absPath);
        const mime = f.relPath.endsWith(".md")
          ? "text/markdown"
          : f.relPath.endsWith(".py")
            ? "text/x-python"
            : f.relPath.endsWith(".xlsx")
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "application/octet-stream";
        const name = usePrefix ? `${SKILL_FOLDER_NAME}/${f.relPath}` : f.relPath;
        return toFile(new Uint8Array(buf), name, { type: mime });
      }),
    );
  }

  console.log("• Uploading skill to Anthropic...");
  let skillId: string;
  let version: string;

  if (force && process.env.BOTTOMS_UP_SKILL_ID) {
    skillId = process.env.BOTTOMS_UP_SKILL_ID;
    const uploadables = await buildUploadables(false); // versions.create rejects prefix
    const v = await client.beta.skills.versions.create(skillId, {
      files: uploadables,
    });
    version = v.version;
    console.log(`  ✓ New version of existing skill ${skillId}: ${version}`);
  } else {
    const uploadables = await buildUploadables(true);
    const skill = await client.beta.skills.create({
      display_title: DISPLAY_TITLE,
      files: uploadables,
    });
    skillId = skill.id;
    version = skill.latest_version ?? "";
    console.log(`  ✓ Skill: ${skillId} (latest_version=${version || "(unset)"})`);
  }

  console.log("\nAdd to .env.local:");
  console.log("---");
  console.log(`BOTTOMS_UP_SKILL_ID=${skillId}`);
  if (version) console.log(`BOTTOMS_UP_SKILL_VERSION=${version}`);
  console.log("---");
  console.log(
    "\nThen unset INVESTIGATOR_AGENT_ID and re-run scripts/register-investigator.ts " +
      "to attach the skill to the Investigator (a new agent version will be created).",
  );
}

main().catch((e) => {
  console.error("✗ register-bottoms-up-skill failed:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
