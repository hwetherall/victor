export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-16">
      <header className="border-b border-neutral-800 pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Agent Victor</h1>
        <p className="mt-2 text-sm text-neutral-400">
          MBB-style AI decision framework. Pick a case to begin.
        </p>
      </header>

      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Cases
        </h2>
        <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          <li>
            <a
              href="/case/abb-rack-pdu"
              className="flex items-center justify-between px-5 py-4 hover:bg-neutral-900"
            >
              <div>
                <p className="font-medium">ABB Rack PDU Market Entry</p>
                <p className="mt-1 text-sm text-neutral-400">
                  Should ABB pursue the rack PDU business, and if yes, build /
                  buy / partner?
                </p>
              </div>
              <span className="text-xs text-neutral-500">v1 demo →</span>
            </a>
          </li>
        </ul>
      </section>
    </main>
  );
}
