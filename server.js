
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const RENDER_API = "https://api.render.com/v1";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "projects.json");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]");
}

function readProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]");
    return Array.isArray(data) ? data : (data.projects || []);
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(projects, null, 2));
}

function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Request body too large"));
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

async function renderRequest(endpoint, method = "GET", body) {
  const key = process.env.RENDER_API_KEY;

  if (!key) {
    throw new Error("RENDER_API_KEY is missing in Render environment");
  }

  const response = await fetch(RENDER_API + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    throw new Error(
      data.message || data.error || JSON.stringify(data) ||
      `Render API error: ${response.status}`
    );
  }

  return data;
}

async function deployProject(body) {
  const repo = String(body.repository || "").trim();
  const projectName = String(body.name || "cloudorbit-app").trim();

  let repoUrl;
  try {
    repoUrl = new URL(repo);
  } catch {
    throw new Error("Valid GitHub repository URL required");
  }

  if (repoUrl.hostname !== "github.com") {
    throw new Error("Only GitHub repository URLs are supported");
  }

  const parts = repoUrl.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid GitHub repository URL");
  }

  const cleanRepo =
    `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}`;

  const runtime = String(body.runtime || "Node.js").toLowerCase();

  let renderRuntime;
  let buildCommand;
  let startCommand;

  if (runtime.includes("node")) {
    renderRuntime = "node";
    buildCommand = "npm install";
    startCommand = "npm start";
  } else if (runtime.includes("python")) {
    renderRuntime = "python";
    buildCommand = "pip install -r requirements.txt";
    startCommand = "gunicorn app:app";
  } else {
    throw new Error("Only Node.js and Python runtimes are supported");
  }

  const services = await renderRequest("/services?limit=100");

  const serviceList = Array.isArray(services)
    ? services.map(item => item.service || item)
    : [];

  const existing = serviceList.find(service => service.name === "CloudOrbit");

  if (!existing || !existing.ownerId) {
    throw new Error(
      "Could not find CloudOrbit workspace. Check Render API permissions."
    );
  }

  const uniqueName =
    projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-") +
    "-" + Date.now().toString().slice(-6);

  const payload = {
    type: "web_service",
    name: uniqueName,
    ownerId: existing.ownerId,
    repo: cleanRepo,
    branch: body.branch || "main",
    autoDeployTrigger: "commit",
    serviceDetails: {
      runtime: renderRuntime,
      region: "singapore",
      plan: "free",
      envSpecificDetails: {
        buildCommand,
        startCommand
      }
    }
  };

  return await renderRequest("/services", "POST", payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJSON(res, 200, {
        ok: true,
        service: "CloudOrbit API",
        status: "online"
      });
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      return sendJSON(res, 200, { projects: readProjects() });
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await getBody(req);
      const projects = readProjects();

      const project = {
        id: "co_" + Date.now(),
        name: body.name || "Untitled Project",
        runtime: body.runtime || "Node.js",
        repository: body.repository || "",
        status: "Configuration prepared",
        createdAt: new Date().toISOString()
      };

      projects.unshift(project);
      saveProjects(projects);

      return sendJSON(res, 201, { success: true, project });
    }

    if (req.method === "POST" && pathname === "/api/deploy") {
      const body = await getBody(req);
      const deployment = await deployProject(body);

      const projects = readProjects();
      const project = {
        id: "co_" + Date.now(),
        name: body.name || "CloudOrbit App",
        runtime: body.runtime || "Node.js",
        repository: body.repository,
        status: "Deployment requested",
        deploymentId: deployment.id || null,
        createdAt: new Date().toISOString()
      };

      projects.unshift(project);
      saveProjects(projects);

      return sendJSON(res, 201, {
        success: true,
        message: "Deployment request sent to Render",
        project,
        deployment
      });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/projects/")) {
      const id = pathname.split("/").pop();
      const projects = readProjects();
      const updated = projects.filter(project => project.id !== id);

      saveProjects(updated);
      return sendJSON(res, 200, { success: true });
    }

    if (req.method === "GET") {
      const requested = pathname === "/" ? "index.html" : pathname.slice(1);
      const filePath = path.resolve(PUBLIC_DIR, requested);

      if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) &&
          filePath !== path.join(PUBLIC_DIR, "index.html")) {
        return sendJSON(res, 403, { error: "Forbidden" });
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const types = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".json": "application/json"
        };

        res.writeHead(200, {
          "Content-Type": types[ext] || "application/octet-stream"
        });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    return sendJSON(res, 404, { error: "API endpoint not found." });

  } catch (error) {
    console.error("CloudOrbit error:", error.message);
    return sendJSON(res, 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CloudOrbit running on ${HOST}:${PORT}`);
});
