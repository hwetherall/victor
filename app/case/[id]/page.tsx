import { notFound } from "next/navigation";
import Link from "next/link";
import { loadCase, loadFramework } from "@/lib/framework-registry";
import { CaseView, type FrameworkSummary } from "@/components/CaseView";

export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let config;
  try {
    config = loadCase(id);
  } catch {
    notFound();
  }

  let frameworkSummary: FrameworkSummary;
  try {
    const framework = loadFramework(config.frameworkId);
    // Flatten Tier-1 slots + sub-slots into a templateId → displayLabel map so
    // the kanban can recover the short partner-facing label even for cached
    // runs whose tree_nodes.content.displayLabel is missing (e.g. runs created
    // before the framework grew displayLabels).
    const displayLabelByTemplateId: Record<string, string> = {};
    for (const slot of framework.tiers[0].slots) {
      if (slot.displayLabel) displayLabelByTemplateId[slot.id] = slot.displayLabel;
      for (const sub of slot.decomposition ?? []) {
        if (sub.displayLabel) displayLabelByTemplateId[sub.id] = sub.displayLabel;
      }
    }
    frameworkSummary = {
      id: framework.id,
      name: framework.name,
      tiers: framework.tiers.map((t) => ({ id: t.id, name: t.name })),
      tier2ActivatesIf: framework.tiers[1]?.activatesIf ?? null,
      displayLabelByTemplateId,
    };
  } catch {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="border-b border-neutral-800 pb-6">
        <a href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← all cases
        </a>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {config.title}
        </h1>
        <p className="mt-3 text-sm text-neutral-300">{config.question}</p>
      </header>

      <CaseView
        caseConfigId={id}
        config={config}
        framework={frameworkSummary}
      />

      <div>
        <Link
          href={`/case/${id}/memo`}
          className="inline-flex rounded-full border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
        >
          Ask Micky
        </Link>
      </div>
    </main>
  );
}
