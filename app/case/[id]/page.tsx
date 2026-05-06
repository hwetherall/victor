import { notFound } from "next/navigation";
import Link from "next/link";
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
