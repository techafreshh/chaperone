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
      <section aria-label="Operator">
        <h2>Operator wallet</h2>
        <p>
          Connect with your NEAR wallet to sign owner actions. The contract
          owner check is the only authorization; the app server holds no
          owner key.
        </p>
        <WalletConnect />
      </section>
      <section aria-label="Verifier">
        <h2>Purpose verifier key</h2>
        <p>
          The Ed25519 verifier public key the guard checks verdict signatures
          against. Rotating the verifier key takes effect for new verdicts.
        </p>
        <VerifierKeyForm
          contractId={contractId}
          network={network}
          currentKey={verifierKey}
        />
        <div data-testid="badge-preview">{previewLabel}</div>
      </section>
    </main>
  );
}
