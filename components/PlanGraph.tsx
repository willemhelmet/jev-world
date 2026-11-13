"use client";

import { useEffect, useId, useRef, useState } from "react";
import { planToMermaid, type Plan } from "@/lib/level";

// Live view of the planner's graph: the player's current state is lit up.
export function PlanGraph({ plan, current }: { plan: Plan; current: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [error, setError] = useState<string | null>(null);
  const [showSrc, setShowSrc] = useState(false);
  const src = planToMermaid(plan, current);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          themeVariables: { fontSize: "12px", primaryColor: "#14171c", primaryBorderColor: "#3a404b", lineColor: "#59616e" },
        });
        const { svg } = await mermaid.render(`plan${id}${Date.now()}`, src);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [src, id]);

  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="label">Plan graph (planner)</h3>
        <button className="label hover:text-zinc-300" onClick={() => setShowSrc((v) => !v)}>
          {showSrc ? "graph" : "mermaid"}
        </button>
      </div>
      {showSrc ? (
        <pre className="max-h-72 overflow-auto rounded-md border border-white/10 bg-black/40 p-2 text-[10px] text-zinc-400">{src}</pre>
      ) : (
        <div ref={ref} className="flex justify-center overflow-x-auto rounded-md border border-white/10 bg-black/30 p-2 [&_svg]:max-w-full" />
      )}
      {error && <p className="text-[10px] text-red-300">{error}</p>}
    </section>
  );
}
