# Contributing to JLaunch

Thanks for helping make Java service workflows lighter. Small, focused pull requests are easiest to review.

## Before you start

- Search existing issues before opening a duplicate.
- For a large feature or behavior change, open a proposal issue first.
- Never include private project paths, credentials, production logs, or proprietary source files in examples and screenshots.

## Development setup

Requirements: Node.js 22+, npm 10+, and a local JDK for manual Java launch testing.

```bash
git clone https://github.com/LearnAIHubC/JLaunch.git
cd JLaunch
npm ci
npm start
```

Run all automated checks before submitting:

```bash
npm run check
```

## Pull requests

1. Create a feature branch from `main`.
2. Keep the change scoped to one concern.
3. Add or update tests for behavior changes.
4. Explain the user impact and verification steps in the pull request.
5. Do not commit `node_modules/`, `release/`, local SQLite files, or environment files.

## Code style

- Use CommonJS and the existing two-space indentation.
- Prefer built-in Node/Electron APIs and small modules over new dependencies.
- Spawn child processes without a shell and preserve useful error context.
- Keep renderer access behind the preload allowlist.
- Match the existing dark UI and keyboard accessibility patterns.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
