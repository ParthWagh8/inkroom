# Inkroom sample files

Use these files to try the full review without preparing your own material.

## How to load them

1. Open http://127.0.0.1:8000 and choose **SET UP RUN**.
2. Add every file in `source/` to the **Source** tile.
3. Add every file in `reference/` to the **Reference** tile.
4. Start the run.

For a faster text-only review, skip `source/product_flyer.png`. Including it exercises the vision extraction and
image improvement strategy.

## What should be flagged

The source copy deliberately conflicts with the approved facts and brand rules:

| Source claim | Approved fact |
|---|---|
| 12 cups | 10 cups |
| 3 minutes | About 5 minutes |
| Keeps hot for 12 hours | Up to 2 hours |
| $149 | $179 |
| 40 countries from June 1 | 25 countries from 15 July 2026 |
| Free shipping on every order | Free over $50; otherwise $8 |
| 2-year warranty | 1-year warranty |
| “best”, “#1”, “unbeatable”, “guaranteed” | Brand guidelines prohibit these without an approved source |
| “risk-free for 30 days” | 30-day returns exist, but “risk-free” is not an approved phrase |

The flyer repeats several of the same claims as image text, so the image agent should also flag it.
