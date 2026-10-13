"""Offline optional release-kit tests; no live configuration or dependencies."""
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / 'scripts/build-teams-app-kit.py'
VERSION = '0.1.0'
GATEWAY = 'ghcr.io/example/orka-gateway-teams@sha256:' + '1' * 64
SETUP = 'ghcr.io/example/orka-gateway-teams-setup@sha256:' + '2' * 64
BOT = '22222222-2222-4222-8222-222222222222'


class KitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.output = self.directory / 'kit.tar.gz'
        self.addCleanup(self.temp.cleanup)

    def build(self, version=VERSION, gateway=GATEWAY, setup=SETUP):
        return subprocess.run(['python3', str(BUILDER), '--version', version,
                               '--gateway-image', gateway, '--setup-image', setup,
                               '--repository', 'example/orka-gateway-teams', '--output', str(self.output)],
                              capture_output=True, text=True, timeout=15)

    def contents(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.output) as archive:
            self.assertTrue(all(member.isfile() for member in archive.getmembers()))
            prefix = 'orka-teams-app-kit-0.1.0/'
            return {member.name.removeprefix(prefix): archive.extractfile(member).read()
                    for member in archive.getmembers()}

    def test_archive_allowlist_and_release_metadata(self):
        files = self.contents()
        self.assertEqual(set(files), {'manifest.template.json', 'manifest.shared-rooms.template.json',
                                     'package-teams-app.py', 'validate-teams-app.mjs', 'color.png', 'outline.png',
                                     'README.md', 'image-digests.txt', 'LICENSE'})
        readme = files['README.md'].decode()
        self.assertIn(GATEWAY, readme)
        self.assertIn(SETUP, readme)
        self.assertIn('https://github.com/example/orka-gateway-teams/blob/v0.1.0/docs/aca-deployment.md', readme)
        self.assertNotIn('@@', readme)
        self.assertIn('az acr import', readme)
        self.assertIn('orka/issues/736', readme)
        self.assertIn('only when you trust the entire membership', readme)
        self.assertIn('If you do not trust every member, do not create its Binding', readme)
        self.assertEqual(files['image-digests.txt'].decode(), f'gateway={GATEWAY}\nsetup={SETUP}\n')
        for name in ['manifest.template.json', 'manifest.shared-rooms.template.json']:
            self.assertEqual(files[name], (ROOT / 'examples/teams-app' / name).read_bytes())
            manifest = json.loads(files[name])
            self.assertEqual(manifest['bots'][0]['botId'], 'REQUIRED_BOT_OAUTH_CLIENT_GUID')
        self.assertEqual(files['package-teams-app.py'], (ROOT / 'scripts/package-teams-app.py').read_bytes())
        self.assertEqual(files['validate-teams-app.mjs'], (ROOT / 'scripts/validate-teams-app.mjs').read_bytes())

    def test_icons_decode_with_white_transparent_outline(self):
        files = self.contents()
        for name, size in [('color.png', 192), ('outline.png', 32)]:
            data = files[name]
            self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
            chunks = []
            offset = 8
            while offset < len(data):
                length = struct.unpack('>I', data[offset:offset + 4])[0]
                kind = data[offset + 4:offset + 8]
                value = data[offset + 8:offset + 8 + length]
                checksum = struct.unpack('>I', data[offset + 8 + length:offset + 12 + length])[0]
                self.assertEqual(zlib.crc32(kind + value), checksum)
                chunks.append((kind, value))
                offset += length + 12
            self.assertEqual([kind for kind, _ in chunks], [b'IHDR', b'IDAT', b'IEND'])
            self.assertEqual(struct.unpack('>IIBBBBB', chunks[0][1]), (size, size, 8, 6, 0, 0, 0))
            rows = zlib.decompress(chunks[1][1])
            self.assertEqual(len(rows), size * (1 + size * 4))
            pixels = []
            for y in range(size):
                row = rows[y * (1 + size * 4):(y + 1) * (1 + size * 4)]
                self.assertEqual(row[0], 0)
                pixels.extend(tuple(row[x:x + 4]) for x in range(1, len(row), 4))
            if name == 'outline.png':
                self.assertEqual({p for p in pixels if p[3]}, {(255, 255, 255, 255)})
                self.assertIn(0, {p[3] for p in pixels})
            else:
                self.assertEqual({p[3] for p in pixels}, {255})

    def test_extracted_kit_packages_both_profiles_preserving_bytes(self):
        files = self.contents()
        for name, data in files.items():
            (self.directory / name).write_bytes(data)
        for profile, template in [('personal', 'manifest.template.json'), ('shared-rooms', 'manifest.shared-rooms.template.json')]:
            manifest = json.loads(files[template])
            manifest['id'] = '11111111-1111-4111-8111-111111111111'
            manifest['bots'][0]['botId'] = BOT
            manifest['developer'] = {'name': 'Example', 'websiteUrl': 'https://example.invalid/',
                                     'privacyUrl': 'https://example.invalid/privacy', 'termsOfUseUrl': 'https://example.invalid/terms'}
            raw = json.dumps(manifest, indent=2).encode()
            path = self.directory / f'{profile}.json'
            path.write_bytes(raw)
            output = self.directory / f'{profile}.zip'
            result = subprocess.run(['python3', str(self.directory / 'package-teams-app.py'), '--bot-id', BOT,
                                     '--profile', profile, '--manifest', str(path), '--color', str(self.directory / 'color.png'),
                                     '--outline', str(self.directory / 'outline.png'), '--output', str(output)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), ['manifest.json', 'color.png', 'outline.png'])
                self.assertEqual(archive.read('manifest.json'), raw)
                self.assertIsNone(archive.testzip())

    def test_invalid_version_and_digest_refused_before_output(self):
        for version in ['../../escape', '0.1.0;echo', 'v01.0.0', 'v0.1', '0.1.0\n', 'v0.2.0-rc.1', '0.1.0-' + 'x' * 100]:
            with self.subTest(version=version):
                self.assertNotEqual(self.build(version=version).returncode, 0)
                self.assertFalse(self.output.exists())
        for image in ['ghcr.io/example/gateway:latest', GATEWAY + '\n', GATEWAY.replace('1' * 64, 'a' * 63),
                      'https://' + GATEWAY, 'ghcr.io/user:secret/example@gateway']:
            for key in ['gateway', 'setup']:
                with self.subTest(key=key, image=image):
                    self.assertNotEqual(self.build(**{key: image}).returncode, 0)
                    self.assertFalse(self.output.exists())

    def test_existing_output_never_overwritten(self):
        self.output.write_bytes(b'existing')
        self.assertNotEqual(self.build().returncode, 0)
        self.assertEqual(self.output.read_bytes(), b'existing')

    def test_failed_archive_write_removes_only_owned_output(self):
        spec = importlib.util.spec_from_file_location('kit_builder', BUILDER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        from unittest.mock import patch
        with patch.object(tarfile.TarFile, 'addfile', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                module.build_kit(VERSION, GATEWAY, SETUP, 'example/orka-gateway-teams', self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
