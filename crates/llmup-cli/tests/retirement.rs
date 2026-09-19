use llmup_cli::retirement::check_file;

#[test]
fn rejects_node_sources_manifests_and_tool_configuration() {
    for path in [
        "src/cli.ts",
        "tests/cli.test.ts",
        "src/tui/chat.tsx",
        "scripts/driver.mjs",
        "apps/desktop/preload.cjs",
        "scripts/build.js",
        "package.json",
        "apps/desktop/package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "tsconfig.json",
        ".npmrc",
        ".nvmrc",
        "src/gui/static/unreviewed.js",
    ] {
        assert!(!check_file(path, "").is_empty(), "{path}");
    }
}

#[test]
fn allows_browser_assets_but_rejects_node_imports_in_them() {
    for path in [
        "src/gui/static/chat.js",
        "site/main.js",
        "apps/desktop/src-tauri/src/dialog-smoke.js",
    ] {
        assert!(check_file(path, "document.querySelector('main');").is_empty());
        assert!(!check_file(path, "import fs from 'node:fs';").is_empty());
        assert!(!check_file(path, "#!/usr/bin/env node\n").is_empty());
    }
    assert!(check_file("vendor/gui/marked.min.js", "typeof module !== 'undefined'").is_empty());
}

#[test]
fn rejects_executable_node_routing_without_rejecting_historical_docs() {
    for source in [
        "run: npm test",
        "run: npx playwright test",
        "- uses: actions/setup-node@sha",
        "node scripts/test.js",
        "pnpm install",
        "yarn build",
        "bun run test",
    ] {
        assert!(!check_file(".github/workflows/ci.yml", source).is_empty());
        assert!(!check_file("scripts/build.sh", source).is_empty());
    }
    assert!(check_file("docs/reviews/history.md", "Previously ran npm test").is_empty());
    assert!(check_file(".github/workflows/native.yml", "run: cargo test --locked").is_empty());
    assert!(check_file("Cargo.toml", "[workspace]").is_empty());
}
