## What changed

<!-- Describe the user-visible change and the reason for it. -->

## How it was checked

<!-- Commands, manual steps, screenshots, or sample files used. -->

## Checklist

- [ ] `npm test` and `npm run build` pass in `frontend/`
- [ ] `python -m pytest inkroom_api/tests -q` passes in `backend/`
- [ ] No `.env`, provider key, token, or real customer content is included
- [ ] The browser still cannot choose a provider, model, key, or demo/live mode
- [ ] Human checkpoints, the direction step, and final approval still work
- [ ] Deployment docs or `.env.example` were updated if configuration changed
