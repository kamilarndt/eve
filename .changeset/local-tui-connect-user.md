---
"eve": patch
---

Each local TUI now uses an immutable, server-bound grant for the current Vercel CLI user, including when it attaches to an existing local server. The TUI revalidates that identity before each turn, revokes stale grants, rebinds after a local server restart, and removes registries whose recorded server process has terminated. Authorization callbacks target the active dev-server port, authorization pauses render as waiting in the TUI, and each completed connection authorization resumes independently instead of waiting for every pending connection.
