#!/usr/bin/env python3
"""
Inline the client CSS and page-specific JS into assembled HTML assets.
Keep it tiny and purpose-built for the current project layout.
"""

from __future__ import annotations

import base64
import hashlib
import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"
RECEIVE_HTML_IN = ASSETS_DIR / "client-receive.html"
CSS_FILE = ASSETS_DIR / "client.css"
RECEIVE_HTML_OUT = ASSETS_DIR / "client-receive_assembled.html"
SEND_PAGES = (
    (ASSETS_DIR / "client.html", ASSETS_DIR / "client_assembled.html"),
    (ASSETS_DIR / "a.html", ASSETS_DIR / "a_assembled.html"),
    (ASSETS_DIR / "b.html", ASSETS_DIR / "b_assembled.html"),
)

CSS_TAG = '<link rel="stylesheet" href="client.css">'
QR_TAG = '<script src="qrcode.js"></script>'
CLIENT_SHARED_TAG = '<script src="client-shared.js"></script>'
CLIENT_SEND_TAG = '<script src="client-send.js"></script>'
CLIENT_RECEIVE_TAG = '<script src="client-receive.js"></script>'
CLIENT_TAG = '<script src="client.js"></script>'
STYLE_RE = re.compile(r"<style>(.*?)</style>", re.DOTALL)
SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.DOTALL)


def read_text(path: Path) -> str:
    if not path.is_file():
        sys.exit(f"missing required file: {path}")
    return path.read_text(encoding="utf-8")


def hash_block_sha256(content: str) -> str:
    digest = hashlib.sha256(content.encode("utf-8")).digest()
    return "sha256-" + base64.b64encode(digest).decode("ascii")


def prefer_min_js(stem: str) -> Path:
    """
    Return the minified JS when it exists and is at least as new as the
    unminified source; otherwise use the regular version to avoid bundling stale
    code.
    """
    min_path = ASSETS_DIR / f"{stem}.min.js"
    src_path = ASSETS_DIR / f"{stem}.js"
    if min_path.is_file() and (
        not src_path.is_file() or
        min_path.stat().st_mtime >= src_path.stat().st_mtime
    ):
        return min_path
    return src_path


def build_page(
    html_in: Path,
    html_out: Path,
    include_qr: bool,
    page_script_tag: str,
    page_script: str,
) -> str:
    html = read_text(html_in)
    css = read_text(CSS_FILE)
    client_shared = read_text(prefer_min_js("client-shared"))
    client = read_text(prefer_min_js("client"))

    expected_tags = [CSS_TAG, CLIENT_SHARED_TAG, page_script_tag, CLIENT_TAG]
    if include_qr:
        expected_tags.insert(1, QR_TAG)

    for tag in expected_tags:
        if tag not in html:
            sys.exit(f"expected '{tag}' in {html_in}")

    html = html.replace(CSS_TAG, f"<style>\n{css.rstrip()}\n</style>", 1)

    bundle_parts = ["<script>(function(){"]
    if include_qr:
        qr = read_text(prefer_min_js("qrcode"))
        bundle_parts.append(qr.rstrip())
        bundle_parts.append(
            'if (typeof globalThis !== "undefined" && '
            'typeof QRCode !== "undefined") { globalThis.QRCode = QRCode; }'
        )
    bundle_parts.extend([
        client_shared.rstrip(),
        page_script.rstrip(),
        client.rstrip(),
        "})();</script>",
    ])
    bundle = "\n".join(bundle_parts)

    if include_qr:
        html = html.replace(QR_TAG, bundle, 1)
    else:
        html = html.replace(CLIENT_SHARED_TAG, bundle, 1)

    html = html.replace(CLIENT_SHARED_TAG, "", 1)
    html = html.replace(page_script_tag, "", 1)
    html = html.replace(CLIENT_TAG, "", 1)
    if include_qr:
        html = html.replace(QR_TAG, "", 1)

    html_out.write_text(html, encoding="utf-8")
    print(f"Wrote {html_out}")
    return html


def write_csp_header(html_pages: tuple[str, ...], output_path: Path) -> None:
    script_hashes = sorted({
        hash_block_sha256(match.group(1))
        for html in html_pages
        for match in SCRIPT_RE.finditer(html)
    })
    style_hashes = sorted({
        hash_block_sha256(match.group(1))
        for html in html_pages
        for match in STYLE_RE.finditer(html)
    })

    output_path.write_text(
        "\n".join([
            "#ifndef ADNIHILUM_CSP_HASHES_H",
            "#define ADNIHILUM_CSP_HASHES_H",
            "",
            '#define ADN_CSP_SCRIPT_HASHES "' +
            " ".join(f"'{item}'" for item in script_hashes) + '"',
            '#define ADN_CSP_STYLE_HASHES "' +
            " ".join(f"'{item}'" for item in style_hashes) + '"',
            "",
            "#endif",
            "",
        ]),
        encoding="utf-8",
    )
    print(f"Wrote {output_path}")


def main() -> None:
    send_script = read_text(prefer_min_js("client-send"))
    send_htmls = tuple(
        build_page(
            html_in=html_in,
            html_out=html_out,
            include_qr=True,
            page_script_tag=CLIENT_SEND_TAG,
            page_script=send_script,
        )
        for html_in, html_out in SEND_PAGES
    )
    receive_html = build_page(
        html_in=RECEIVE_HTML_IN,
        html_out=RECEIVE_HTML_OUT,
        include_qr=False,
        page_script_tag=CLIENT_RECEIVE_TAG,
        page_script=read_text(prefer_min_js("client-receive")),
    )
    if len(sys.argv) == 2:
        write_csp_header(send_htmls + (receive_html,), Path(sys.argv[1]))
    elif len(sys.argv) != 1:
        sys.exit("usage: assemble_html.py [csp_header_out]")


if __name__ == "__main__":
    main()
