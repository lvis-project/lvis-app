# Secret encryption for a native host

Host composition supplies a required `SecretEncryption` to `SettingsService`.
The desktop host supplies its existing OS-backed provider. A native host can
use `createNodeSecretEncryption(keyFilePath)` with an operator-provided key.
The provider reports `external_key`; possession of this file does not provide
the protection of an OS keychain.

The key path must be absolute. The file must contain exactly 32 raw random
bytes, have one hard link, belong to the current effective user, and have mode
`0400` or `0600`. Symbolic links at the final path component are rejected;
directory components retain the filesystem's normal resolution rules. The
reader opens without following the final link, validates descriptor and path
identity, reads the bytes twice, and rejects changes to content, ownership,
permissions or file identity during that read. These checks are supported on
Linux and macOS. An explicit key path on an unsupported platform fails.

The application never creates, repairs, rotates or backs up the external key.
Only its path belongs in configuration. Do not place the key bytes in command
arguments or logs. The key is loaded once and retained for the process lifetime;
replacing the file takes effect after restart. Operators must retain the correct
key for their encrypted data. A missing configuration returns an unavailable
provider; an explicitly configured missing or invalid file fails at startup.

Each encrypted value uses an authenticated, versioned envelope:
`lvis-external-key:aes-256-gcm:1` followed by a NUL byte, a random 12-byte nonce,
a 16-byte authentication tag, and ciphertext. The header is authenticated as
additional data. Decryption releases text only after authentication succeeds.
Invalid versions, altered bytes, truncated envelopes and incorrect keys fail.

Secret documents retain their existing atomic writes and cross-process locks.
External-key entries use the `external-key` encoding. The host refuses existing
desktop ciphertext, development plaintext and legacy documents under this
provider. It does not migrate or overwrite them. All existing external-key
entries must authenticate before a document mutation, including deletion.
Selecting development policy never enables plaintext for this provider.

Authority secrets use `createHostSecretStore`. For the external-key provider,
unreadable secrets raise an error and retain their original files. They are not
quarantined as missing, and a failed read cannot trigger a replacement identity.
The desktop provider retains its existing quarantine policy.
