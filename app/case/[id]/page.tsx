import { notFound } from "next/navigation";
import { loadCase } from "@/lib/framework-registry";
import { CaseView } from "@/components/CaseView";

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

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="border-b border-neutral-800 pb-6">
        <a href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← all cases
        </a>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {config.title}
        </h1>
        <p className="mt-3 text-sm text-neutral-300">{config.question}</p>
      </header>

      <CaseView caseConfigId={id} config={config} />
    </main>
  );
}
