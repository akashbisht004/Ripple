import RippleDashboard from "@/components/RippleDashboard";

export default function Home() {
  return (
    <main className="page">
      <section className="hero">
        <h1>
          What else could <em>this change</em> break?
        </h1>
        <p>
          RIPPLE traverses the code graph in <strong>FalkorDB</strong> — imports, call graph, API routes,
          bug history mined from git — and shows the blast radius of a PR, with evidence for every claim.
        </p>
      </section>
      <RippleDashboard />
    </main>
  );
}
