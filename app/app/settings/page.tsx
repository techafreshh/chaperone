import { getStatus } from "../../../verifier/src/preflight";
import { getVerifierKey } from "../../lib/settings";

export const dynamic = "force-dynamic";

// Operator settings page (issue #17): NEAR wallet login for the fleet
// owner, verifier-key rotation with an honest badge preview. Server
// rendered with zero client JS so every probe string is in the first HTML
// byte stream. Reads stay public; only rotation writes are owner-gated.
export default async function SettingsPage() {
  const verifierKey = await getVerifierKey();
  const status = getStatus();
  const previewLabel =
    status.badge === "verified"
      ? "TEE-verified"
      : status.badge === "unverifiable"
        ? "unverifiable"
        : "deterministic-only";
  return (
    <main>
      <h1>Settings</h1>
      <section aria-label="Operator">
        <h2>Operator login</h2>
        <p>Sign in with your NEAR wallet account to manage the fleet.</p>
        <form data-testid="login-form" method="post" action="/api/auth/login">
          <label>
            Account ID
            <input name="account_id" placeholder="owner.testnet" />
          </label>
          <button type="submit">Log in</button>
        </form>
        <form data-testid="logout-form" method="post" action="/api/auth/logout">
          <button type="submit">Log out</button>
        </form>
      </section>
      <section aria-label="Verifier">
        <h2>Purpose verifier key</h2>
        <p>
          The Ed25519 verifier public key the guard checks verdict signatures
          against. Rotating the verifier key takes effect for new verdicts.
        </p>
        <p>Current verifier key: {verifierKey ?? "not set"}</p>
        <form
          data-testid="verifier-key-form"
          method="post"
          action="/api/settings/verifier-key"
        >
          <label>
            Verifier key
            <input name="verifier_key" placeholder="base58 ed25519 public key" />
          </label>
          <button type="submit">Rotate verifier key</button>
        </form>
        <div data-testid="badge-preview">{previewLabel}</div>
      </section>
    </main>
  );
}
