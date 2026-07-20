// Minimal static file server for local development.
// Usage:  node server.js   ->  http://localhost:8080/index.html
const http = require("http");
const fs = require("fs");
const path = require("path");

// node server.js


const ROOT = path.join(__dirname, "webapp");
const PORT = process.env.PORT || 8080;
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".properties": "text/plain; charset=utf-8"
};

http.createServer(function (req, res) {
	let rel = decodeURIComponent(req.url.split("?")[0]);
	if (rel === "/") { rel = "/index.html"; }
	const file = path.join(ROOT, rel);
	if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
	fs.readFile(file, function (err, data) {
		if (err) { res.writeHead(404); return res.end("Not found: " + rel); }
		res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
		res.end(data);
	});
}).listen(PORT, function () {
	console.log("Serving webapp/ at http://localhost:" + PORT + "/index.html");
});
