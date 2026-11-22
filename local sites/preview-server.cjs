const { execFile } = require('node:child_process');
const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');

const root = __dirname;
const port = Number(process.argv[2] ?? 4173);
const run = promisify(execFile);
const sitePaths = ['--', '.', ':(exclude)README.md', ':(exclude)originals'];
const mime = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown'
};

async function git(...args) {
  const { stdout } = await run('git', ['-c', 'i18n.logOutputEncoding=utf-8', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true
  });
  return stdout;
}

async function getUpdates() {
  const [history, status] = await Promise.all([
    git('log', '-z', '--pretty=format:%H%x00%cs%x00%s%x00%b', ...sitePaths),
    git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', ...sitePaths)
  ]);
  const records = [];
  const fields = history ? history.split('\0') : [];
  for (let i = 0; i < fields.length; i += 4) {
    const [id, date, title, body] = fields.slice(i, i + 4);
    records.push({ id, date, title, summary: body.trim().split(/\n\s*\n/, 1)[0] });
  }
  const prefix = path.basename(root) + '/';
  const files = status.split('\0').filter(Boolean).map(entry => entry.slice(3)).map(file =>
    file.startsWith(prefix) ? file.slice(prefix.length) : file
  );
  return { records, files };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/__hub/updates') {
    try {
      const updates = await getUpdates();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(req.method === 'HEAD' ? undefined : JSON.stringify(updates));
    } catch {
      res.writeHead(503).end();
    }
    return;
  }

  let file = path.resolve(root, '.' + pathname);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    if (!(await stat(file)).isFile()) {
      res.writeHead(404).end();
      return;
    }
  } catch {
    res.writeHead(404).end();
    return;
  }
  const type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  console.log('Hub 本地原型已启动 ' + url);
  if (process.argv.includes('--open')) {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true });
  }
});
