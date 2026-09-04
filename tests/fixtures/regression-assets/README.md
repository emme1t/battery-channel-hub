# Versioned synthetic regression inputs

These ten gzip archives contain only the pre-existing synthetic v0.4.2/v0.4.3 regression SQLite databases and backup packages. They are not application runtime or customer data. Each decompressed file matches the SHA-256 already recorded in `人工回归数据包/<version>/SHA256SUMS.json`.

Keep these versioned bytes stable: the historical fixtures include legacy representations that the current state normalizer intentionally converts on load. Re-running today's generator is not guaranteed to recreate the original byte hashes.

`npm run fixtures:prepare` restores missing files only, verifies both existing and restored files, and leaves the original manifests and existing masters unchanged. The unpacked files remain ignored as runtime-like formats. A hash mismatch is an error, not permission to overwrite a master.
