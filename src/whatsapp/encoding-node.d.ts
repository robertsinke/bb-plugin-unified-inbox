// whatsapp-rust-bridge@0.5.4 (a Baileys dependency) uses `EncodingNode` in two signatures
// (`NoiseSession.encodeFrame`, `encodeNode`) and never declares it. Nothing in the plugin names that
// type — the socket never touches the WASM bridge directly — but the repository checks declaration
// files (`skipLibCheck: false`), so the gap has to be filled for `tsc` to see a consistent tree.
//
// Kept deliberately narrow: one opaque class, no members, because any member here would be a claim
// about a package we do not control.
declare class EncodingNode {}
