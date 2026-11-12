import argparse
import csv
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


PATTERN = r'/home/[A-Za-z0-9_-]+/|~/work/'
PATHS = ['docs', 'README.md', 'RESEARCH.md', 'AGENTS.md', '.agents',
         ':!.agents/skills/yomiyasu', ':!docs/experiments/S8/raw/**']


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def pointer_value(value, pointer):
    if not pointer.startswith('/') or re.search(r'~(?![01])', pointer):
        raise ValueError('invalid JSON pointer')
    for token in pointer[1:].split('/'):
        token = token.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            if not re.fullmatch(r'0|[1-9][0-9]*', token):
                raise ValueError('invalid array index')
            value = value[int(token)]
        else:
            value = value[token]
    return value


def check(root):
    matches = subprocess.run(['git', '-C', str(root), 'grep', '-lzE', PATTERN,
                              '--', *PATHS], capture_output=True, check=False)
    if matches.returncode not in (0, 1):
        raise ValueError('git grep failed: ' + matches.stderr.decode())
    names = matches.stdout.decode().split('\0')[:-1]
    texts = {name: (root / name).read_text(encoding='utf-8') for name in names}
    seen = set()
    allowlist = root / '.github/document-path-allowlist.tsv'
    with allowlist.open(encoding='utf-8', newline='') as stream:
        for row in csv.reader(stream, delimiter='\t'):
            if not row or row[0].startswith('#'):
                continue
            if len(row) != 4:
                raise ValueError('exception needs path, pointer, sha256 and reason')
            name, pointer, digest, reason = row
            path = PurePosixPath(name)
            if (path.is_absolute() or '..' in path.parts or str(path) != name
                    or path.suffix != '.json' or not reason.strip()
                    or not re.fullmatch(r'[0-9a-f]{64}', digest)):
                raise ValueError('invalid exception: ' + name)
            key = (name, pointer)
            if key in seen:
                raise ValueError('duplicate exception: ' + name + pointer)
            if name not in texts or (root / name).is_symlink():
                raise ValueError('unused exception: ' + name + pointer)
            value = pointer_value(json.loads((root / name).read_text(encoding='utf-8'),
                                             object_pairs_hook=unique_object), pointer)
            if not isinstance(value, str) or not re.search(PATTERN, value):
                raise ValueError('unused exception: ' + name + pointer)
            if hashlib.sha256(value.encode()).hexdigest() != digest:
                raise ValueError('quoted value hash mismatch: ' + name + pointer)
            quoted = json.dumps(value, ensure_ascii=False)
            if texts[name].count(quoted) != 1:
                raise ValueError('ambiguous quoted value: ' + name + pointer)
            texts[name] = texts[name].replace(quoted, '"allowed-verbatim-value"', 1)
            seen.add(key)
    errors = 0
    for name, content in texts.items():
        for number, line in enumerate(content.splitlines(), 1):
            if re.search(PATTERN, line):
                print(f'{name}:{number}: 文書に個人環境のパスがあります。')
                errors += 1
    print(f'path_files={len(names)} quoted_exceptions={len(seen)} errors={errors}')
    return int(errors != 0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    try:
        raise SystemExit(check(args.root))
    except (OSError, UnicodeError, ValueError, KeyError, IndexError, TypeError) as error:
        print(f'文書パスの検査に失敗しました: {error}')
        raise SystemExit(1)
