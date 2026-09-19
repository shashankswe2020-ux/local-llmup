(async () => {
  try {
    const cancelled = await window.llmupDesktop.selectWorkspaceDirectory();
    if (cancelled !== null) throw new Error("cancel returned a path");
    const selected = await window.llmupDesktop.selectWorkspaceDirectory();
    if (!selected) throw new Error("selection returned no path");
    const headers = {
      "content-type": "application/json",
      "x-llmup-token": document.querySelector('meta[name="llmup-token"]').content,
    };
    const response = await fetch("/api/workspace/root", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: selected }),
    });
    if (!response.ok) throw new Error("selected folder registration failed");
    const { root } = await response.json();
    const revoked = await fetch("/api/workspace/root/revoke", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: root.id }),
    });
    if (!revoked.ok) throw new Error("root revocation failed");
    const status = await (await fetch("/api/workspace/status", { headers })).json();
    if (status.rootId !== null) throw new Error("root still authorized");
    location.href = "/__native_smoke/pass";
  } catch (error) {
    console.error(error);
    location.href = "/__native_smoke/fail";
  }
})();
