import Link from "next/link";

const METER_BARS = 56;

function AmbientMeter() {
  return (
    <div
      aria-hidden
      className="flex h-24 w-full max-w-xl items-end gap-[3px] sm:h-28"
    >
      {Array.from({ length: METER_BARS }).map((_, i) => {
        const delay = ((i * 0.13) % 2.4).toFixed(2);
        const duration = (2 + ((i * 7) % 5) * 0.24).toFixed(2);
        return (
          <div
            key={i}
            className="meter-bar h-full flex-1 bg-signal-cyan"
            style={{ animationDelay: `${delay}s`, animationDuration: `${duration}s` }}
          />
        );
      })}
    </div>
  );
}

const STEPS = [
  {
    number: "01",
    title: "Start",
    body: "Grants microphone access, then prompts you to share a tab or screen with audio for the other side of the call.",
  },
  {
    number: "02",
    title: "Groq transcribes",
    body: "Every ~10 seconds, both channels are sent to Groq's Whisper API using your own key and transcribed.",
  },
  {
    number: "03",
    title: "Stays with you",
    body: "The transcript, summary, and full history live in this browser only — exportable anytime, never on a server you don't control.",
  },
];

export default function Landing() {
  return (
    <div className="flex flex-1 flex-col bg-background font-sans">
      <header className="w-full border-b border-hairline bg-panel/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <span className="text-[13px] font-semibold uppercase tracking-[0.16em] text-foreground">
            Enclave AI
          </span>
          <Link
            href="/app"
            className="border border-hairline px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            Open console
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-16 px-4 py-14 sm:px-6 sm:py-20">
        {/* Hero */}
        <section className="flex flex-col gap-6">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            Personal recording console
          </span>
          <h1 className="max-w-2xl text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl">
            Transcribe your meetings — on your own terms.
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-muted">
            Enclave AI captures your microphone and the call audio playing in your browser tab,
            sends both straight to Groq for transcription using your own API key, and keeps the
            transcript in this browser. Nothing passes through a server its creator operates.
          </p>
          <div className="mt-4">
            <AmbientMeter />
          </div>
        </section>

        {/* Disclaimer, bound directly to the CTA — the point of entry into
            the tool doubles as where the warning is actually read. */}
        <section className="border border-hairline border-l-2 border-l-signal-amber bg-panel p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-signal-amber" aria-hidden />
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-foreground">
                Before you record, this is on you.
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-foreground/80">
                Recording other people may require their consent under the laws of your state,
                country, or organization. You&apos;re responsible for knowing and following those
                rules. This is a personal tool — its creator isn&apos;t responsible for how you
                use it.
              </p>
              <div className="mt-2">
                <Link
                  href="/app"
                  className="inline-block bg-signal-amber px-5 py-2.5 text-sm font-semibold text-signal-amber-ink transition-opacity hover:opacity-90"
                >
                  Open console
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* How it works — a real sequence (start, then transcribe, then
            persist), so numbering carries actual order, not decoration. */}
        <section className="flex flex-col gap-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            How it works
          </h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            {STEPS.map((step) => (
              <div key={step.number} className="flex flex-col gap-2 border-t border-hairline pt-4">
                <span className="font-mono text-xs text-signal-cyan">{step.number}</span>
                <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{step.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-xs leading-relaxed text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-md">
            Built for one — no accounts, no tracking, no server standing between you and your own
            transcript. Your Groq and OpenRouter keys stay in this browser.
          </p>
          <Link href="/app" className="shrink-0 text-foreground/80 underline underline-offset-2 hover:text-foreground">
            Open console →
          </Link>
        </div>
      </footer>
    </div>
  );
}
