# Contributing to Aitopia

Thank you for helping improve Aitopia.

## Development workflow

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm ci` in the repository root and in `worker/`.
3. Keep simulation facts inside the deterministic engine; model output may propose actions but must never mutate state directly.
4. Add or update tests for rule changes.
5. Run the full verification suite before opening a pull request.

```bash
npm run lint
npm run check
npm run build
cd worker
npm run check
npm test
```

## Pull requests

- Explain the behavior being changed and why.
- Keep unrelated formatting or dependency changes separate.
- Include screenshots for visible interface changes.
- Never commit API keys, `.env` files, `.dev.vars`, account IDs, database IDs, or signing secrets.
- Do not expose hidden character state or private model reasoning through public APIs.

By contributing, you agree that your contribution is licensed under the MIT License.
