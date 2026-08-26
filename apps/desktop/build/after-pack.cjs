// Ad-hoc sign the macOS app during packaging. Without any signature, Apple
// Silicon reports the downloaded (unsigned) app as "damaged" and refuses to
// open it. Ad-hoc signing makes it launchable via the normal Gatekeeper path
// (right-click ▸ Open, or after clearing the quarantine attribute).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
