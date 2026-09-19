const BROWSER_SCRIPTS: &[&str] = &[
    "src/gui/static/calculator-runtime.js",
    "src/gui/static/calculator-template.js",
    "src/gui/static/chat.js",
    "src/gui/static/markdown.js",
    "src/gui/static/run-reducer.js",
    "src/gui/static/sse.js",
    "src/gui/static/telemetry.js",
    "site/main.js",
    "apps/desktop/src-tauri/src/dialog-smoke.js",
    "vendor/gui/dompurify.min.js",
    "vendor/gui/marked.min.js",
];

pub fn check_file(path: &str, text: &str) -> Vec<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = name.rsplit('.').next().unwrap_or("");
    let mut failures = Vec::new();
    let browser = BROWSER_SCRIPTS.contains(&path);
    if ["ts", "tsx", "jsx", "mjs", "cjs"].contains(&extension) || (extension == "js" && !browser) {
        failures.push("Node/TypeScript source or unreviewed JavaScript remains");
    }
    if [
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        ".npmrc",
        ".yarnrc",
        ".yarnrc.yml",
        ".nvmrc",
        ".node-version",
    ]
    .contains(&name)
        || (name.starts_with("tsconfig") && name.ends_with(".json"))
    {
        failures.push("Node package or toolchain configuration remains");
    }
    if browser
        && (text.contains("node:")
            || text
                .lines()
                .next()
                .is_some_and(|line| line.starts_with("#!") && line.contains("node")))
    {
        failures.push("browser asset invokes a Node runtime or imports Node APIs");
    }
    let executable_config = path.starts_with(".github/workflows/")
        || ["sh", "ps1", "py", "cmd", "bat"].contains(&extension)
        || ["Makefile", "justfile"].contains(&name)
        || path == "apps/desktop/src-tauri/tauri.conf.json";
    if executable_config {
        let lower = text.to_ascii_lowercase();
        let has_command = lower
            .split(|character: char| {
                !character.is_ascii_alphanumeric() && character != '-' && character != '_'
            })
            .any(|word| {
                [
                    "node",
                    "nodejs",
                    "npm",
                    "npx",
                    "pnpm",
                    "yarn",
                    "bun",
                    "setup-node",
                    "electron",
                ]
                .contains(&word)
            });
        if has_command {
            failures.push("executable configuration still references the Node toolchain");
        }
    }
    failures
}
