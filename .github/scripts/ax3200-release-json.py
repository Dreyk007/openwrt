#!/usr/bin/env python3
"""Write release.json, the release information that the firmware update check on the
router (luci-app-fwupdate) downloads from the latest GitHub release.

The list of releases is carried over from the release.json of the previous release, with
the new release in front, so that a router several releases behind sees the changes and
the upgrade method of every release it skips.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

KEEP_RELEASES = 20
TAG_RE = re.compile(r'^v(\d+)\.(\d+)\.(\d+)-ax3200-r(\d+)$')


def git_changes(prev_tag):
    if not prev_tag:
        return []
    out = subprocess.run(['git', 'log', '--first-parent', '--no-show-signature',
                          '--format=%H%x09%s', f'{prev_tag}..HEAD'],
                         check=True, capture_output=True, text=True).stdout
    return [dict(zip(('commit', 'subject'), line.split('\t', 1)))
            for line in out.splitlines() if '\t' in line]


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--tag', required=True)
    p.add_argument('--commit', required=True)
    p.add_argument('--repo-url', required=True, help='https://github.com/<owner>/<repo>')
    p.add_argument('--image', required=True, help='the sysupgrade image of this release')
    p.add_argument('--prev-tag', default='')
    p.add_argument('--prev-json', default='', help='release.json of the previous release, if any')
    p.add_argument('--upgrade', choices=('auto', 'reset', 'manual'), default='auto')
    p.add_argument('--note-en', default='')
    p.add_argument('--note-ru', default='')
    p.add_argument('--upgrade-url', default='')
    p.add_argument('--date', default='', help='ISO 8601, default: now')
    a = p.parse_args()

    m = TAG_RE.match(a.tag)
    if not m:
        sys.exit(f'unexpected tag {a.tag!r}')
    if a.upgrade != 'auto' and not (a.note_en.strip() and a.note_ru.strip()):
        sys.exit(f'upgrade={a.upgrade} needs an English and a Russian note')

    date = a.date or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    name = os.path.basename(a.image)

    entry = {
        'tag': a.tag,
        'date': date,
        'url': f'{a.repo_url}/releases/tag/{a.tag}',
        'upgrade': a.upgrade,
        'changes': git_changes(a.prev_tag),
    }
    if a.upgrade != 'auto':
        entry['note'] = {'en': a.note_en.strip(), 'ru': a.note_ru.strip()}
        if a.upgrade_url:
            entry['note_url'] = a.upgrade_url

    releases = [entry]
    if a.prev_json and os.path.exists(a.prev_json):
        with open(a.prev_json) as f:
            prev = json.load(f)
        releases += [r for r in prev.get('releases', []) if r.get('tag') != a.tag]

    info = {
        'schema': 1,
        'tag': a.tag,
        'version': '.'.join(m.group(1, 2, 3)),
        'number': int(m.group(4)),
        'date': date,
        'commit': a.commit,
        'url': entry['url'],
        'sysupgrade': {
            'file': name,
            'url': f'{a.repo_url}/releases/download/{a.tag}/{name}',
            'sha256': sha256(a.image),
            'size': os.path.getsize(a.image),
        },
        'releases': releases[:KEEP_RELEASES],
    }
    json.dump(info, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
