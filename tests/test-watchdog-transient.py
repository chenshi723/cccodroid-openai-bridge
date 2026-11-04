#!/usr/bin/env python3
"""Reproduce a local health outage using a disposable bridge, never live keys.

The HTTP server stays alive and keeps writing a heartbeat. It accepts requests
but withholds responses while a marker is present. This models a failed probe,
not proof of Android freezing or the cause of a historical incident.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent.parent


def wait_for(check, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError('test condition timed out')


class Fixture:
    def __init__(self, source, **overrides):
        self.root = Path(tempfile.mkdtemp(prefix='bridge-health-outage-', dir=os.environ['TMPDIR'])).resolve()
        self.state = self.root / 'runtime-home/.claude-code-router'
        self.state.mkdir(parents=True, mode=0o700)
        self.cli = self.root / 'node_modules/@musistudio/claude-code-router/dist/cli.js'
        self.cli.parent.mkdir(parents=True)
        for name in ['bridge-common.sh', 'watchdog.sh', 'health.cjs', 'start-bridge.sh']:
            shutil.copyfile(source / name, self.root / name)
        (self.root / 'patch-ccr.js').write_text('process.exit(0);\n')
        (self.root / 'component.cjs').write_text('// disposable component identity\n')
        (self.root / '.ccr-bridge-kit.json').write_text(json.dumps({
            'id': 'ccr-bridge-kit', 'target': str(self.root),
            'componentEntry': str(self.root / 'component.cjs'),
        }))
        self.cli.write_text(r'''
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const state = path.join(process.env.HOME, '.claude-code-router');
fs.writeFileSync(path.join(state, '.claude-code-router.pid'), String(process.pid));
fs.appendFileSync(path.join(state, 'starts'), process.pid + '\n');
const pulse = setInterval(() => fs.writeFileSync(path.join(state, 'heartbeat'), String(Date.now())), 100);
const server = http.createServer((req, res) => {
  if (fs.existsSync(path.join(state, 'blocked'))) return;
  res.end('{"status":"ok"}');
});
server.listen(Number(process.env.SERVICE_PORT), '127.0.0.1');
process.on('SIGTERM', () => { clearInterval(pulse); server.closeAllConnections(); server.close(() => process.exit(0)); });
''')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        (self.root / 'port').write_text(str(self.port))
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('CCR_BRIDGE_')}
        self.env.update(CCR_BRIDGE_INTERVAL='0.2', CCR_BRIDGE_GRACE='1',
                        CCR_BRIDGE_FAIL_LIMIT='3', CCR_BRIDGE_RECOVERY_LIMIT='3',
                        CCR_BRIDGE_RECOVERY_STABLE='60')
        self.env.update(overrides)
        for key in ['BASH_ENV', 'NODE_OPTIONS', 'SERVICE_PORT', 'CCAPP_RUN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']:
            self.env.pop(key, None)
        self.capture = (self.root / 'watchdog-output').open('wb')
        self.watch = subprocess.Popen(['bash', str(self.root / 'watchdog.sh')],
                                      env=self.env, stdout=self.capture, stderr=self.capture)
        wait_for(lambda: (self.state / 'heartbeat').exists())
        wait_for(self.healthy)

    def healthy(self):
        result = subprocess.run(['node', str(self.root / 'health.cjs'), str(self.port)],
                                capture_output=True, timeout=5)
        return result.returncode == 0

    def pid(self):
        return int((self.state / '.claude-code-router.pid').read_text())

    def starts(self):
        return len((self.state / 'starts').read_text().splitlines())

    def block(self):
        (self.state / 'blocked').touch()

    def unblock(self):
        (self.state / 'blocked').unlink()

    def close(self):
        if self.watch.poll() is None:
            self.watch.terminate()
            try:
                self.watch.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.watch.kill()
                self.watch.wait(timeout=3)
        for pid in set(int(p) for p in (self.state / 'starts').read_text().splitlines()):
            try:
                args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                if str(self.cli).encode() in args:
                    os.kill(pid, signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass
        self.capture.close()
        shutil.rmtree(self.root)


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--source', type=Path, default=HERE / 'runtime')
    args.add_argument('--expect', choices=['latch', 'survive'], default='survive')
    args.add_argument('--outage', type=float, default=35)
    args.add_argument('--grace', type=str)
    options = args.parse_args()
    settings = {'CCR_BRIDGE_HEALTH_GRACE': options.grace} if options.grace else {}
    f = Fixture(options.source, **settings)
    try:
        original = f.pid()
        time.sleep(1.2)
        f.block()
        started = time.monotonic()
        until = started + options.outage
        while time.monotonic() < until and f.watch.poll() is None:
            time.sleep(0.1)
        heartbeat_age = time.time() - int((f.state / 'heartbeat').read_text()) / 1000
        f.unblock()
        wait_for(f.healthy)
        fault = (f.state / 'recovery.failed').exists()
        result = {
            'expect': options.expect,
            'elapsed_seconds': round(time.monotonic() - started, 2),
            'watchdog_exit': f.watch.poll(),
            'server_starts': f.starts(),
            'same_bridge_pid': f.pid() == original,
            'fault_latched': fault,
            'heartbeat_age_seconds': round(heartbeat_age, 2),
            'healthy_after_outage': True,
        }
        if options.expect == 'latch':
            assert fault and f.watch.returncode == 1 and f.starts() == 3, result
        else:
            assert not fault and f.watch.poll() is None and f.starts() == 1 and f.pid() == original, result
        print(json.dumps(result, indent=2), flush=True)
    finally:
        f.close()


if __name__ == '__main__':
    main()
