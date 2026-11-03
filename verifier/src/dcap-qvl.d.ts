// Minimal ambient typing for the lazy live-path DCAP verifier. The live
// quote check dynamic-imports `@phala/dcap-qvl` behind a webpackIgnore hint
// so route bundles never need it statically; this declaration keeps
// typechecking offline-safe. The real package ships its own types.
declare module "@phala/dcap-qvl" {
  export function getCollateralAndVerify(
    quote: Uint8Array,
    ...args: unknown[]
  ): Promise<unknown>;
}
