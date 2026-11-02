import { SignInButton } from "@clerk/nextjs";

export function Landing() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-4">
        <p className="font-mono text-sm text-emerald-600 dark:text-emerald-400">phishwatch</p>
        <h1 className="text-4xl font-semibold tracking-tight">Spot lookalike domains the moment they get an HTTPS certificate.</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Tell phishwatch your brand. Every 10 seconds it reads newly issued certificates from a public Certificate
          Transparency log and shows you, live, any domain that looks like it&apos;s impersonating you, often before the
          first phishing email goes out.
        </p>
      </div>

      <ul className="grid gap-3 text-sm sm:grid-cols-3">
        {[
          ["Your brand", "Your official domains and the words a phisher would borrow."],
          ["Live feed", "Matches appear without a refresh, scored and explained."],
          ["Safe to read", "Suspect domains are defanged and never linked."],
        ].map(([title, body]) => (
          <li key={title} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <p className="font-medium">{title}</p>
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">{body}</p>
          </li>
        ))}
      </ul>

      <div>
        <SignInButton mode="modal">
          <button className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
            Sign in to start watching
          </button>
        </SignInButton>
        <p className="mt-3 text-xs text-zinc-500">Email code sign-in. Free; no card.</p>
      </div>
    </main>
  );
}
