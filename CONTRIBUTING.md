# Contributing

Thank you for helping improve Agent World.

Before opening a pull request:

1. Keep the public observer experience read-only and Arabic RTL compatible.
2. Preserve the split between model proposal, deterministic resolution, and publication filtering.
3. Never expose `WorldTruth`, secrets, database access, or real tools to simulated characters.
4. Add a test for every change to heredity, fertility, perception, cognition, resolution, scheduling, or replay.
5. Bump the appropriate runtime identity component for behavioral changes. Existing seasons must use a documented migration or retain their locked rules.
6. Run the TypeScript checks, unit tests, and production build.

Avoid new hard-coded civilization goals, relationship institutions, action menus, population limits, or external-human spawn paths. Observer labels may describe patterns but must never be injected into agent knowledge unless the society independently develops them.
