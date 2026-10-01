"""Local web server for the paper-trading desk. Listens on 127.0.0.1 only."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .paper import OrderError, PaperDesk

PAGE = Path(__file__).with_name("web") / "paper.html"


def make_handler(desk: PaperDesk, port: int):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "kalshi-paper/0.1"

        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload) -> None:
            self._send(status, json.dumps(payload).encode(), "application/json")

        def _host_ok(self) -> bool:
            # Refuse other sites that resolve their hostname to 127.0.0.1.
            if self.headers.get("Host") in allowed_hosts:
                return True
            self._json(403, {"error": "Open the desk at http://localhost:%d" % port})
            return False

        def do_GET(self):
            if not self._host_ok():
                return
            if self.path in ("/", "/index.html"):
                self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            elif self.path == "/api/state":
                self._json(200, desk.view())
            else:
                self._json(404, {"error": "Not found"})

        def do_POST(self):
            if not self._host_ok():
                return
            # Requiring JSON forces a CORS preflight, which this server never
            # answers, so other web pages can't place orders on your behalf.
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                self._json(415, {"error": "Send JSON"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(min(length, 10_000)) or b"{}")
                if self.path == "/api/order":
                    position = desk.place_order(str(body.get("side", "")).lower(), body.get("contracts"))
                    self._json(200, {"position": position})
                elif self.path == "/api/bots":
                    desk.set_bot(str(body.get("key")), body.get("enabled"), body.get("contracts"))
                    self._json(200, {"ok": True})
                elif self.path == "/api/reset":
                    desk.reset(float(body.get("balance", 1000)))
                    self._json(200, {"ok": True})
                else:
                    self._json(404, {"error": "Not found"})
            except OrderError as e:
                self._json(400, {"error": str(e)})
            except (ValueError, TypeError) as e:
                self._json(400, {"error": f"Bad request: {e}"})

    return Handler


def serve(desk: PaperDesk, port: int = 8765, interval: float = 2.0) -> None:
    stop = threading.Event()
    loop = threading.Thread(target=desk.run_forever, kwargs={"interval": interval, "stop": stop}, daemon=True)
    loop.start()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(desk, port))
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()
