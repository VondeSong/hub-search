param(
  [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Url = "http://127.0.0.1:$Port/"

Write-Host "Hub 本地原型服务启动中..." -ForegroundColor Cyan
Write-Host "目录: $Root"
Write-Host "地址: $Url" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止服务。"

Start-Process $Url

$NodeScript = @"
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.argv[1];
const port = Number(process.argv[2]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

http.createServer((req, res) => {
  const cleanUrl = (req.url || '/').split('?')[0];
  let rel = decodeURIComponent(cleanUrl === '/' ? '/index.html' : cleanUrl).replace(/^\/+/, '');
  let filePath = path.resolve(root, rel);
  if (!filePath.startsWith(path.resolve(root))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}).listen(port, '127.0.0.1');
"@

node -e $NodeScript $Root $Port
