"""Static dev server for the site: http.server, minus caching.

Plain `python -m http.server` validates caches by Last-Modified, which has
one-second resolution. A request that lands while an editor is mid-save gets an
empty file, and every later 304 within that second pins the browser to it.
Here every response is a full, uncached 200.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    # keep-alive: HTTP/1.0 opens a socket per file, and a Stable clip fetches
    # hundreds; Windows answers the burst with ERR_NO_BUFFER_SPACE
    protocol_version = "HTTP/1.1"

    def send_head(self):
        # drop conditional headers so the server never answers 304
        for h in ("If-Modified-Since", "If-None-Match"):
            del self.headers[h]
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(ThreadingHTTPServer):
    # default is 5: a Stable clip requests ~90 subject textures almost at
    # once, and most got refused before Python's accept loop could keep up
    request_queue_size = 128


port = int(sys.argv[1]) if len(sys.argv) > 1 else 4175
Server(("127.0.0.1", port), NoCache).serve_forever()
