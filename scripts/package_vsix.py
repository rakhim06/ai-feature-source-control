#!/usr/bin/env python3
"""Compatibility entry point; use the official VSIX packager installed by npm ci."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
npm = shutil.which('npm')
if npm is None:
    sys.exit('Node.js and npm are required. Run npm ci before packaging.')
subprocess.run([npm, 'run', 'package', '--', *sys.argv[1:]], cwd=ROOT, check=True)
