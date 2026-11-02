import { PhishwatchApp } from "@/components/PhishwatchApp";

// A static shell: everything signed-in happens in the browser (Clerk session -> Supabase
// RLS queries + Realtime), so nothing here reads the request and the page prerenders.
export default function Home() {
  return <PhishwatchApp />;
}
