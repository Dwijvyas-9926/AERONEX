/*
  Part of a file, for a request with a Range header.

  Video needs it: to seek, or to read the end of a file first, the player asks
  for byte ranges and expects 206 Partial Content. Only the simple form
  browsers send is handled, one range ("bytes=start-end", "bytes=start-" or
  "bytes=-suffix"); anything else gets the whole file, which is always
  allowed. A range that starts past the end gets 416.
*/

/**
 * @param {number} size the file's length in bytes
 * @param {string | null | undefined} header the request's Range header
 * @returns {{ status: 200 } | { status: 206, start: number, end: number } | { status: 416 }}
 */
function byteRange(size, header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return { status: 200 };
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return { status: 416 };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return { status: 416 };
  return { status: 206, start, end };
}

module.exports = { byteRange };
