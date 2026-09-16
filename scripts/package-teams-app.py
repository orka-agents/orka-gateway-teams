#!/usr/bin/env python3
"""Package a reviewed personal Teams manifest and icons. No upload, credentials, or network access."""
import argparse
import hashlib
import json
import struct
import sys
import uuid
import zipfile
import zlib
from pathlib import Path
from urllib.parse import urlsplit


def manifest_bytes(path):
    raw = path.read_bytes()
    if len(raw) > 65536:
        raise ValueError('manifest too large')
    value = json.loads(raw)
    expected = {'$schema', 'manifestVersion', 'version', 'id', 'developer', 'name', 'description', 'icons', 'accentColor', 'bots'}
    if set(value) != expected or 'REQUIRED_' in raw.decode('utf-8'):
        raise ValueError('use the completed personal manifest template')
    if value['manifestVersion'] != '1.30' or value['icons'] != {'color': 'color.png', 'outline': 'outline.png'}:
        raise ValueError('unexpected manifest version or icon paths')
    uuid.UUID(value['id'])
    if len(value['bots']) != 1 or value['bots'][0]['scopes'] != ['personal']:
        raise ValueError('exactly one personal bot is required')
    bot = value['bots'][0]
    uuid.UUID(bot['botId'])
    if set(bot) != {'botId', 'scopes', 'isNotificationOnly', 'supportsFiles', 'supportsCalling', 'supportsVideo'}:
        raise ValueError('unexpected bot settings')
    if any(bot[key] is not False for key in ('isNotificationOnly', 'supportsFiles', 'supportsCalling', 'supportsVideo')):
        raise ValueError('unsupported bot capability')
    developer = value['developer']
    if set(developer) != {'name', 'websiteUrl', 'privacyUrl', 'termsOfUseUrl'} or not developer['name'].strip():
        raise ValueError('developer metadata required')
    for key in ('websiteUrl', 'privacyUrl', 'termsOfUseUrl'):
        url = urlsplit(developer[key])
        if url.scheme != 'https' or not url.hostname or url.username is not None or url.password is not None:
            raise ValueError('developer links must be credential-free HTTPS URLs')
    return raw


def png_bytes(path, size, outline=False):
    data = path.read_bytes()
    # Header checks are not a full image decoder or a visual artwork review.
    if len(data) < 33 or len(data) > 1048576 or data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('bounded PNG required')
    if data[8:16] != b'\x00\x00\x00\x0dIHDR' or zlib.crc32(data[12:29]) != struct.unpack('>I', data[29:33])[0]:
        raise ValueError('invalid PNG header')
    width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data[16:29])
    if (width, height) != (size, size) or depth != 8 or color not in (2, 6) or compression or filtering or interlace:
        raise ValueError('use non-interlaced 8-bit RGB/RGBA icons of the required dimensions')
    if outline and color != 6:
        raise ValueError('outline icon requires an RGBA transparency channel')
    return data


class QuietArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # Defer failures to the fixed diagnostic; ordinary --help still exits successfully.
        raise argparse.ArgumentError(None, 'invalid command-line arguments')


def main():
    parser = QuietArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--color', required=True, type=Path)
    parser.add_argument('--outline', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    files = {'manifest.json': manifest_bytes(args.manifest), 'color.png': png_bytes(args.color, 192),
             'outline.png': png_bytes(args.outline, 32, outline=True)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    created_output = False
    try:
        with args.output.open('xb') as output:
            created_output = True
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name, data in files.items():
                    archive.writestr(name, data)
        with zipfile.ZipFile(args.output) as archive:
            if archive.namelist() != list(files) or archive.testzip() is not None:
                raise ValueError('archive verification failed')
    except BaseException:
        # Clean up this invocation's output on Ctrl-C too, then preserve the interruption.
        if created_output:
            args.output.unlink(missing_ok=True)
        raise
    print(json.dumps({'packaged': True, 'bytes': args.output.stat().st_size,
                      'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'files': list(files)}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not echo operator paths, manifest values, or arbitrary parser errors.
        print(json.dumps({'packaged': False, 'reason': 'invalid input or output unavailable'}), file=sys.stderr)
        sys.exit(2 if isinstance(error, argparse.ArgumentError) else 1)
