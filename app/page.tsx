import { JevWorldApp } from "./JevWorldApp";
import { SetupRequired } from "./SetupRequired";

// Server Component: show setup instructions until REACTOR_API_KEY is set.
// (OPENROUTER_API_KEY is checked lazily by the API routes, so you can scout
// levels by hand before adding it.)
export const dynamic = "force-dynamic";

export default function Page() {
  return process.env.REACTOR_API_KEY ? <JevWorldApp /> : <SetupRequired />;
}
