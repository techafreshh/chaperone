import books from "../data/books.json";

export interface BookEntry {
  id: string;
  vendor: string;
  payee: string;
  cap_near: string;
  description: string;
}

const YOCTO_DECIMALS = 24;

export function capToYocto(capNear: string): string {
  if (typeof capNear !== "string" || capNear.length === 0) {
    throw new Error(`Invalid cap_near: ${JSON.stringify(capNear)}`);
  }
  if (!/^\d+(\.\d+)?$/.test(capNear)) {
    throw new Error(`Invalid cap_near: ${JSON.stringify(capNear)}`);
  }
  const [whole, frac = ""] = capNear.split(".");
  if (frac.length > YOCTO_DECIMALS) {
    throw new Error(`Invalid cap_near: ${JSON.stringify(capNear)}`);
  }
  const paddedFrac = (frac + "0".repeat(YOCTO_DECIMALS)).slice(0, YOCTO_DECIMALS);
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const yocto =
    BigInt(normalizedWhole) * BigInt(10) ** BigInt(YOCTO_DECIMALS) +
    BigInt(paddedFrac || "0");
  return yocto.toString();
}

export function listRefs(): BookEntry[] {
  return (books as BookEntry[])
    .map((entry) => ({ ...entry }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function getRef(id: string): BookEntry | undefined {
  return listRefs().find((entry) => entry.id === id);
}
