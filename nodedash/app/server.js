const express = require('express');
const os = require('os');
const { execSync } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Node identity & theme ──────────────────────────────────
const HOSTNAME = os.hostname();

const NODE_THEMES = {
  rk1: { color: '#c0392b', accent: '#e74c3c', label: 'Node 1 — rk1', glow: 'rgba(192,57,43,0.4)' },
  rk2: { color: '#1565c0', accent: '#1e88e5', label: 'Node 2 — rk2', glow: 'rgba(21,101,192,0.4)' },
  rk3: { color: '#2e7d32', accent: '#43a047', label: 'Node 3 — rk3', glow: 'rgba(46,125,50,0.4)' },
  rk4: { color: '#e65100', accent: '#fb8c00', label: 'Node 4 — rk4', glow: 'rgba(230,81,0,0.4)' },
};

function getTheme() {
  for (const [node, theme] of Object.entries(NODE_THEMES)) {
    if (HOSTNAME.startsWith(node)) return { node, ...theme };
  }
  return { node: 'unknown', color: '#37474f', accent: '#78909c', label: HOSTNAME, glow: 'rgba(55,71,79,0.4)' };
}

// ── System stats ───────────────────────────────────────────
function getIPAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

function getCPUUsage() {
  try {
    const load = os.loadavg();
    const cpuCount = os.cpus().length;
    return {
      load1: load[0].toFixed(2),
      load5: load[1].toFixed(2),
      load15: load[2].toFixed(2),
      percent: Math.min(100, (load[0] / cpuCount) * 100).toFixed(1),
      cores: cpuCount,
      model: os.cpus()[0]?.model || 'ARM Cortex',
    };
  } catch { return { load1: 0, load5: 0, load15: 0, percent: 0, cores: 4, model: 'ARM' }; }
}

function getMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total: (total / 1024 / 1024 / 1024).toFixed(2),
    used: (used / 1024 / 1024 / 1024).toFixed(2),
    free: (free / 1024 / 1024 / 1024).toFixed(2),
    percent: ((used / total) * 100).toFixed(1),
  };
}

function getDisk() {
  try {
    const out = execSync("df -h / | tail -1 | awk '{print $2,$3,$4,$5}'", { timeout: 2000 }).toString().trim().split(' ');
    return { total: out[0], used: out[1], free: out[2], percent: out[3] };
  } catch { return { total: '?', used: '?', free: '?', percent: '0%' }; }
}

function getUptime() {
  const s = os.uptime();
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function getNetworkStats() {
  try {
    const out = execSync("cat /proc/net/dev | grep -v lo | grep -v Inter | grep -v face | head -5", { timeout: 2000 }).toString().trim();
    const lines = out.split('\n').filter(l => l.trim());
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const iface = parts[0].replace(':', '');
      return {
        iface,
        rxBytes: (parseInt(parts[1] || 0) / 1024 / 1024).toFixed(1) + ' MB',
        txBytes: (parseInt(parts[9] || 0) / 1024 / 1024).toFixed(1) + ' MB',
      };
    });
  } catch { return []; }
}

function getTopProcesses() {
  try {
    const out = execSync("ps aux --sort=-%cpu | head -8 | tail -7 | awk '{print $1,$2,$3,$4,$11}'", { timeout: 2000 }).toString().trim();
    return out.split('\n').map(line => {
      const p = line.trim().split(/\s+/);
      return { user: p[0], pid: p[1], cpu: p[2], mem: p[3], cmd: (p[4] || '').replace(/.*\//, '').slice(0, 20) };
    });
  } catch { return []; }
}

function getSystemStats() {
  return {
    hostname: HOSTNAME,
    ip: getIPAddress(),
    uptime: getUptime(),
    cpu: getCPUUsage(),
    memory: getMemory(),
    disk: getDisk(),
    network: getNetworkStats(),
    processes: getTopProcesses(),
    platform: os.platform(),
    arch: os.arch(),
    kernelVersion: os.release(),
    timestamp: new Date().toISOString(),
    theme: getTheme(),
  };
}

// ── In-memory user store ───────────────────────────────────
const USERS = [
  { id: 1, email: 'mike1@my.lab', name: 'Mike One',   role: 'admin',    apiKey: 'mk1-' + Buffer.from('mike1@my.lab').toString('hex').slice(0,16) },
  { id: 2, email: 'mike2@my.lab', name: 'Mike Two',   role: 'operator', apiKey: 'mk2-' + Buffer.from('mike2@my.lab').toString('hex').slice(0,16) },
  { id: 3, email: 'mike3@my.lab', name: 'Mike Three', role: 'operator', apiKey: 'mk3-' + Buffer.from('mike3@my.lab').toString('hex').slice(0,16) },
  { id: 4, email: 'mike4@my.lab', name: 'Mike Four',  role: 'viewer',   apiKey: 'mk4-' + Buffer.from('mike4@my.lab').toString('hex').slice(0,16) },
  { id: 5, email: 'mike5@my.lab', name: 'Mike Five',  role: 'viewer',   apiKey: 'mk5-' + Buffer.from('mike5@my.lab').toString('hex').slice(0,16) },
];

const MESSAGES = [];
let msgIdCounter = 1;

// ── Auth middleware ────────────────────────────────────────
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Api-Key header' });
  const user = USERS.find(u => u.apiKey === apiKey);
  if (!user) return res.status(403).json({ error: 'Invalid API key' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Role '${req.user.role}' is not permitted. Required: ${roles.join(' or ')}` });
    }
    next();
  };
}

// ── API Routes ─────────────────────────────────────────────

// Health / no-auth
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', node: HOSTNAME, ip: getIPAddress(), time: new Date().toISOString() });
});

// Node info
app.get('/api/node', (req, res) => {
  res.json({ hostname: HOSTNAME, ip: getIPAddress(), theme: getTheme(), uptime: getUptime() });
});

// Full stats (live)
app.get('/api/stats', (req, res) => {
  res.json(getSystemStats());
});

// Users — list (auth required)
app.get('/api/users', authenticate, (req, res) => {
  const safe = USERS.map(({ apiKey, ...u }) => u);
  res.json({ users: safe, requestedBy: req.user.email, node: HOSTNAME });
});

// Users — get single user
app.get('/api/users/:id', authenticate, (req, res) => {
  const user = USERS.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { apiKey, ...safe } = user;
  res.json({ user: safe, requestedBy: req.user.email, node: HOSTNAME });
});

// Users — get own API key
app.get('/api/users/:id/key', authenticate, (req, res) => {
  const target = USERS.find(u => u.id === parseInt(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (req.user.id !== target.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Can only view your own API key unless admin' });
  }
  res.json({ email: target.email, apiKey: target.apiKey, node: HOSTNAME });
});

// Messages — list
app.get('/api/messages', authenticate, (req, res) => {
  res.json({ messages: MESSAGES.slice(-50), count: MESSAGES.length, node: HOSTNAME });
});

// Messages — post
app.post('/api/messages', authenticate, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text field required' });
  const msg = {
    id: msgIdCounter++,
    text: text.trim(),
    author: req.user.email,
    node: HOSTNAME,
    timestamp: new Date().toISOString(),
  };
  MESSAGES.push(msg);
  res.status(201).json({ message: msg });
});

// Messages — delete (admin only)
app.delete('/api/messages/:id', authenticate, requireRole('admin'), (req, res) => {
  const idx = MESSAGES.findIndex(m => m.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Message not found' });
  const [removed] = MESSAGES.splice(idx, 1);
  res.json({ deleted: removed, node: HOSTNAME });
});

// Cluster echo — useful for traffic gen
app.post('/api/echo', authenticate, (req, res) => {
  res.json({
    echo: req.body,
    servedBy: HOSTNAME,
    ip: getIPAddress(),
    user: req.user.email,
    timestamp: new Date().toISOString(),
  });
});

// ── Serve dashboard ────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${HOSTNAME}] NodeDash running on :${PORT}`);
  console.log(`Theme: ${getTheme().label} — ${getTheme().color}`);
});
