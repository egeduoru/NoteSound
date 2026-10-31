"""Package the tested repository and ready site; never include local credentials."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
ROOT_FILES = [
    ".gitignore", ".dockerignore", ".env.example", "index.html", "package.json",
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vite.config.ts",
    "vitest.config.ts", "eslint.config.js", "render.yaml", "Start NoteSound.cmd",
    "README.md", "DEPLOYMENT.md", "MINI_APP_RELEASE.md", "ARCHITECTURE.md",
    "BACKGROUND_AUDIO.md", "CHANGES_RU.md", "KNOWN_LIMITATIONS.md", "MUSIC_SOURCES.md",
    "VERIFICATION.md", "WAVE_ENGINE.md", "VK_REPORT.md",
]
FORBIDDEN = {".git", "node_modules", ".qa", ".local", ".pnpm-store", "outputs", "coverage"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked(path: Path) -> tuple[str, bytes]:
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
        raise ValueError(f"Not a regular workspace file: {path.name}")
    relative = path.relative_to(ROOT).as_posix()
    if any(part in FORBIDDEN for part in path.relative_to(ROOT).parts):
        raise ValueError(f"Private directory in package: {relative}")
    if (
        (path.name.startswith(".env") and path.name != ".env.example")
        or relative == "server/licenses.json"
        or path.suffix in {".log", ".tsbuildinfo", ".pyc"}
        or "__pycache__" in path.parts
    ):
        raise ValueError(f"Private/generated file in package: {relative}")
    data = path.read_bytes()
    if path.suffix in {".ts", ".tsx", ".js", ".mjs", ".html", ".json", ".md", ".yml"}:
        text = data.decode("utf-8")
        if re.search(r"AIza[0-9A-Za-z_-]{35}", text) or re.search(r"\b\d{8,12}:AA[\w-]{30,}\b", text):
            raise ValueError(f"Possible real credential in {relative}; review before packaging")
    return relative, data


def write_zip(path: Path, entries: dict[str, bytes]) -> None:
    with ZipFile(path, "w", ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(entries.items()):
            archive.writestr(name, data)
    with ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError(f"Archive CRC verification failed: {path.name}")
        if set(archive.namelist()) != set(entries):
            raise ValueError(f"Archive inventory mismatch: {path.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True, help="User-facing release date YYYY-MM-DD")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        raise ValueError("Invalid release date")
    output = ROOT / "outputs" / "releases" / f"NoteSound-MiniApp-{args.date}"
    output.mkdir(parents=True, exist_ok=True)
    paths = [ROOT / name for name in ROOT_FILES]
    paths += [ROOT / ".github" / "workflows" / "deploy.yml"]
    for folder in ["src", "public", "server", "scripts"]:
        paths += [p for p in (ROOT / folder).rglob("*") if p.is_file()
                  and "__pycache__" not in p.parts
                  and not p.name.endswith((".pyc", ".log", ".tsbuildinfo"))
                  and not (p.name.startswith(".env") and p.name != ".env.example")
                  and p.relative_to(ROOT).as_posix() != "server/licenses.json"]
    paths += sorted((ROOT / "docs").glob("*.md"))
    source = dict(checked(path) for path in sorted(set(paths)))
    ready = {}
    for path in sorted((ROOT / "dist").rglob("*")):
        if path.is_file():
            _, data = checked(path)
            ready[path.relative_to(ROOT / "dist").as_posix()] = data
    for name in ["index.html", "config.js", "sw.js", "mascot/pink-bunny-sticker.png"]:
        if name not in ready:
            raise ValueError(f"Ready site missing {name}; build and configure it first")
    config = ready["config.js"].decode("utf-8")
    if "https://notesound-hitmoz-test.onrender.com" not in config:
        raise ValueError("Ready site must point at the selected Render server")
    groups = {"01-base": {}, "02-app": {}, "03-tests": {}}
    for name, data in source.items():
        if re.search(r"\.test\.(?:ts|tsx|mjs)$", name):
            group = "03-tests"
        elif name.startswith("src/"):
            group = "02-app"
        else:
            group = "01-base"
        groups[group][name] = data
    if any(len(files) > 95 for files in groups.values()):
        raise ValueError("A browser upload batch is too large")
    site_path = output / "NoteSound-site-ready.zip"
    source_path = output / "NoteSound-GitHub-source.zip"
    write_zip(site_path, ready)
    write_zip(source_path, source)
    inventory = {
        "date": args.date,
        "miniAppUrl": "https://egeduoru.github.io/NoteSound/",
        "discoveryApiUrl": "https://notesound-hitmoz-test.onrender.com",
        "published": False,
        "sourceFiles": len(source),
        "siteFiles": len(ready),
        "batches": {name: len(files) for name, files in groups.items()},
        "sourceSha256": {name: digest(data) for name, data in sorted(source.items())},
        "siteSha256": {name: digest(data) for name, data in sorted(ready.items())},
    }
    guide = source["MINI_APP_RELEASE.md"]
    bundle = {f"{group}/{name}": data for group, files in groups.items() for name, data in files.items()}
    bundle["START-HERE.md"] = guide
    bundle["NoteSound-site-ready.zip"] = site_path.read_bytes()
    bundle["release-info.json"] = json.dumps(inventory, ensure_ascii=False, indent=2).encode("utf-8")
    main_path = output / "NoteSound-MiniApp-upload.zip"
    write_zip(main_path, bundle)
    (output / "START-HERE.md").write_bytes(guide)
    (output / "release-info.json").write_bytes(bundle["release-info.json"])
    archives = [main_path, source_path, site_path]
    (output / "SHA256SUMS.txt").write_text("".join(f"{digest(p.read_bytes())}  {p.name}\n" for p in archives), encoding="utf-8")
    print(json.dumps({"output": str(output), "sourceFiles": len(source), "siteFiles": len(ready),
                      "batches": inventory["batches"], "archives": [{"name": p.name, "bytes": p.stat().st_size} for p in archives]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
