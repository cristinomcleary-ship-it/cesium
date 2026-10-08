"""Read-only design-reference inventory; never evaluates production acceptance.

Writes only new reference audit/feature-map artifacts under output/. It does not
run the prototype, change project data, start services, or mark requirements met.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PACKAGE = ROOT / 'tmp/design-reference-01-20261008/Cesium_Codex_Design_Kit'
MODULES = [('overview', '项目驾驶舱'), ('plan', '计划进度'), ('field', '现场管控'),
           ('inspection', '巡检监测'), ('resources', '资源保障'), ('documents', '资料协同')]
REQUIRED = ['00_CODEX_START.md', 'DESIGN_SPEC.md', 'design/PAGE_SPEC.md',
            'engineering/TECHNICAL_ROUTE.md', 'engineering/IMPLEMENTATION_ACCEPTANCE.md',
            'design/design-tokens.json', 'design/PAGE_CONTRACTS.json',
            'engineering/scene-adapter.contract.ts', 'motion/platform-tour.mp4',
            'motion/chapters.json', 'design/concepts/scene-target.png', 'MANIFEST.json']
# Suggested UI actions only. These mappings are not claims that an API/UI works.
# Commands are existing contract names; query/scene/player actions are explicit.
MAPPINGS = [
    ('project', ['metrics.query', 'metric.drilldown']),
    ('mine', ['todos.query', 'source.open']),
    ('project', ['tasks.query', 'task.open']),
    ('project', ['readiness.query', 'need.update']),
    ('project', ['search.query', 'selection.select', 'camera.locate']),
    ('project', ['scene.theme', 'selection.select', 'camera.home']),
    ('project', ['trends.query', 'action.create']),
    ('project', ['view.switch', 'bookmark.create', 'report.preview']),
    ('tasks', ['wbs.create', 'wbs.update', 'task.update']),
    ('baselines', ['baseline.create', 'baseline.approve']),
    ('week', ['commitment.create', 'commitment.publish']),
    ('tasks', ['task.update', 'readiness.query']),
    ('tasks', ['task.publish', 'task.start', 'task.request-completion', 'task.confirm-completion']),
    ('tasks', ['progress.create', 'progress.revise', 'progress.submit', 'progress.return', 'progress.confirm']),
    ('baselines', ['task.forecast', 'task.update', 'change.create']),
    ('gantt', ['metrics.query', 'metric.drilldown', 'report.freeze']),
    ('today', ['check.create', 'check.record', 'check.confirm']),
    ('today', ['dailyLog.create', 'progress.create', 'progress.revise']),
    ('checks', ['check.create', 'check.record', 'check.confirm']),
    ('issues', ['issue.create', 'issue.assign', 'issue.submit', 'issue.review']),
    ('issues', ['issue.create', 'issue.assign', 'issue.dismiss']),
    ('spatial', ['geometry.new', 'geometry.edit', 'geometry.undo', 'geometry.redo', 'geometry.save']),
    ('issues', ['issue.start', 'issue.submit', 'issue.review', 'issue.history']),
    ('coordination', ['action.create', 'action.complete', 'readiness.query']),
    ('tasks', ['inspection.create', 'inspection.record', 'inspection.confirm']),
    ('media', ['media.upload', 'media.retry', 'media.open']),
    ('media', ['track.preview', 'track.binding.save']),
    ('media', ['media.play', 'media.pause', 'media.seek', 'media.rate', 'media.follow']),
    ('media', ['media.capture', 'evidence.register', 'issue.create']),
    ('monitoring', ['monitoring.create', 'monitoring.threshold', 'monitoring.record']),
    ('monitoring', ['monitoring.query', 'device.status']),
    ('results', ['inspection.record', 'inspection.confirm', 'evidence.compare']),
    ('readiness', ['need.create', 'need.update']),
    ('crews', ['resource.create', 'resource.update', 'allocation.create', 'allocation.cancel']),
    ('equipment', ['resource.create', 'resource.update', 'allocation.create', 'allocation.cancel']),
    ('materials', ['batch.create', 'batch.receive', 'batch.accept', 'material.issue', 'material.return', 'material.correct']),
    ('auxiliaries', ['resource.create', 'resource.update', 'material.issue', 'material.return']),
    ('tests', ['test.create', 'test.confirm']),
    ('readiness', ['need.update', 'action.create', 'need.confirm']),
    ('readiness', ['resources.query', 'resource.export', 'material.history']),
    ('files', ['document.create', 'link.create', 'document.search']),
    ('files', ['document.version', 'document.publish', 'document.void']),
    ('submittals', ['document.submit', 'document.return', 'document.publish']),
    ('technical', ['technical.create', 'technical.comment', 'technical.answer', 'technical.publish']),
    ('changes', ['change.create', 'change.confirm']),
    ('meetings', ['meeting.create', 'action.create', 'action.complete']),
    ('files', ['document.anchor', 'link.create', 'link.remove']),
    ('reports', ['report.preview', 'report.freeze', 'report.publish', 'report.export']),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def markdown_rows(text: str) -> list[list[str]]:
    return [[cell.strip() for cell in line.strip().strip('|').split('|')]
            for line in text.splitlines() if line.lstrip().startswith('|')]


def extract_requirements(package: Path) -> dict:
    spec = (package / 'DESIGN_SPEC.md').read_text(encoding='utf-8-sig')
    functions = []
    for number, (module, label) in enumerate(MODULES, 1):
        section = re.search(rf'^### 5\.{number} [^\n]+\n(.*?)(?=^### 5\.|^## 6 )', spec, re.M | re.S)
        if section is None:
            raise ValueError(f'Missing function section 5.{number}')
        rows = [r for r in markdown_rows(section.group(1))
                if len(r) == 3 and r[0] != '功能' and not re.fullmatch(r'[-: ]+', r[0])]
        if len(rows) != 8:
            raise ValueError(f'Section 5.{number} contains {len(rows)} functions, expected 8')
        for index, row in enumerate(rows, 1):
            suggested_tab, actions = MAPPINGS[len(functions)]
            functions.append({'id': f'F{len(functions)+1:02d}', 'sourceSection': f'5.{number}',
                              'sourceOrdinal': index, 'moduleId': module, 'moduleLabel': label,
                              'name': row[0], 'userOperationAndResult': row[1],
                              'presentationRequirements': row[2], 'suggestedTab': suggested_tab,
                              'suggestedActions': actions, 'implementationStatus': 'not_evaluated'})
    acceptance_text = (package / 'engineering/IMPLEMENTATION_ACCEPTANCE.md').read_text(encoding='utf-8-sig')
    acceptance = []
    for row in markdown_rows(acceptance_text):
        match = re.match(r'(A\d{2})[／/](.*)', row[0])
        if match:
            acceptance.append({'id': match.group(1), 'scenarios': re.findall(r'P\d{2}', match.group(2)),
                               'operation': row[1], 'requiredEvidence': row[2], 'result': 'not_run'})
    scenarios = [r for r in markdown_rows(spec) if re.fullmatch(r'P\d{2}', r[0])]
    metrics_section = re.search(r'^### 6\.1 .*?\n(.*?)(?=^### 6\.2 )', spec, re.M | re.S).group(1)
    metrics = [r for r in markdown_rows(metrics_section)
               if len(r) == 3 and r[0] != '指标' and not re.fullmatch(r'[-: ]+', r[0])]
    return {'functions': functions, 'acceptance': acceptance,
            'scenarios': [{'id': r[0], 'operation': r[1], 'expected': r[2]} for r in scenarios],
            'metrics': [{'name': r[0], 'formula': r[1], 'details': r[2]} for r in metrics]}


def png_info(path: Path) -> dict:
    with path.open('rb') as stream:
        header = stream.read(24)
    if header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
        raise ValueError(f'Invalid PNG header: {path.name}')
    width, height = struct.unpack('>II', header[16:24])
    return {'width': width, 'height': height}


def video_info(path: Path, ffprobe: str | None) -> dict:
    if not ffprobe:
        return {'status': 'not_inspected', 'reason': 'ffprobe unavailable; metadata not inferred'}
    proc = subprocess.run([ffprobe, '-v', 'error', '-show_format', '-show_streams',
                           '-of', 'json', str(path)], capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=45)
    if proc.returncode:
        return {'status': 'failed', 'error': proc.stderr.strip()}
    metadata = json.loads(proc.stdout)
    return {'status': 'metadata_read', 'durationSeconds': float(metadata.get('format', {}).get('duration', 0)),
            'streams': [{key: stream[key] for key in ('codec_type', 'codec_name', 'width', 'height',
                         'avg_frame_rate', 'duration', 'nb_frames') if key in stream}
                        for stream in metadata.get('streams', [])],
            'visualPlaybackVerified': False,
            'note': 'Reference metadata only; no actual-project rendering or functional evidence.'}


def audit(package: Path, ffprobe: str | None) -> dict:
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8-sig'))
    entries = {}
    for entry in manifest['files']:
        relative = entry['path'].replace('\\', '/')
        target = (package / relative).resolve()
        if not target.is_relative_to(package) or relative in entries:
            raise ValueError(f'Unsafe or duplicated reference path: {relative}')
        entries[relative] = entry
    inventory, mismatches = [], []
    for path in sorted(package.rglob('*')):
        if not path.is_file():
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(package):
            raise ValueError(f'Reference escapes package: {path}')
        relative = path.relative_to(package).as_posix()
        info = {'path': relative, 'bytes': path.stat().st_size, 'sha256': sha256(path)}
        expected = entries.get(relative)
        if expected:
            info['manifestMatches'] = info['bytes'] == expected['bytes'] and info['sha256'] == expected['sha256']
            if not info['manifestMatches']:
                mismatches.append({'path': relative, 'expected': expected, 'actual': info.copy()})
        else:
            info['manifestMatches'] = None  # Manifest itself cannot hash itself.
        inventory.append(info)
    actual_paths = {entry['path'] for entry in inventory}
    missing = sorted(set(entries) - actual_paths)
    required_missing = sorted(set(REQUIRED) - actual_paths)
    requirements = extract_requirements(package)
    contracts = json.loads((package / 'design/PAGE_CONTRACTS.json').read_text(encoding='utf-8-sig'))
    tokens = json.loads((package / 'design/design-tokens.json').read_text(encoding='utf-8-sig'))
    screens = [{'path': p.relative_to(package).as_posix(), **png_info(p)}
               for p in sorted((package / 'screens').glob('[0-9][0-9]-*.png'))]
    videos = [{'path': p.relative_to(package).as_posix(), **video_info(p, ffprobe)}
              for p in sorted(package.rglob('*.mp4'))]
    assertions = {'48_functions': len(requirements['functions']) == 48,
                  '8_functions_each_module': all(sum(f['moduleId'] == key for f in requirements['functions']) == 8 for key, _ in MODULES),
                  '20_acceptance_groups': [a['id'] for a in requirements['acceptance']] == [f'A{i:02d}' for i in range(1, 21)],
                  '30_scenarios': [p['id'] for p in requirements['scenarios']] == [f'P{i:02d}' for i in range(1, 31)],
                  '10_metric_definitions': len(requirements['metrics']) == 10,
                  '13_page_screens': len(screens) == 13,
                  '6_fixed_navigation': [(n['id'], n['label']) for n in contracts['navigation']] == MODULES,
                  'selection_does_not_move_camera': tokens['motion']['selectionCameraMovement'] is False,
                  'required_reference_files_exist': not required_missing,
                  'manifest_entries_match': not missing and not mismatches}
    return {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(),
            'classification': 'reference_inventory_not_product_acceptance',
            'packagePath': str(package), 'baselineCommit': '39be5f3',
            'productionDataReadOrModified': False, 'productAcceptanceStatus': 'not_evaluated',
            'automatedReferenceChecksPassed': all(assertions.values()), 'checks': assertions,
            'counts': {'actualFiles': len(inventory), 'manifestEntries': len(entries),
                       'functions': len(requirements['functions']), 'acceptanceGroups': len(requirements['acceptance']),
                       'scenarios': len(requirements['scenarios']), 'metrics': len(requirements['metrics']), 'screens': len(screens)},
            'missingManifestFiles': missing, 'missingRequiredFiles': required_missing, 'hashMismatches': mismatches,
            'unlistedFiles': sorted(actual_paths - set(entries)), 'screens': screens, 'videos': videos,
            'requirements': requirements, 'tokens': tokens, 'files': inventory,
            'notes': ['F01–F48 are local traceability IDs assigned in DESIGN_SPEC section 5 order, not original package IDs.',
                      'Suggested actions identify required entry points, not implemented or verified functions.',
                      'No old V5 runtime evidence is reused as proof of this redesign.',
                      'Prototype, reference screenshots, generated concepts and synthetic media are never actual-project acceptance evidence.']}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=DEFAULT_PACKAGE)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/platform-management/reference-audit.json')
    parser.add_argument('--feature-map', type=Path, default=ROOT / 'output/management-studio/feature-map.json')
    parser.add_argument('--ffprobe', default=None)
    args = parser.parse_args()
    package = args.package.resolve()
    for destination in (args.output.resolve(), args.feature_map.resolve()):
        if not destination.is_relative_to((ROOT / 'output').resolve()) or destination.is_relative_to(package):
            parser.error('Outputs must be below workspace/output and outside the reference package.')
    known_probe = ROOT / 'video_ar_backend/tools/FFmpeg/bin/ffprobe.exe'
    ffprobe = args.ffprobe or shutil.which('ffprobe') or (str(known_probe) if known_probe.is_file() else None)
    result = audit(package, ffprobe)
    for destination, payload in ((args.output, result), (args.feature_map, {
            'classification': 'requirements_mapping_not_completion', 'source': 'DESIGN_SPEC.md section 5',
            'functions': result['requirements']['functions'], 'count': 48})):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'automatedReferenceChecksPassed': result['automatedReferenceChecksPassed'],
                      'counts': result['counts'], 'mismatches': len(result['hashMismatches']),
                      'missing': result['missingManifestFiles'], 'output': str(args.output),
                      'featureMap': str(args.feature_map), 'productAcceptanceStatus': 'not_evaluated'}, ensure_ascii=False))
    return 0 if result['automatedReferenceChecksPassed'] else 1


if __name__ == '__main__':
    sys.exit(main())
