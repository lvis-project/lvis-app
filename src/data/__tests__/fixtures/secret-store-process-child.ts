import { SecretDocumentStore } from "../../secret-document-store.js";

const [, , command, path, ...args] = process.argv;
const [key, value] = args;

const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret" as const,
  encryptString: (plaintext: string) => Buffer.from(`sealed:${plaintext}`, "utf-8"),
  decryptString: (ciphertext: Buffer) => {
    const decoded = ciphertext.toString("utf-8");
    if (!decoded.startsWith("sealed:")) throw new Error("invalid test ciphertext");
    return decoded.slice(7);
  },
};

const store = new SecretDocumentStore({ path, policy: "packaged", encryption });

if (command === "set") {
  await store.set(key, value);
} else if (command === "delete") {
  await store.delete(key);
} else if (command === "delete-many") {
  await store.deleteMany(args);
} else {
  throw new Error(`unknown secret-store child command: ${String(command)}`);
}
