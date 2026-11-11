import WalletProvider from "../components/WalletProvider";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
    <html lang="en">
      <body>
        <WalletProvider contractId={contractId} network={network}>
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
