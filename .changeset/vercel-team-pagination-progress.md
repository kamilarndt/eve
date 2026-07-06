---
"eve": patch
---

Fixed `eve init` failing with "Vercel returned a repeated pagination cursor for Vercel teams" for accounts with more than 20 teams. Vercel's team-list cursor is a millisecond timestamp, so teams created in the same millisecond could make it repeat across pages even while new teams were still being returned. Pagination now bails only when a page adds no new teams, not merely when the cursor value repeats.
