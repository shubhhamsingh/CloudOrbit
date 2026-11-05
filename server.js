
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");
const DATA_DIR = path.join(__dirname, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

const MAX_BODY_SIZE = 10 * 1024;

// Create storage directory and file
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(PROJECTS_FILE)) {
  fs.writeFileSync(PROJECTS_FILE, "[]", "utf8");
}

// Load projects
function loadProjects() {
  try {
    const content = fs.readFileSync(PROJECTS_FILE, "utf8");
    const data = JSON.parse(content || "[]");

    if (!Array.isArray(data)) {
      throw new Error("projects.json must contain a JSON array.");
    }

    return data;
  } catch (error) {
    console.error("Could not load projects:", error.message);
    process.exit(1);
  }
}

let projects = loadProjects();

// Save projects safely
function saveProjects() {
  const tempFile = `${PROJECTS_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(projects, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, PROJECTS_FILE);
}

// Send JSON response
function sendJson(res, status, data) {
  if (res.writableEnded || res.destroyed) return;

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(data));
}

// Read JSON request body
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let finished = false;

    req.on("data", (chunk) => {
      if (finished) return;

      size += chunk.length;

      if (size > MAX_BODY_SIZE) {
        finished = true;
        reject(new Error("REQUEST_TOO_LARGE"));
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (finished) return;

      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
  });
}

// Validate project details
function validateProject(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Invalid project details." };
  }

  const name =
    typeof data.name === "string" ? data.name.trim() : "";

  const repository =
    typeof data.repository === "string"
      ? data.repository.trim()
      : "";

  const runtime = data.runtime;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,58}[a-zA-Z0-9]$/.test(name)) {
    return {
      error: "Project name must be 2-60 valid characters."
    };
  }

  if (repository.length > 500) {
    return { error: "Repository URL is too long." };
  }

  let url;

  try {
    url = new URL(repository);
  } catch {
    return {
      error: "Enter a valid GitHub repository URL."
    };
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return {
      error: "Use an HTTPS repository URL from github.com."
    };
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length !== 2) {
    return {
      error: "URL must look like github.com/owner/repository."
    };
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");

  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner) ||
    !/^[a-zA-Z0-9._-]+$/.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    return {
      error: "The repository URL format is invalid."
    };
  }

  if (!["Node.js", "Python", "C++", "Java"].includes(runtime)) {
    return { error: "Select a supported runtime." };
  }

  return {
    value: {
      name,
      repository: `https://github.com/${owner}/${repo}`,
      runtime
    }
  };
}

// HTTP server and API routes
const server = http.createServer(async (req, res) => {
  let pathname;

  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    return sendJson(res, 400, {
      error: "Invalid request URL."
    });
  }

  // 1. API health
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "CloudOrbit API",
      status: "online",
      storage: "JSON file"
    });
  }

  // 2. List projects
  if (req.method === "GET" && pathname === "/api/projects") {
    return sendJson(res, 200, { projects });
  }

  // 3. Create project
  if (req.method === "POST" && pathname === "/api/projects") {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, {
        error: "Send project details as JSON."
      });
    }

    let data;

    try {
      data = await readJson(req);
    } catch (error) {
      return sendJson(
        res,
        error.message === "REQUEST_TOO_LARGE" ? 413 : 400,
        {
          error:
            error.message === "REQUEST_TOO_LARGE"
              ? "Request is too large."
              : "Invalid JSON request."
        }
      );
    }

    const validation = validateProject(data);

    if (validation.error) {
      return sendJson(res, 400, {
        error: validation.error
      });
    }

    const project = {
      id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...validation.value,
      status: "Configuration prepared",
      createdAt: new Date().toISOString()
    };

    projects.unshift(project);

    try {
      saveProjects();
    } catch (error) {
      projects.shift();

      console.error("Project save failed:", error.message);

      return sendJson(res, 500, {
        error: "Project could not be saved."
      });
    }

    return sendJson(res, 201, {
      message: "Project saved successfully.",
      project
    });
  }

  // 4. Delete project
  const deleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);

  if (req.method === "DELETE" && deleteMatch) {
    const projectId = deleteMatch[1];

    const projectIndex = projects.findIndex(
      project => project.id === projectId
    );

    if (projectIndex === -1) {
      return sendJson(res, 404, {
        error: "Project not found."
      });
    }

    const deletedProject = projects.splice(projectIndex, 1)[0];

    try {
      saveProjects();
    } catch (error) {
      projects.splice(projectIndex, 0, deletedProject);

      console.error("Project deletion failed:", error.message);

      return sendJson(res, 500, {
        error: "Project could not be deleted."
      });
    }

    return sendJson(res, 200, {
      message: "Project deleted successfully.",
      project: deletedProject
    });
  }

  // 5. Serve homepage
  if (
    req.method === "GET" &&
    (pathname === "/" || pathname === "/index.html")
  ) {
    return fs.readFile(INDEX_FILE, (error, content) => {
      if (error) {
        return sendJson(res, 500, {
          error: "Website file not found. Check public/index.html."
        });
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });

      res.end(content);
    });
  }

  // 6. Unknown API routes
  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, {
      error: "API endpoint not found."
    });
  }

  return sendJson(res, 404, {
    error: "Page not found."
  });
});

// Server errors
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error("Try setting PORT=3002 in PowerShell.");
  } else {
    console.error("Server error:", error.message);
  }

  process.exitCode = 1;
});

// Start server
server.listen(PORT, HOST, () => {
  console.log(`CloudOrbit: http://${HOST}:${PORT}`);
  console.log(`API health: http://${HOST}:${PORT}/api/health`);
  console.log(`Projects API: http://${HOST}:${PORT}/api/projects`);
  console.log(`Storage file: ${PROJECTS_FILE}`);
});
