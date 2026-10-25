#!/usr/bin/env python3
"""Serve one folder over HTTP with byte-range support, which iPhone video playback requires."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import re


class RangeHandler(SimpleHTTPRequestHandler):
    range_remaining = None

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass  # players routinely hang up and re-request a byte range

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_head(self):
        self.range_remaining = None
        path = self.translate_path(self.path)
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', (self.headers.get('Range') or '').strip())
        if not match or not (match[1] or match[2]) or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        if match[1]:
            start, end = int(match[1]), min(int(match[2]) if match[2] else size - 1, size - 1)
        else:
            start, end = max(0, size - int(match[2])), size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        source = open(path, 'rb')
        source.seek(start)
        self.range_remaining = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self.range_remaining))
        self.end_headers()
        return source

    def copyfile(self, source, outputfile):
        if self.range_remaining is None:
            return super().copyfile(source, outputfile)
        while self.range_remaining > 0:
            chunk = source.read(min(65536, self.range_remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            self.range_remaining -= len(chunk)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('0.0.0.0', args.port), partial(RangeHandler, directory=os.path.expanduser(args.directory)))
    print(f'Serving {args.directory} on http://0.0.0.0:{args.port} with byte-range support', flush=True)
    server.serve_forever()
