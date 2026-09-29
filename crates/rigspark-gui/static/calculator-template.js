(() => {
  const CALCULATOR_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Calculator</title>
    <style>
      :root { color: #17211c; background: #eef3e9; font-family: Georgia, serif; }
      * { box-sizing: border-box; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; padding: 1rem; }
      main { width: min(100%, 22rem); border: 1px solid #b7c5aa; border-radius: 8px; background: #fcfff9; box-shadow: 0 1rem 2.5rem #3f563522; overflow: hidden; }
      header { padding: 1rem 1.1rem .7rem; background: #d9e5d1; }
      h1 { margin: 0; font-size: 1.1rem; font-weight: 600; letter-spacing: 0; }
      #display { width: 100%; border: 0; border-bottom: 1px solid #d5dfcf; background: #fff; color: #17211c; font: 2rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; padding: .8rem 1rem; text-align: right; }
      #display:focus { outline: 2px solid #276749; outline-offset: -2px; }
      .keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem; padding: .75rem; }
      button { min-height: 3rem; border: 1px solid #c8d4c0; border-radius: 5px; background: #f4f8f0; color: #17211c; cursor: pointer; font: 600 1.05rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      button:hover { background: #e4eedc; } button:focus-visible { outline: 3px solid #276749; outline-offset: 2px; }
      .operator { background: #d9e5d1; } .equal { background: #276749; border-color: #276749; color: #fff; grid-row: span 2; } .equal:hover { background: #1f563b; }
      .zero { grid-column: span 2; } #status { min-height: 1.4rem; color: #9b2c2c; font: .8rem/1.4 ui-sans-serif, system-ui, sans-serif; padding: 0 .9rem .75rem; }
    </style>
  </head>
  <body>
    <main aria-label="Calculator">
      <header><h1>Quick calculator</h1></header>
      <input id="display" value="0" inputmode="decimal" aria-label="Calculator display" autocomplete="off" />
      <div class="keys" aria-label="Calculator keys">
        <button type="button" data-action="clear">C</button><button type="button" data-action="backspace">DEL</button><button type="button" data-value="(">(</button><button type="button" class="operator" data-value="/">/</button>
        <button type="button" data-value="7">7</button><button type="button" data-value="8">8</button><button type="button" data-value="9">9</button><button type="button" class="operator" data-value="*">*</button>
        <button type="button" data-value="4">4</button><button type="button" data-value="5">5</button><button type="button" data-value="6">6</button><button type="button" class="operator" data-value="-">-</button>
        <button type="button" data-value="1">1</button><button type="button" data-value="2">2</button><button type="button" data-value="3">3</button><button type="button" class="operator" data-value="+">+</button>
        <button type="button" class="zero" data-value="0">0</button><button type="button" data-value=".">.</button><button type="button" class="equal" data-action="evaluate">=</button>
      </div>
      <div id="status" role="status" aria-live="polite"></div>
    </main>
    <script src="/static/calculator-runtime.js"></script>
  </body>
</html>`;

  function createCalculatorProposal(workspaceId) {
    return {
      workspaceId,
      operations: [{ op: "create", path: "index.html", text: CALCULATOR_HTML }],
    };
  }

  globalThis.GuiCalculatorTemplate = { createCalculatorProposal };
})();