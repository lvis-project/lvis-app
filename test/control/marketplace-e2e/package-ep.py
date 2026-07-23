from __future__ import annotations

import os
import stat
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path("/candidate/ep").resolve()
output = Path("/bundle/lvis-plugin-ep.zip")
members = [root / "plugin.json", root / "dist", root / "skills"]

with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
    for member in members:
        paths = [member] if member.is_file() else sorted(member.rglob("*"))
        for path in paths:
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(root).as_posix()
            info = ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED)

os.chmod(output, 0o444)
