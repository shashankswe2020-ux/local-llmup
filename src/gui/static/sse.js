/**
 * Buffered Server-Sent Events frame parser (task 32.1).
 *
 * The previous client split each raw network chunk on blank lines, so any SSE
 * frame straddling two chunks — or a multibyte UTF-8 sequence split across a
 * read — could be lost or corrupted. `SseFrameBuffer` owns a streaming
 * `TextDecoder` and retains the incomplete tail between pushes, emitting only
 * complete `data:` frames.
 *
 * This file has no imports/exports so it can load as a classic browser
 * `<script>` (attaching to `globalThis.GuiSse`) while remaining importable by
 * the Node test runner for fragmentation tests.
 */
(function attachSseFrameBuffer(scope) {
  "use strict";

  /**
   * @typedef {{ event: object } | { error: string, raw: string }} SseFrameResult
   */

  function parseFrame(raw) {
    const dataLines = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) {
      return undefined;
    }
    const payload = dataLines.join("\n").trim();
    if (payload.length === 0) {
      return undefined;
    }
    try {
      return { event: JSON.parse(payload) };
    } catch {
      return { error: "malformed SSE payload", raw: payload };
    }
  }

  class SseFrameBuffer {
    constructor() {
      this._decoder = new scope.TextDecoder();
      this._buffer = "";
    }

    /**
     * Feed one network chunk of bytes; returns every complete frame it unlocks.
     * @param {Uint8Array} bytes
     * @returns {SseFrameResult[]}
     */
    push(bytes) {
      this._buffer += this._decoder.decode(bytes, { stream: true });
      return this._drain(false);
    }

    /**
     * Flush the decoder and any trailing frame after the stream ends.
     * @returns {SseFrameResult[]}
     */
    flush() {
      this._buffer += this._decoder.decode();
      return this._drain(true);
    }

    _drain(final) {
      const frames = [];
      let index = this._buffer.indexOf("\n\n");
      while (index !== -1) {
        const raw = this._buffer.slice(0, index);
        this._buffer = this._buffer.slice(index + 2);
        const result = parseFrame(raw);
        if (result !== undefined) {
          frames.push(result);
        }
        index = this._buffer.indexOf("\n\n");
      }
      if (final && this._buffer.length > 0) {
        const result = parseFrame(this._buffer);
        this._buffer = "";
        if (result !== undefined) {
          frames.push(result);
        }
      }
      return frames;
    }
  }

  scope.GuiSse = { SseFrameBuffer };
})(typeof globalThis !== "undefined" ? globalThis : this);
