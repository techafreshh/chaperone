import { getStatus } from "../../../verifier/src/preflight";
import VerifierKeyForm from "../../components/VerifierKeyForm";
import WalletConnect from "../../components/WalletConnect";
import { getVerifierKey } from "../../lib/settings";

export const dynamic = "force-dynamic";

// Operator settings: wallet connection plus the wallet-signed verifier
// key rotation form with an honest badge preview. No server sessions;
// wallet connection state lives in the browser. Reads stay public; live
// rotation is signed by the owner wallet (`set_verifier`), fixture
// rotation POSTs to the server overlay.
export default async function SettingsPage() {
  const verifierKey = await getVerifierKey();
  const status = getStatus();
  const previewLabel =
    status.badge === "verified"
      ? "TEE-verified"
      : status.badge === "unverifiable"
        ? "unverifiable"
        : "deterministic-only";
  const contractId = (
    process.env.GUARD_CONTRACT_ID ??
    process.env.NEAR_CONTRACT_ID ??
    ""
  ).trim();
  const network =
    (process.env.NEAR_NETWORK ?? "").trim() === "mainnet"
      ? "mainnet"
      : "testnet";
  return (
    <main>
      <h1>Settings</h1>
      <section
        aria-label="Operator"
        className="mt-4 rounded-lg border border-slate-700 bg-slate-900 p-4"
      >
        <h2>Operator wallet</h2>
        <p className="mt-1 text-sm text-slate-300">
          Connect with your NEAR wallet to sign owner actions. The contract
          owner check is the only authorization; the app server holds no
          owner key.
        </p>
        <div className="mt-2">
          <WalletConnect />
        </div>
      </section>
      <section
        aria-label="Verifier"
        className="mt-6 rounded-lg border border-slate-700 bg-slate-900 p-4"
      >
        <h2>Purpose verifier key</h2>
        <p className="mt-1 text-sm text-slate-300">
          The Ed25519 verifier public key the guard checks verdict signatures
          against. Rotating the verifier key takes effect for new verdicts.
        </p>
        <div className="mt-2">
          <VerifierKeyForm
            contractId={contractId}
            network={network}
            currentKey={verifierKey}
          />
        </div>
        <div
          data-testid="badge-preview"
          className="mt-2 inline-block rounded-full border border-slate-500 bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-200"
        >
          {previewLabel}
        </div>
      </section>
    </main>
  );
}
