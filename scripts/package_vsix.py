#!/usr/bin/env python3
"""Build a VSIX with Python's standard library (no npm registry needed)."""
from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
pkg = json.loads((ROOT / 'package.json').read_text())
OUT = ROOT / f"{pkg['name']}-{pkg['version']}.vsix"

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Language="en-US" Publisher="{escape(pkg['publisher'])}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(', '.join(pkg['keywords']))}</Tags>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="vscode.git" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
'''

content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".xml" ContentType="text/xml" />
</Types>
'''

with ZipFile(OUT, 'w', compression=ZIP_DEFLATED, compresslevel=9) as bundle:
    bundle.writestr('[Content_Types].xml', content_types)
    bundle.writestr('extension.vsixmanifest', manifest)
    for rel in ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']:
        bundle.write(ROOT / rel, f'extension/{rel}')
    for folder in ['src', 'media']:
        for file in sorted((ROOT / folder).iterdir()):
            if file.is_file():
                bundle.write(file, f'extension/{folder}/{file.name}')

print(f'Created {OUT} ({OUT.stat().st_size} bytes)')
