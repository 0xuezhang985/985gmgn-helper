"""Whitelist deployment, based on the fresh production source. Default: dry-run.
Run with --apply after offline tests. Credentials are loaded locally, never printed.
"""
from pathlib import Path
import argparse, hashlib, json, re, shlex, time
import paramiko

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
parser.add_argument('--ssh-proxy-port', type=int, help='Optional existing localhost HTTP proxy; no automatic connection retries')
args = parser.parse_args()
secret_source = Path('F:/xuhuohua/_deploy_widget_stage2.py').read_text(encoding='utf8')
def setting(name):
    return re.search(r'\b' + name + r'\s*=\s*["\']([^"\']+)', secret_source).group(1)
ssh = paramiko.SSHClient()
ssh.load_host_keys(str(Path.home() / '.ssh/known_hosts'))
ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
proxy_socket = None
if args.ssh_proxy_port:
    import socks
    proxy_socket = socks.socksocket()
    proxy_socket.set_proxy(socks.HTTP, '127.0.0.1', args.ssh_proxy_port)
    proxy_socket.settimeout(30)
    proxy_socket.connect((setting('HOST'), 22))
ssh.connect(setting('HOST'), username=setting('USER'), password=setting('PW'), timeout=60,
            banner_timeout=45, auth_timeout=30, look_for_keys=False, allow_agent=False, sock=proxy_socket)
sftp = ssh.open_sftp()
sftp.get_channel().settimeout(60)
def run(cmd):
    _, out, err = ssh.exec_command(cmd, timeout=90)
    data, error = out.read().decode('utf8', 'replace'), err.read().decode('utf8', 'replace')
    if out.channel.recv_exit_status():
        raise RuntimeError('remote command failed: ' + error[:300])
    return data.strip()
def read(file):
    with sftp.open(file, 'rb') as f:
        f.prefetch()
        return f.read()
def sha(data): return hashlib.sha256(data).hexdigest()
base = '/opt/x-monitor-widget/server'
target = base + '/widget-server.js'
stamp = time.strftime('%Y%m%d-%H%M%S')
stage = ROOT / 'dist' / ('rank-server-' + stamp)
stage.mkdir(parents=True, exist_ok=True)
try:
    print('Reading fresh production source...', flush=True)
    original = read(target)
    (stage / 'widget-server.before.js').write_bytes(original)
    source = original.decode('utf8')
    if 'fomoBrowserRankCollector' in source:
        raise RuntimeError('collector already integrated; inspect current production before updating')
    replacements = [
        ('  sseClients.add(client);', '''  client.fomoRankCollectorReady = extensionFeedOnly
    && new URL(req.url, "http://127.0.0.1").searchParams.get("fomoRankCollector") === "1";
  sseClients.add(client);'''),
        ('function ensureFomoLeaderboardDailyPush() {', '''let browserRankCollector = null;
function fomoBrowserRankCollector() {
  if (!browserRankCollector) browserRankCollector = require("./fomo-rank-collector.cjs").createCollector({
    dataDir: DATA_DIR, snapshotPath: FOMO_LEADERBOARDS_PATH, clients: () => sseClients,
    log: (event, detail) => log("fomo-browser-ranks", event, detail)
  });
  return browserRankCollector;
}
function ensureFomoBrowserRankCollector() {
  const tick = () => {
    try { fomoBrowserRankCollector().tick(); }
    catch { log("fomo-browser-ranks", "collector state unavailable; preserving existing snapshot", {}, "warn"); }
  };
  const initial = setTimeout(tick, 15000), timer = setInterval(tick, 60000);
  initial.unref?.(); timer.unref?.();
}
function ensureFomoLeaderboardDailyPush() {'''),
        ('  if (req.method === "GET" && pathname === "/api/extension/events-stream") {', '''  if (req.method === "POST" && pathname === "/api/extension/fomo-rank-result") {
    if (!checkRateLimit(req, res, { name: "fomo-rank-result", ip, limit: 8, windowMs: 60 * 60_000 })) return;
    let ctx;
    try { ctx = getExtensionUserContext(req); }
    catch { return sendJson(res, 401, { ok: false, error: "extension login required" }); }
    try {
      const body = await readRequestJson(req, 512 * 1024);
      const result = fomoBrowserRankCollector().accept(ctx, body);
      return sendJson(res, result.status, result.body);
    } catch {
      return sendJson(res, 500, { ok: false, error: "snapshot not published" });
    }
  }
  if (req.method === "GET" && pathname === "/api/extension/events-stream") {'''),
        ('  try { ensureFomoLeaderboardDailyPush(); }', '  ensureFomoBrowserRankCollector();\n  try { ensureFomoLeaderboardDailyPush(); }'),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise RuntimeError('production anchor mismatch; no file was overwritten')
        source = source.replace(old, new, 1)
    patched = source.encode('utf8')
    (stage / 'widget-server.js').write_bytes(patched)
    module = (ROOT / 'server/fomo-rank-collector.cjs').read_bytes()
    protected = [base + '/widget-config.json', '/opt/fomo-collector/gen_leaderboards.py',
                 '/opt/fomo-collector/leaderboard_runtime.py', '/opt/x-monitor-widget/web/fomo-leaderboards.json',
                 '/etc/systemd/system/fomo-leaderboards.timer', '/etc/systemd/system/fomo-leaderboards.service']
    print('Checking protected files and existing health...', flush=True)
    baseline = {file: run('sha256sum ' + shlex.quote(file)).split()[0] for file in protected}
    fomo_before = run('systemctl list-units --all --type=service --plain --no-legend "*fomo*" | awk \'{print $1}\' | xargs -r systemctl show -p Id -p MainPID -p ActiveState')
    run('curl -fsS --max-time 15 http://127.0.0.1:3030/api/health >/dev/null')
    print(json.dumps({'mode': 'apply' if args.apply else 'dry-run', 'mainBefore': sha(original), 'mainAfter': sha(patched),
                      'module': sha(module), 'stage': str(stage)}, ensure_ascii=False), flush=True)
    if not args.apply:
        raise SystemExit(0)
    # Optimistic concurrency check immediately before writing; no stale local main file upload.
    if sha(read(target)) != sha(original):
        raise RuntimeError('production changed during preparation')
    backup = '/opt/x-monitor-widget/backup-browser-ranks-' + stamp
    run('mkdir -m 700 ' + shlex.quote(backup))
    run('cp -a ' + shlex.quote(target) + ' ' + shlex.quote(backup + '/widget-server.js'))
    run('if test -f ' + shlex.quote(base + '/fomo-rank-collector.cjs') + '; then cp -a ' + shlex.quote(base + '/fomo-rank-collector.cjs') + ' ' + shlex.quote(backup) + '/; fi')
    for name, data in [('widget-server.staged.js', patched), ('fomo-rank-collector.staged.cjs', module)]:
        file = base + '/' + name
        with sftp.open(file, 'wb') as f: f.write(data)
        if run('sha256sum ' + shlex.quote(file)).split()[0] != sha(data): raise RuntimeError('upload hash mismatch')
        run('node --check ' + shlex.quote(file))
    if run('sha256sum ' + shlex.quote(target)).split()[0] != sha(original):
        raise RuntimeError('production changed before final activation')
    try:
        run('mv ' + shlex.quote(base + '/fomo-rank-collector.staged.cjs') + ' ' + shlex.quote(base + '/fomo-rank-collector.cjs'))
        run('mv ' + shlex.quote(base + '/widget-server.staged.js') + ' ' + shlex.quote(target))
        run('systemctl restart x-monitor-widget && systemctl is-active x-monitor-widget')
        run('curl -fsS --max-time 15 http://127.0.0.1:3030/api/health >/dev/null')
    except Exception:
        run('cp -a ' + shlex.quote(backup + '/widget-server.js') + ' ' + shlex.quote(target) + ' && systemctl restart x-monitor-widget')
        raise
    after = {file: run('sha256sum ' + shlex.quote(file)).split()[0] for file in protected}
    if after != baseline: raise RuntimeError('protected files changed; inspect before any further operation')
    fomo_after = run('systemctl list-units --all --type=service --plain --no-legend "*fomo*" | awk \'{print $1}\' | xargs -r systemctl show -p Id -p MainPID -p ActiveState')
    unauth = run('curl -sS --max-time 15 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data "{}" http://127.0.0.1:3030/api/extension/fomo-rank-result')
    if unauth != '401': raise RuntimeError('unauthenticated contribution was not rejected with 401')
    report = {'backup': backup, 'mainSha': sha(read(target)), 'moduleSha': sha(read(base + '/fomo-rank-collector.cjs')),
              'protectedFilesUnchanged': after == baseline, 'fomoServiceStateUnchanged': fomo_before == fomo_after,
              'contributionUnauthStatus': unauth, 'service': 'active'}
    (stage / 'deployment.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps(report))
finally:
    sftp.close(); ssh.close()
