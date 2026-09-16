"""Synthetic local I/O failures for the optional packaging gate; no private inputs."""
import json
import runpy
import sys
from pathlib import Path
from unittest.mock import patch
import zipfile

script, mode, *args = sys.argv[1:]
output = Path(args[args.index('--output') + 1])
main = runpy.run_path(script, run_name='package_fixture')['main']
sys.argv = [script, *args]
method = 'writestr' if mode.endswith('write') else 'testzip'
if mode.startswith('interrupt-'):
    options = {'side_effect': KeyboardInterrupt()}
else:
    options = {'side_effect': OSError('synthetic write failure')} if mode == 'write' else {'return_value': 'invalid'}
with patch.object(zipfile.ZipFile, method, **options):
    try:
        main()
    except (OSError, ValueError, KeyboardInterrupt) as error:
        print(json.dumps({'raised': True, 'outputExists': output.exists(), 'interrupted': isinstance(error, KeyboardInterrupt)}))
    else:
        raise SystemExit(1)
