#!/usr/bin/env python3
"""A logging forward proxy for the http-log mod. Standard library only; Python 3.8+; Windows, Linux and macOS.

    python http_log_proxy.py <log file> [retention in seconds]

Besides logging it cleans up: every minute it removes the other `.jsonl` files in the log file's folder (one per
command the wrapper tapped) and the lines of the log itself that are older than the retention (an hour by default).

Listens on 127.0.0.1 on a port the system picks and prints `PORT <n>` once it is ready. Every request that goes
through it is appended to <log file> as one JSON line:

  - plain HTTP: method, url, request body, status, response body: all of it;
  - HTTPS (a CONNECT tunnel): the host and port, the bytes each way and the duration, and nothing inside the
    tunnel: seeing a path, a body or a response would need a certificate the client trusts, which this does not make.

The client names the command a request belongs to by the user name of its proxy address,
`http://<token>@127.0.0.1:<port>`, which comes back as Proxy-Authorization: the line carries it as "token".
"""
import base64
import http.client
import http.server
import json
import os
import select
import socket
import sys
import threading
import time
import urllib.parse

LOG_FILE = sys.argv[1] if len(sys.argv) > 1 else 'http-log-proxy.jsonl'
RETENTION = float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].replace('.', '', 1).isdigit() else 3600.0
CLEAN_EVERY = 60  # seconds between two cleanings
KEEP = 20000  # characters of a body or a response kept in the log
ROTATE_AT = 2_000_000  # bytes: the file starts over, so it never grows without end
HOP_BY_HOP = {
    'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
    'transfer-encoding', 'upgrade',
}
_lock = threading.Lock()


def write(entry):
    line = json.dumps(entry, separators=(',', ':')) + '\n'
    with _lock:
        try:
            if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > ROTATE_AT:
                open(LOG_FILE, 'w', encoding='utf-8').close()
            with open(LOG_FILE, 'a', encoding='utf-8') as out:
                out.write(line)
        except OSError:
            pass


def clean():
    """Removes what is older than the retention: the taps' own files, and old lines of the log."""
    cutoff = time.time() - RETENTION
    folder = os.path.dirname(os.path.abspath(LOG_FILE))
    own = os.path.basename(LOG_FILE)

    try:
        names = os.listdir(folder)
    except OSError:
        return

    for name in names:
        if name == own or not name.endswith('.jsonl'):
            continue
        path = os.path.join(folder, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass

    with _lock:
        try:
            with open(LOG_FILE, 'r', encoding='utf-8') as source:
                lines = source.readlines()
        except OSError:
            return

        kept = []
        for line in lines:
            try:
                if json.loads(line).get('ts', 0) / 1000.0 >= cutoff:
                    kept.append(line)
            except (ValueError, AttributeError):
                pass

        if len(kept) != len(lines):
            try:
                with open(LOG_FILE, 'w', encoding='utf-8') as target:
                    target.writelines(kept)
            except OSError:
                pass


def clean_forever():
    while True:
        time.sleep(CLEAN_EVERY)
        try:
            clean()
        except Exception:
            pass


def token_of(headers):
    value = headers.get('Proxy-Authorization', '')
    if value.lower().startswith('basic '):
        try:
            return base64.b64decode(value[6:]).decode('utf-8', 'replace').split(':', 1)[0]
        except Exception:
            return ''
    return ''


def text_of(data):
    try:
        return data[:KEEP].decode('utf-8')
    except UnicodeDecodeError:
        return data[:KEEP].decode('utf-8', 'replace')


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    timeout = 120

    def log_message(self, *args):
        pass

    # --- HTTPS: a tunnel; only its host is seen ---------------------------------------------------------------
    def do_CONNECT(self):
        started = time.time()
        token = token_of(self.headers)
        host, _, port = self.path.rpartition(':')
        host = host or self.path
        port = int(port) if port.isdigit() and host != self.path else 443
        up = down = 0
        code = 200
        try:
            upstream = socket.create_connection((host, port), timeout=30)
        except OSError:
            self.send_error(502, 'Bad Gateway')
            write({'via': 'proxy', 'token': token, 'ts': int(started * 1000), 'method': 'CONNECT',
                   'url': 'https://%s:%d' % (host, port), 'host': host, 'code': 502, 'codeText': 'Bad Gateway',
                   'durationMs': int((time.time() - started) * 1000), 'ok': False, 'tunnel': True})
            return

        # No Server or Date header: a client that prints the tunnel's answer (curl -i) prints just the one line
        self.send_response_only(200, 'Connection Established')
        self.end_headers()
        client = self.connection
        sockets = [client, upstream]
        try:
            while True:
                readable, _, broken = select.select(sockets, [], sockets, 60)
                if broken or not readable:
                    break
                done = False
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk:
                        done = True
                        break
                    target = upstream if source is client else client
                    target.sendall(chunk)
                    if source is client:
                        up += len(chunk)
                    else:
                        down += len(chunk)
                if done:
                    break
        except OSError:
            pass
        finally:
            upstream.close()
            self.close_connection = True
            write({'via': 'proxy', 'token': token, 'ts': int(started * 1000), 'method': 'CONNECT',
                   'url': 'https://%s:%d' % (host, port), 'host': host, 'code': code, 'codeText': 'tunnel',
                   'durationMs': int((time.time() - started) * 1000), 'ok': True, 'tunnel': True,
                   'bytes': up + down, 'bytesUp': up, 'bytesDown': down})

    # --- plain HTTP: everything is seen ------------------------------------------------------------------------
    def forward(self):
        started = time.time()
        token = token_of(self.headers)
        url = self.path
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != 'http' or not parts.hostname:
            self.send_error(400, 'Absolute http:// URL expected')
            return

        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        target = parts.path or '/'
        if parts.query:
            target += '?' + parts.query

        code, reason, answer, data, ok = 502, 'Bad Gateway', [], b'', False
        try:
            connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=60)
            connection.request(self.command, target, body=body or None, headers=headers)
            response = connection.getresponse()
            data = response.read()
            code, reason, answer, ok = response.status, response.reason, response.getheaders(), True
            connection.close()
        except Exception:
            pass

        try:
            self.send_response(code, reason)
            for key, value in answer:
                if key.lower() not in HOP_BY_HOP and key.lower() != 'content-length':
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)
        except OSError:
            pass
        self.close_connection = True

        write({'via': 'proxy', 'token': token, 'ts': int(started * 1000), 'method': self.command, 'url': url,
               'host': parts.hostname, 'code': code, 'codeText': reason,
               'durationMs': int((time.time() - started) * 1000), 'ok': ok and code < 500,
               'body': text_of(body) if body else None, 'result': text_of(data) if data else None,
               'bytes': len(data)})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = forward


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    server = Server(('127.0.0.1', 0), Handler)
    try:
        clean()  # what an earlier run left
    except Exception:
        pass
    threading.Thread(target=clean_forever, daemon=True).start()
    print('PORT %d' % server.server_address[1], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
