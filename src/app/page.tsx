import Image from "next/image";

export default function Home() {
  const twilioNumber = process.env.TWILIO_WHATSAPP_NUMBER?.replace("whatsapp:", "") ?? "+17372508034";
  const sandboxJoinMsg = "join twilio-trial";

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 font-sans text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 px-8 py-4 flex items-center gap-3">
        <Image src="/Arbiter-logo.png" alt="Arbiter Logo" width={28} height={28} className="object-contain" />
        <h1 className="text-xl font-bold tracking-tight">Arbiter</h1>
        <span className="ml-auto text-xs text-zinc-500 font-mono">Razorpay Buildathon · Track 05</span>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="max-w-2xl">
          <div className="inline-block bg-zinc-800 text-zinc-300 text-xs font-mono px-3 py-1 rounded-full mb-6">
            WhatsApp-native · AI-powered · Razorpay Escrow
          </div>
          <h2 className="text-5xl font-extrabold tracking-tight leading-tight mb-4">
            Freelance contracts,<br />
            <span className="text-emerald-400">without the risk.</span>
          </h2>
          <p className="text-zinc-400 text-lg leading-relaxed mb-10">
            Arbiter holds your money in escrow, tracks every revision, and if
            there&apos;s a dispute — an AI Judge reads the evidence and splits
            the payment fairly. No lawyers. No ghosting. No lost money.
          </p>

          {/* Steps */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12 text-left">
            {[
              { emoji: "📋", title: "1. Create Contract", desc: "Freelancer sets work, amount, and revisions via WhatsApp." },
              { emoji: "💳", title: "2. Client Pays Escrow", desc: "Client pays via Razorpay link. Funds are locked until approval." },
              { emoji: "⚖️", title: "3. AI Resolves Disputes", desc: "If disagreement arises, Gemini AI reads the evidence log and rules fairly." },
            ].map((step) => (
              <div key={step.title} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="text-2xl mb-2">{step.emoji}</div>
                <div className="font-semibold text-sm mb-1">{step.title}</div>
                <div className="text-zinc-400 text-sm">{step.desc}</div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 text-left">
            <h3 className="font-bold text-lg mb-3">🚀 Try it on WhatsApp</h3>
            <p className="text-zinc-400 text-sm mb-4">
              Join the Twilio Sandbox, then text the bot to get started.
            </p>
            <ol className="text-sm text-zinc-300 space-y-2 list-decimal list-inside mb-4">
              <li>
                Save <span className="font-mono bg-zinc-800 px-1.5 py-0.5 rounded text-emerald-400">{twilioNumber}</span> in your contacts
              </li>
              <li>
                Send the message: <span className="font-mono bg-zinc-800 px-1.5 py-0.5 rounded text-emerald-400">{sandboxJoinMsg}</span>
              </li>
              <li>You&apos;re in! Text anything to get started.</li>
            </ol>
            <a
              href={`https://wa.me/${twilioNumber.replace("+", "")}?text=${encodeURIComponent(sandboxJoinMsg)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm"
            >
              <span>Open in WhatsApp</span>
              <span>↗</span>
            </a>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 px-8 py-4 text-center text-xs text-zinc-600">
        <p>Built for Razorpay Buildathon · Sept 2026 · Powered by Twilio, Razorpay, Supabase, Gemini</p>
        <p className="mt-2">
          Designed & Developed By <a href="https://itsashutoshpathak.vercel.app/" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">Ashutosh Pathak</a>
        </p>
      </footer>
    </div>
  );
}
