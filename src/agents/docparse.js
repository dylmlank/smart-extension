// Dependency-free text extraction for PDF and PPTX files.
//
// No build step, no vendored megabyte libraries. We lean on the browser's
// built-in DecompressionStream("deflate"/"deflate-raw") to inflate the
// compressed streams both formats use, then pull text out of what remains.
//
// Coverage is intentionally "good enough for lecture material":
//   - PDF: text-based PDFs whose content streams use FlateDecode (the vast
//     majority). Scanned/image-only PDFs have no text layer and yield nothing
//     (that would need OCR — explicitly out of scope).
//   - PPTX: standard Office Open XML decks (a ZIP of slideN.xml parts).

// ---- shared: inflate bytes via the platform ----
async function inflate(bytes, raw = false) {
  const fmt = raw ? "deflate-raw" : "deflate";
  const ds = new DecompressionStream(fmt);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// =====================================================================
// PDF
// =====================================================================

// Extract text from a PDF given its bytes (Uint8Array).
export async function pdfToText(bytes) {
  const latin1 = new TextDecoder("latin1").decode(bytes);
  const chunks = [];

  // Find every stream...endstream span. Content streams hold the drawing ops,
  // including the Tj / TJ text-showing operators we want.
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(latin1)) !== null) {
    const start = m.index + m[0].indexOf(m[1]);
    const raw = bytes.subarray(start, start + m[1].length);
    let data = raw;
    // Most content streams are FlateDecode. Try to inflate; if it isn't
    // actually deflate data, skip this stream rather than failing the whole doc.
    try {
      data = await inflate(raw);
    } catch {
      try { data = await inflate(raw, true); } catch { continue; }
    }
    const text = extractPdfStreamText(new TextDecoder("latin1").decode(data));
    if (text) chunks.push(text);
  }

  return chunks.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Pull readable text out of a decoded PDF content stream by reading the
// arguments to the Tj and TJ text operators.
function extractPdfStreamText(s) {
  const out = [];

  // (string) Tj   — a single show-text.
  // [ (a) -250 (b) ] TJ — array form with kerning numbers between strings.
  // We grab any parenthesized literal that precedes Tj or TJ.
  const op = /(\[(?:[^\[\]]|\\.)*\]|\((?:[^()\\]|\\.)*\))\s*(TJ|Tj)/g;
  let m;
  while ((m = op.exec(s)) !== null) {
    const arg = m[1];
    // Collect every (literal) inside the operand.
    const lit = /\((?:[^()\\]|\\.)*\)/g;
    let l, line = "";
    while ((l = lit.exec(arg)) !== null) {
      line += decodePdfLiteral(l[0].slice(1, -1));
    }
    if (line.trim()) out.push(line);
  }
  return out.join("\n");
}

// Decode a PDF string literal's escape sequences.
function decodePdfLiteral(s) {
  return s
    .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

// =====================================================================
// PPTX (ZIP of XML)
// =====================================================================

// Minimal ZIP reader: walk the End Of Central Directory → central directory →
// local file entries. Only handles stored (0) and deflated (8) entries, which
// is all Office writes.
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find End Of Central Directory record (signature 0x06054b50), scanning back.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true); // central directory offset

  const files = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break; // central dir header
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // Jump to the local header to find the actual data start (its name/extra
    // lengths can differ from the central directory's).
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    files[name] = method === 0 ? comp : await inflate(comp, true); // 8 = deflate-raw
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Extract text from a PPTX given its bytes (Uint8Array).
export async function pptxToText(bytes) {
  const files = await unzip(bytes);
  // Slide parts are ppt/slides/slideN.xml — sort numerically so output is in order.
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));

  const dec = new TextDecoder();
  const out = [];
  for (const name of slideNames) {
    const xml = dec.decode(files[name]);
    // <a:t>...</a:t> holds the run text in DrawingML.
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => xmlUnescape(m[1]));
    if (runs.length) out.push(`# Slide ${slideNum(name)}\n${runs.join(" ")}`);
  }
  return out.join("\n\n").trim();
}

function slideNum(name) {
  const m = name.match(/slide(\d+)\.xml/);
  return m ? parseInt(m[1], 10) : 0;
}
function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// =====================================================================
// Entry point: fetch a file URL and extract its text by type.
// =====================================================================

// `url` is a (pre-authed) Canvas file URL. `contentType`/name hint the format.
export async function extractDocText(url, hint = "") {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const h = (hint + " " + ct + " " + url).toLowerCase();
  const bytes = new Uint8Array(await res.arrayBuffer());

  if (h.includes("pdf")) return pdfToText(bytes);
  if (h.includes("presentation") || h.includes("pptx") || h.includes("powerpoint")) {
    return pptxToText(bytes);
  }
  // Fall back on magic bytes: %PDF or PK (zip → pptx/docx).
  if (bytes[0] === 0x25 && bytes[1] === 0x50) return pdfToText(bytes); // %P
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return pptxToText(bytes); // PK
  throw new Error("unsupported file type for text extraction");
}
