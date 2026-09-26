use llmup_cli::retirement::check_file;

#[test]
fn root_src_must_be_empty_even_when_files_are_not_typescript() {
    for path in [
        "src/config.json",
        "src/.keep",
        "src/assets/index.html",
        "src/lib.rs",
    ] {
        assert!(!check_file(path, "").is_empty(), "{path}");
    }
    assert!(check_file("crates/llmup-core/src/lib.rs", "").is_empty());
}

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
        "crates/llmup-gui/static/unreviewed.js",
    ] {
        assert!(!check_file(path, "").is_empty(), "{path}");
    }
}

#[test]
fn allows_browser_assets_but_rejects_node_imports_in_them() {
    for path in [
        "crates/llmup-gui/static/chat.js",
        "site/main.js",
        "apps/desktop/src-tauri/src/dialog-smoke.js",
    ] {
        assert!(check_file(path, "document.querySelector('main');").is_empty());
        for source in [
            "import fs from 'node:fs';",
            "import{readFile}from\"node:fs\"",
            "const fs = require( 'node:fs' );",
            "await import(\"node:child_process\")",
            "#!/usr/bin/env node\n",
        ] {
            assert!(!check_file(path, source).is_empty(), "{path}: {source}");
        }
    }
    assert!(
        check_file(
            "crates/llmup-gui/vendor/marked.min.js",
            "typeof module !== 'undefined'"
        )
        .is_empty()
    );
    assert!(
        check_file(
            "crates/llmup-gui/vendor/dompurify.min.js",
            "d.push({node:e,shadow:null})"
        )
        .is_empty()
    );
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

#[test]
fn development_and_support_demo_use_native_cli() {
    let aliases = include_str!("../../../.cargo/config.toml");
    assert!(aliases.contains("llmup = \"run --quiet --locked -p llmup-cli --bin llmup --\""));
    let demo = include_str!("../../../scripts/opencode-support-demo.sh");
    assert!(demo.contains("cargo llmup chat --harness opencode --model \"$model\""));
    assert!(check_file("scripts/opencode-support-demo.sh", demo).is_empty());
}

#[test]
fn rejects_node_backed_actions_even_without_node_commands() {
    for action in [
        "actions/checkout",
        "actions/configure-pages",
        "actions/upload-pages-artifact",
        "actions/deploy-pages",
        "actions/add-to-project",
        "actions/upload-artifact",
        "actions/download-artifact",
        "actions/cache",
        "actions/github-script",
        "softprops/action-gh-release",
    ] {
        let source = format!("steps:\n  - uses: {action}@pinned-revision\n");
        assert!(
            !check_file(".github/workflows/native.yml", &source).is_empty(),
            "{action}"
        );
        assert!(check_file("docs/reviews/history.md", &source).is_empty());
    }
}

#[test]
fn release_cutover_is_native_read_only_and_does_not_publish() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert!(!root.join(".github/workflows/npm-publish.yml").exists());
    let workflow = std::fs::read_to_string(root.join(".github/workflows/release.yml")).unwrap();
    assert!(check_file(".github/workflows/release.yml", &workflow).is_empty());
    for forbidden in [
        "uses:",
        "contents: write",
        "packages: write",
        "--publish",
        "--push",
        "gh release create",
    ] {
        assert!(!workflow.contains(forbidden), "{forbidden}");
    }
    for required in [
        "contents: read",
        "cargo native-retirement",
        "cargo fmt --all -- --check",
        "cargo clippy --workspace --all-targets --locked -- -D warnings",
        "cargo test --workspace --locked",
        "cargo build --workspace --locked",
        "cargo native-dist package",
        "git rev-parse HEAD",
        "$GITHUB_SHA",
        "Publication blocked",
        "macos-14",
        "ubuntu-24.04",
        "windows-2022",
    ] {
        assert!(workflow.contains(required), "{required}");
    }
}

#[test]
fn container_runs_native_aliases_without_source_or_node_runtime() {
    let dockerfile = include_str!("../../../Dockerfile");
    for required in [
        "cargo build --release --locked",
        "--bin llmup",
        "--bin local-llmup",
        "--bin llmup-gui",
        "USER llmup",
        "ENTRYPOINT [\"/usr/local/bin/llmup\"]",
        "CMD [\"recommend\", \"--json\"]",
    ] {
        assert!(dockerfile.contains(required), "{required}");
    }
    for forbidden in ["FROM node:", "npm ", "COPY src", "dist/bin", "package.json"] {
        assert!(!dockerfile.contains(forbidden), "{forbidden}");
    }
}

#[test]
fn typescript_cli_entries_and_public_package_launchers_are_retired() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for path in [
        "src/bin.ts",
        "src/cli.ts",
        "package.json",
        "package-lock.json",
    ] {
        assert!(!root.join(path).exists(), "{path}");
    }
}
