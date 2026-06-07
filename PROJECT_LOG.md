# Project Log — Timesheet

A running record of what was built, when, and why. Most recent phase at the top.

---

## Phase 1 — Project field, session blocks, privacy purge, and UX refinement

**Commit:** e3cf7a9

### What was built

#### Project / client field (first-class)
- Clock-in dialog now prompts for **Project / client** as the first field (auto-focused, green-glowing), before rate and optional note
- Recent project names are suggested via datalist autocomplete
- Edit dialog supports project assignment for past entries
- Project names are retained for today + yesterday only; older entries show "· no project ·"

#### Session block grouping (one clock-in → one block)
- Day view now groups entries by **clock-in → clock-out cycle** (one "session block"), not by midnight boundaries
- Each block displays: project name (or "· no project ·") + time range in the header, with a shared running total (hours · $) covering all sub-sessions/breaks
- Break and resume create new interval rows nested under the same block; they share the block's total
- A second clock-in to the same project later creates a **separate block**, not a merged one

#### 2-day rolling privacy purge
- Project names deleted from disk and memory after today + yesterday (window = 48 hours from day rollover)
- Underlying hours/intervals/earnings remain intact — only the name field is purged
- On app launch and at midnight, expired names are silently deleted
- `recentProjectNames()` respects the same window, so the autocomplete never suggests expired names

#### Dropdown selectability fix
- **Root cause:** `tick()` was calling full `render()` every second while clocked in, destroying the DOM including any open `<select>`
- **Fix:** `tick()` now surgically updates `data-live-*` nodes only; never calls `render()`
- Dropdown now stays open and fully selectable while clocked in — no pulsing, no interference

#### Day-span dial (1–31 range)
- Replaced fixed presets (Day / 3-day / 7-day / 14-day / 31-day) with a full **1–31 selector**
- Default view is now "Day" (1-day, was 7-day)
- Dropdown preserves selection and updates live while clocked in

#### Theme — background and text brightness
- Lightened background tokens (steel panels, CRT screen) for better text readability
- Body text (dates, times, durations, project names, notes, totals) now renders in bright phosphor green
- Block header "· no project · HH:MM – HH:MM" renders in **bright white** with soft glow — distinguishes unlabeled blocks from green neighbors
- Top control bar (DAYS / RANGE / ALL, Intervals) keeps muted-gray unselected state and bright-green active state for clarity

### What you can now do

- Clock in with a project name, break, resume, clock out → see one block with all sub-sessions grouped and a shared total
- Clock in again to the same project later → see a separate block (each clock-in→out is its own session block)
- Datalist autocompletes project names from the last 2 days; older names are gone
- Open day-span dropdown while clocked in → no pulsing, fully selectable
- Switch between any 1–31 day view without interruption
- See bright white "· no project ·" headers for entries without a project name, distinguishing them visually

### Decisions made

- **Option A for midnight:** Whole task blocks bucketed by their clock-in day and never split at midnight for display. Storage stays a single record per clock-in→out cycle.
- **Project as first-class field:** Elevated from notes context to the first input at clock-in, with recent-name autocomplete, reflecting its importance to the user.
- **Privacy window = 2 days:** Balances retention (capture cross-midnight work sessions) against user privacy preference ("don't want project info living on the computer").
- **White labels for "no project":** Distinguishes unlabeled blocks from green neighbors without breaking the hard rule (no orange/yellow/amber). Provides visual hierarchy.

### How to test

- Clock in with "Test Project", 15min work, break 5min, resume, clock out — should show one block with total ~20min
- Same project again later in the day → should be a separate block
- Day after tomorrow, project names should disappear from the list and show "· no project ·" in UI
- Dropdown while working → stays open, can select any 1–31 without pulsing
- Text should render bright green except white "· no project ·" headers and gray (unselected) nav buttons

### Deferred / out of scope

- Tag-based filtering of the entry list
- Rate history / smart defaults
- Earnings analytics / reporting views
- Break-specific notes (currently all work under one session block)

---
