// One-shot: generates an RSA keypair, derives the deterministic Chrome
// extension ID from the public key, and prints what to paste in manifest.json.
// Saves the private key locally in case we ever want to sign a .crx.
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const pubBase64 = publicKey.toString("base64");

// Chrome derives the ID as: first 16 bytes of SHA-256(public_key_der),
// each nibble mapped to a..p (0->a, 15->p) → 32-char string.
const hash = createHash("sha256").update(publicKey).digest();
let id = "";
for (let i = 0; i < 16; i++) {
  id += String.fromCharCode(97 + (hash[i] >> 4));
  id += String.fromCharCode(97 + (hash[i] & 0x0f));
}

writeFileSync(".extension-key.pem", privateKey);

console.log("\n=== Extension ID (stable across all installs) ===");
console.log(id);
console.log("\n=== manifest.json key (base64 DER pubkey) ===");
console.log(pubBase64);
console.log("\nPrivate key saved to .extension-key.pem (gitignored — keep safe).");
