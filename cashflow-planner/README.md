# Cash-flow planner

Home for the wish list, the funding algorithm and the Sankey diagram that sit behind the cash-flow page.
Nothing here is wired into the site yet. This file is the plan.

## What goes where

| File (planned) | Job |
| --- | --- |
| `planner.js` | The algorithm only. No page code, no DOM. Plain functions: data in, numbers out. |
| `planner.test.js` | Checks for the algorithm (conservation of money, deadlines, emergency mode). |
| `sankey.js` | Turns the planner's output into nodes and ribbons, and draws them. Re-draws when a value changes. |
| `design/` | Approved design references (screenshots, the canvas link, palette notes). |

Keeping the algorithm separate from the drawing means one owner and one source of truth for the maths.

## The wish list

Each item has: name, cost, needed-by date, amount already saved, priority, firm or flexible,
how many days it can slip, the smallest amount worth buying, and the pay interval it is funded on.

## The algorithm

Normal mode, the cheapest route: for each item, the smallest steady payment per interval that
funds it by its date. `(cost - saved) / intervals left`. Time is traded for money, so payments are
low and level. If the payments added together are more than the free cash per interval, the plan is
flagged as not fitting and the items causing it are named.

Emergency mode, the opposite: items with plenty of slack are paused to free cash for the urgent
need. Least slack is protected first. Paused items are re-spread over the time they have left, and
the catch-up cost is shown. Firm items near their deadline are never paused.

## The Sankey

Columns: money in, spare cash, priority groups, pots. Ribbon width is the amount, drawn to scale.
Money is conserved at every node. Anything left over goes to an "unallocated" node.
The approved design preview lives on the design canvas, not in this repository yet.

## Wiring checklist (when files are added)

1. Link shared files with `../settings.js` and `../settings.css`, or add pages at the top level.
2. Add every new served file to `FILES` in `sw.js` and bump the `CACHE` version.
3. Add the wish list's storage key to the backup key list in `settings.js`.
4. Mention the new pages in the top-level `README.md`.
