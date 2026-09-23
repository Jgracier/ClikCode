# Contributing

Thanks for helping with ClikCode.

## Setup

Requires Node.js 22.12 or newer and pnpm.

```sh
pnpm install
pnpm type-check
pnpm test
pnpm build:strict
```

All three checks must pass before a change is merged. `pnpm test:smoke` and
`pnpm test:pack` exercise the built binary and the published tarball.

## Making a change

- Keep changes focused; one concern per pull request.
- Add or update a test next to the code you change (`*.vitest.test.ts`).
- Match the surrounding code's style and comment density.
- Explain the *why* in the pull request description, not just the what.
- The `dist/` bundle must keep its runtime dependencies minimal: `build:strict`
  fails on a missing or extra one.

## Reporting bugs

Open an issue with the ClikCode version, your OS, which tool and account type
was in use, and the smallest steps that reproduce it. For security issues see
[SECURITY.md](SECURITY.md) instead.

## License

By contributing you agree your contribution is licensed under the MIT License.
