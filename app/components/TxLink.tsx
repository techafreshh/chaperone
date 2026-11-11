import { explorerTxUrl } from "./WalletProvider";

// Chain transaction hash → testnet/mainnet explorer link. Empty hashes
// (fixture `sample data` cells carry none) render as plain text so stub
// rows never link anywhere.
export default function TxLink({
  hash,
  network = "testnet",
}: {
  hash: string | null | undefined;
  network?: string;
}) {
  if (typeof hash !== "string" || hash.trim() === "") {
    return <span>{hash ?? ""}</span>;
  }
  const url = explorerTxUrl(hash.trim(), network);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="break-all text-sky-300 underline"
    >
      {url}
    </a>
  );
}
