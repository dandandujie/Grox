# Contributing

[简体中文](CONTRIBUTING.md)

Thanks for taking a look. Grox is a small, focused codebase and contributions are welcome.

## Set up

Requirements: Go 1.27.3+, Node 22.6+, and a platform webview (WKWebView on macOS, WebView2 on Windows,
WebKitGTK 4.1 on Linux).

    npm install
    npm run dev

The npm scripts use scripts/with-go.mjs, which selects Go 1.27.3+ and clears a stale GOROOT. Run the same
scripts for tests and builds so the toolchain is consistent.

## Before opening a pull request

    npm run verify

This runs the TypeScript typecheck, all Go tests, and go vet. If you changed the seed data, regenerate the
browser-preview fixture:

    go run ./cmd/fixture > src/mock/bootstrap.json

If you changed the bound Go service or its event type, run:

    npx mygo generate

and commit the regenerated src/mygo.ts.

## Conventions

- Keep the Go service behind one lock and emit state snapshots at boundaries, not per token.
- Do not send secrets to the frontend. Extend SecretStatus instead.
- Keep the demo engine and real CLI engines behind the same Sink contract.
- If a surface is not implemented, label it honestly in the UI and README rather than simulating success.
- Prefer native accessible controls, focus-visible states, and keyboard paths.
- Add a test for a new backend behavior, especially scheduling, approvals, and parsing.

## Commit messages

Short imperative subjects. Explain the boundary you changed and what you verified. Screenshots are helpful
for UI changes.
