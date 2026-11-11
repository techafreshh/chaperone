import Link from "next/link";
import WalletConnect from "./WalletConnect";
import { explorerAddressUrl } from "./WalletProvider";

const NAV_LINKS = [
  { href: "/fleet", label: "Fleet" },
  { href: "/requests", label: "Requests" },
  { href: "/queue", label: "Queue" },
  { href: "/receipts", label: "Receipts" },
  { href: "/settings", label: "Settings" },
];

// Shared operator header (server component): product name, network label,
// guard contract id linked to the explorer, client wallet state, and nav
// to all five routes. Rendered once by the root layout so every page
// carries the same navigation.
export default function SiteHeader({
  contractId,
  network,
}: {
  contractId: string;
  network: string;
}) {
  return (
    <header className="border-b border-slate-700 bg-slate-900">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-bold text-white no-underline">
          Chaperone
        </Link>
        <span className="rounded-full border border-slate-600 px-2 py-0.5 text-xs font-semibold text-slate-300">
          {network}
        </span>
        {contractId !== "" ? (
          <a
            href={explorerAddressUrl(contractId, network)}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-xs text-sky-300"
          >
            {contractId}
          </a>
        ) : (
          <span className="text-xs text-slate-400">guard contract not configured</span>
        )}
        <div className="ml-auto text-sm text-slate-200">
          <WalletConnect />
        </div>
      </div>
      <nav aria-label="Operator" className="mx-auto w-full max-w-6xl px-4 pb-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-medium">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="text-sky-300 hover:text-sky-100">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
