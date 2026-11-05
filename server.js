
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const RENDER_API = "https://api.render.com/v1";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "projects.json");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");

function readProjects() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]");
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
        req.on("data", chunk => body += chunk);
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

    if (!key) throw new Error("RENDER_API_KEY is missing in Render environment");

    const response = await fetch(RENDER_API + endpoint, {
        method,
        headers: {
            "Authorization": `Bearer ${key}`,
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.message || data.error || `Render API error: ${response.status}`);
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

    const cleanRepo = `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}`;

    const runtime = String(body.runtime || "Node.js");

    let renderRuntime;
    let buildCommand;
    let startCommand;

    if (runtime.toLowerCase().includes("node")) {
        renderRuntime = "node";
        buildCommand = "npm install";
        startCommand = "npm start";
    } else if (runtime.toLowerCase().includes("python")) {
        renderRuntime = "python";
        buildCommand = "pip install -r requirements.txt";
        startCommand = "gunicorn app:app";
    } else {
        throw new Error("Currently supported runtimes: Node.js and Python");
    }

    // Find CloudOrbit workspace ID from its existing Render service
    const services = await renderRequest("/services?limit=100");
    const existing = services
        .map(item => item.service || item)
        .find(service => service.name === "CloudOrbit");

    if (!existing || !existing.ownerId) {
        throw new Error("Could not find CloudOrbit workspace. Check Render API permissions.");
    }

    const uniqueName =
        projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")
        + "-" + Date.now().toString().slice(-6);

    const result = await renderRequest("/services", "POST", {
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
            buildCommand,
            startCommand
        }
    });

    return result;
}

const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (req.method === "GET" && pathname === "/api/health") {
        return sendJSON(res, 200, {
            status: "online",
            message: "CloudOrbit API is running"
        });
    }

    if (req.method === "GET" && pathname === "/api/projects") {
        return sendJSON(res, 200, { projects: readProjects() });
    }

    if (req.method === "POST" && pathname === "/api/projects") {
        try {
            const body = await getBody(req);

            if (!body.name || !body.runtime) {
                return sendJSON(res, 400, { error: "Name and runtime are required" });
            }

            const projects = readProjects();

            const project = {
                id: "co_" + Date.now(),
                name: body.name,
                runtime: body.runtime,
                repository: body.repository || "",
                status: "Configuration prepared",
                createdAt: new Date().toISOString()
            };

            projects.unshift(project);
            saveProjects(projects);

            return sendJSON(res, 201, { message: "Project saved", project });
        } catch (error) {
            return sendJSON(res, 400, { error: error.message });
        }
    }

    // Create and deploy a GitHub project on Render
    if (req.method === "POST" && pathname === "/api/deploy") {
        try {
            const body = await getBody(req);
            const result = await deployProject(body);
            const service = result.service || result;

            const projects = readProjects();
            const project = {
                id: "co_" + Date.now(),
                name: body.name,
                repository: body.repository,
                runtime: body.runtime || "Node.js",
                status: "Deployment requested",
                renderServiceId: service.id,
                renderDashboardUrl: service.dashboardUrl,
                createdAt: new Date().toISOString()
            };

            projects.unshift(project);
            saveProjects(projects);

            return sendJSON(res, 201, {
                message: "Render deployment created",
                project,
                dashboardUrl: service.dashboardUrl,
                serviceId: service.id
            });
        } catch (error) {
            return sendJSON(res, 400, { error: error.message });
        }
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/projects/")) {
        const id = pathname.split("/").pop();
        const projects = readProjects();
        const updated = projects.filter(p => p.id !== id);

        if (updated.length === projects.length) {
            return sendJSON(res, 404, { error: "Project not found" });
        }

        saveProjects(updated);
        return sendJSON(res, 200, { message: "Project deleted" });
    }

    if (req.method === "GET") {
        const requested = pathname === "/" ? "/index.html" : pathname;
        const file = path.resolve(PUBLIC_DIR, "." + requested);

        if (!file.startsWith(PUBLIC_DIR + path.sep) &&
            file !== path.join(PUBLIC_DIR, "index.html")) {
            res.writeHead(403);
            return res.end("Forbidden");
        }

        return fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404);
                return res.end("File not found");
            }

            const types = {
                ".html": "text/html",
                ".css": "text/css",
                ".js": "application/javascript",
                ".json": "application/json"
            };

            res.writeHead(200, {
                "Content-Type": types[path.extname(file)] || "application/octet-stream"
            });
            res.end(data);
        });
    }

    return sendJSON(res, 404, { error: "Endpoint not found" });
});

server.listen(PORT, HOST, () => {
    console.log(`CloudOrbit running on ${HOST}:${PORT}`);
});
