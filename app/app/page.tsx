import Link from "next/link";

// Landing page: one sentence on the problem, one on what Chaperone does,
// the three checks in order (on-chain rules, then the purpose judge, then
// a human), and a link straight to the blocked-payment example in
// `/requests`. Keeps the `Chaperone` heading and the product sentence.
export default function Home() {
  return (
    <main>
      <h1>Chaperone</h1>
      <p className="mt-2 text-lg text-slate-200">
        Mission control for money-handling AI agents on NEAR.
      </p>
      <p className="mt-4 max-w-2xl text-slate-300">
        Autonomous agents pay poisoned invoices under their limits: a vendor
        swaps the payee, inflates the amount, or invents a charge, and the
        transfer looks routine.
      </p>
      <p className="mt-2 max-w-2xl text-slate-300">
        Chaperone verifies what agents pay for before money moves, enforced
        by the on-chain guard contract.
      </p>
      <ol className="mt-6 max-w-2xl list-decimal space-y-2 pl-6 text-slate-200">
        <li>
          <strong className="text-white">On-chain rules</strong> check the
          agent, its daily allowance and per-payment cap, the allowlist, and
          the purpose reference at intake.
        </li>
        <li>
          <strong className="text-white">The purpose judge</strong> compares
          the agent&apos;s stated reason against the invoice and holds the
          request when they do not match.
        </li>
        <li>
          <strong className="text-white">A human</strong> approves or rejects
          the held request from the queue with the owner wallet.
        </li>
      </ol>
      <p className="mt-6">
        <Link
          href="/requests#request-2"
          className="inline-block rounded bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-500"
        >
          See the blocked payment
        </Link>
      </p>
      <p className="mt-2 text-sm text-slate-400">
        Request 2 in <Link href="/requests">/requests</Link> was rejected:{" "}
        <code>PayeeNotAllowlisted</code> on purpose ref{" "}
        <code>invoice-114</code>.
      </p>
    </main>
  );
}
