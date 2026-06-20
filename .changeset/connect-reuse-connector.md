---
"eve": patch
---

Connect-backed setup now attaches the provider's canonical connector UID first, then offers explicit searchable Find or named Create paths when that connector is unavailable. `/connect` installs dependencies before remote mutation, writes only the final connector UID, and removes connectors created by failed attempts while end users continue to authorize separately on first use.
