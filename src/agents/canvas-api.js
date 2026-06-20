// Canvas LMS REST API client.
// Uses the user's existing browser session (credentials: "include"), so no
// access token is required as long as the user is logged into Canvas.
// Regex-based HTML stripping so it runs inside the MV3 service worker (no DOMParser).

export class CanvasAPI {
  constructor(origin) {
    // origin e.g. "https://myschool.instructure.com"
    this.base = `${origin}/api/v1`;
  }

  // Canvas paginates with RFC5988 Link headers (rel="next").
  async _getAll(path, params = {}) {
    const url = new URL(this.base + path);
    url.searchParams.set("per_page", "100");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let next = url.toString();
    const out = [];
    while (next) {
      const res = await fetch(next, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Canvas API ${res.status} on ${next}`);
      }
      const page = await res.json();
      out.push(...(Array.isArray(page) ? page : [page]));
      next = this._nextLink(res.headers.get("Link"));
    }
    return out;
  }

  async _getOne(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Canvas API ${res.status} on ${url}`);
    return res.json();
  }

  _nextLink(linkHeader) {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(",")) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  // ---- High-level endpoints ----
  async getCourse(courseId) {
    return this._getOne(`/courses/${courseId}`);
  }
  async getModules(courseId) {
    return this._getAll(`/courses/${courseId}/modules`, { include: "items" });
  }
  async getPages(courseId) {
    return this._getAll(`/courses/${courseId}/pages`);
  }
  async getPage(courseId, pageUrl) {
    return this._getOne(`/courses/${courseId}/pages/${pageUrl}`);
  }
  async getAssignments(courseId) {
    return this._getAll(`/courses/${courseId}/assignments`);
  }
  // Files (PowerPoints, PDFs, docs). We list metadata + links; binary parsing
  // is deferred to a follow-up.
  async getFiles(courseId) {
    return this._getAll(`/courses/${courseId}/files`);
  }
}

// Strip HTML to plain text. Regex-based so it works in a service worker.
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// Detect Canvas course id + page slug from a URL.
export function parseCanvasUrl(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return null; }
  const isCanvas = /\.instructure\.com$/.test(u.hostname) || /\.canvas\.com$/.test(u.hostname);
  if (!isCanvas) return null;
  const cm = u.pathname.match(/\/courses\/(\d+)/);
  if (!cm) return { origin: u.origin, courseId: null, pageUrl: null };
  const pm = u.pathname.match(/\/courses\/\d+\/pages\/([^/?#]+)/);
  return {
    origin: u.origin,
    courseId: cm[1],
    pageUrl: pm ? decodeURIComponent(pm[1]) : null,
  };
}

// Gather a course's readable content into a structured object.
export async function gatherCourse(origin, courseId) {
  const api = new CanvasAPI(origin);
  const [course, modules, pages, assignments, files] = await Promise.all([
    api.getCourse(courseId),
    api.getModules(courseId),
    api.getPages(courseId),
    api.getAssignments(courseId),
    api.getFiles(courseId).catch(() => []), // files can be permission-locked
  ]);

  // Fetch full page bodies (the list endpoint omits them).
  const pageBodies = [];
  for (const p of pages) {
    try {
      const full = await api.getPage(courseId, p.url);
      pageBodies.push({ title: full.title, text: htmlToText(full.body) });
    } catch (e) {
      pageBodies.push({ title: p.title, text: `(could not load: ${e.message})` });
    }
  }

  return {
    course: { id: course.id, name: course.name },
    modules: modules.map((m) => ({
      name: m.name,
      items: (m.items || []).map((it) => ({ type: it.type, title: it.title })),
    })),
    pages: pageBodies,
    assignments: assignments.map((a) => ({
      name: a.name,
      due: a.due_at,
      text: htmlToText(a.description).slice(0, 1000),
    })),
    files: files.map((f) => ({
      name: f.display_name || f.filename,
      type: f.content_type,
      url: f.url, // pre-authed download URL
    })),
  };
}

// Upcoming assignments sorted by due date (no LLM).
export async function upcomingAssignments(origin, courseId) {
  const api = new CanvasAPI(origin);
  const assignments = await api.getAssignments(courseId);
  const now = Date.now();
  return assignments
    .filter((a) => a.due_at && new Date(a.due_at).getTime() >= now)
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
    .map((a) => ({ name: a.name, due: a.due_at, points: a.points_possible, url: a.html_url }));
}

// Flatten gathered content into a single text blob for the LLM, size-capped.
export function courseToPrompt(data, maxChars = 20000) {
  const parts = [`Course: ${data.course.name}`, ""];
  parts.push("MODULES:");
  for (const m of data.modules) {
    parts.push(`- ${m.name}`);
    for (const it of m.items) parts.push(`    • [${it.type}] ${it.title}`);
  }
  parts.push("", "PAGES:");
  for (const p of data.pages) {
    parts.push(`## ${p.title}`, p.text, "");
  }
  parts.push("ASSIGNMENTS:");
  for (const a of data.assignments) {
    parts.push(`- ${a.name} (due ${a.due || "n/a"}): ${a.text}`);
  }
  if (data.files?.length) {
    parts.push("", "FILES (PowerPoints/PDFs/docs — names only):");
    for (const f of data.files) parts.push(`- ${f.name} [${f.type || "file"}]`);
  }
  return parts.join("\n").slice(0, maxChars);
}
