
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "projects.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(projects, null, 2), "utf8");
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1000000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function validateProject(input) {
  const name = String(input.name || "").trim();
  const runtime = String(input.runtime || "").trim();
  let repository = String(input.repository || "").trim();

  if (name.length < 2 || name.length > 60) {
    return "Project name must be 2-60 characters.";
  }

  if (!["Node.js", "Python", "Java", "C++"].includes(runtime)) {
    return "Invalid runtime.";
  }

  try {
    const url = new URL(repository);

    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return "Enter a valid GitHub URL.";
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2) {
      return "Repository owner and name are required.";
    }

    repository = `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  } catch {
    return "Invalid GitHub repository URL.";
  }

  return { name, runtime, repository };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, {
        ok: true,
        service: "CloudOrbit API",
        status: "online"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/projects") {
      return send(res, 200, {
        projects: readProjects()
      });
    }

    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await readBody(req);
      const valid = validateProject(body);

      if (typeof valid === "string") {
        return send(res, 400, { error: valid });
      }

      const projects = readProjects();

      const project = {
        id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...valid,
        status: "Configuration prepared",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      projects.unshift(project);
      saveProjects(projects);

      return send(res, 201, { project });
    }

    const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);

    if (match && req.method === "PUT") {
      const id = decodeURIComponent(match[1]);
      const body = await readBody(req);
      const valid = validateProject(body);

      if (typeof valid === "string") {
        return send(res, 400, { error: valid });
      }

      const projects = readProjects();
      const index = projects.findIndex(p => p.id === id);

      if (index === -1) {
        return send(res, 404, { error: "Project not found." });
      }

      projects[index] = {
        ...projects[index],
        ...valid,
        updatedAt: new Date().toISOString()
      };

      saveProjects(projects);
      return send(res, 200, { project: projects[index] });
    }

    if (match && req.method === "DELETE") {
      const id = decodeURIComponent(match[1]);
      const projects = readProjects();
      const updated = projects.filter(p => p.id !== id);

      if (updated.length === projects.length) {
        return send(res, 404, { error: "Project not found." });
      }

      saveProjects(updated);
      return send(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      return send(res, 404, { error: "API endpoint not found." });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "Method not allowed." });
    }

    const requested = url.pathname === "/"
      ? "index.html"
      : decodeURIComponent(url.pathname).replace(/^\/+/, "");

    const filePath = path.resolve(PUBLIC_DIR, requested);

    if (
      !filePath.startsWith(PUBLIC_DIR + path.sep) &&
      filePath !== path.join(PUBLIC_DIR, "index.html")
    ) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      return res.end("Page not found");
    }

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream"
    });

    if (req.method === "HEAD") return res.end();

    fs.createReadStream(filePath).pipe(res);

  } catch (error) {
    if (!res.headersSent) {
      send(res, 500, { error: error.message || "Internal server error." });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CloudOrbit running on ${HOST}:${PORT}`);
});
