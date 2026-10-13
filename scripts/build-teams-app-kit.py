#!/usr/bin/env python3
"""Build a self-contained release kit from public source inputs; no network or credentials."""
import argparse
import io
from pathlib import Path
import re
import struct
import tarfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r'v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?')
IMAGE = re.compile(r'ghcr\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}')
REPOSITORY = re.compile(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+')


def release_version(value):
    if len(value) > 64 or not VERSION.fullmatch(value):
        raise ValueError('expected bounded release version, for example v0.1.0')
    return value.removeprefix('v')


def validate_images(gateway, setup):
    if any(len(image) > 256 or not IMAGE.fullmatch(image) for image in (gateway, setup)):
        raise ValueError('expected GHCR image references pinned by sha256 digest')


def icon_png(size, outline=False):
    # Original generic ring artwork, not an official logo. PNGs are generated only in the archive.
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter: none
        for x in range(size):
            radius_squared = (x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2
            ring = (size * 0.23) ** 2 <= radius_squared <= (size * 0.36) ** 2
            pixel = (255, 255, 255, 255) if ring else ((255, 255, 255, 0) if outline else (27, 45, 64, 255))
            rows.extend(pixel)
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def build_kit(version, gateway, setup, repository, output):
    version = release_version(version)
    validate_images(gateway, setup)
    if len(repository) > 200 or not REPOSITORY.fullmatch(repository):
        raise ValueError('expected GitHub owner/repository')
    files = {
        name: (ROOT / 'examples/teams-app' / name).read_bytes()
        for name in ('manifest.template.json', 'manifest.shared-rooms.template.json')
    }
    for name in ('package-teams-app.py', 'validate-teams-app.mjs'):
        files[name] = (ROOT / 'scripts' / name).read_bytes()
    files['color.png'] = icon_png(192)
    files['outline.png'] = icon_png(32, outline=True)
    readme = (ROOT / 'examples/teams-app/README.kit.md').read_text(encoding='utf-8')
    for token, value in {'@@VERSION@@': version, '@@GATEWAY_IMAGE@@': gateway,
                         '@@SETUP_IMAGE@@': setup, '@@REPOSITORY@@': repository}.items():
        readme = readme.replace(token, value)
    files['README.md'] = readme.encode('utf-8')
    files['image-digests.txt'] = f'gateway={gateway}\nsetup={setup}\n'.encode()
    files['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with output.open('xb') as stream:
            created = True
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                for name, data in files.items():
                    member = tarfile.TarInfo(f'orka-teams-app-kit-{version}/{name}')
                    member.size = len(data)
                    member.mode = 0o644
                    archive.addfile(member, io.BytesIO(data))
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--gateway-image', required=True)
    parser.add_argument('--setup-image', required=True)
    parser.add_argument('--repository', default='orka-agents/orka-gateway-teams')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    build_kit(args.version, args.gateway_image, args.setup_image, args.repository, args.output)
    print('Teams app kit built')


if __name__ == '__main__':
    main()
