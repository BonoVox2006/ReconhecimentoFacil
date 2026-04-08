import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, "public");
const PORT = parseInt(process.env.PORT || "3847", 10);

const ALLOWED_PREFIX = "https://www.camara.leg.br/internet/deputado/bandep/";

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".webmanifest":
      return "application/manifest+json";
    default:
      return "application/octet-stream";
  }
}

function isSafePublicPath(resolved) {
  const pub = path.resolve(PUBLIC) + path.sep;
  return resolved.startsWith(pub);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/proxy-image" && req.method === "GET") {
      const imageUrl = url.searchParams.get("url");
      if (
        !imageUrl ||
        !imageUrl.startsWith(ALLOWED_PREFIX) ||
        !/^\d+\.jpg$/i.test(path.basename(imageUrl))
      ) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("URL de imagem inválida.");
        return;
      }
      const upstream = await fetch(imageUrl, { redirect: "follow" });
      if (!upstream.ok) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Falha ao buscar imagem.");
        return;
      }
      const ct = upstream.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": ct,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(buf);
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const filePath = path.resolve(PUBLIC, "." + pathname);
    if (!isSafePublicPath(filePath)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Não encontrado.");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Erro interno.");
  }
});

// 0.0.0.0: necessario na Render (e util na rede local); no PC continua acessivel em 127.0.0.1
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Camara Face: http://localhost:${PORT}`);
  console.log("No celular use HTTPS (túnel ou deploy) para a câmera funcionar.");
});
