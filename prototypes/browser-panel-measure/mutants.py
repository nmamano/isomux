"""Run named regression mutations sequentially; always restore the committed file."""
from pathlib import Path
import subprocess
source = Path('server/browser-session.ts')
original = source.read_text()
assert subprocess.run(['git', 'diff', '--quiet', '--', str(source)]).returncode == 0
start = original.index('        if (paint) await withDeadline((async () => {', original.index('private queueInputStill'))
end = original.index('        if (!current()', start)
immediate = original[:start] + original[end:]
immediate = immediate.replace('    }, delay);', '    }, 0);')
assert immediate != original
sample = '        const frameRevision = session.frameRevision;\n'
assert original.count(sample) == 1
early_revision = original.replace(sample, '')
pos = early_revision.index('        if (paint) await withDeadline((async () => {', early_revision.index('private queueInputStill'))
early_revision = early_revision[:pos] + sample + early_revision[pos:]
mutants = [
 ('human-input-starvation', original.replace('const throttled = session.dprOverride === true;', 'const throttled = false;'), 'delivers DPR stills during'),
 ('old-demand-frame', original.replace('    if (session.captureSize !== `${bounds.maxWidth}x${bounds.maxHeight}@${bounds.quality}/${bounds.deviceScaleFactor}`) return false;', ''), 'rejects the old seed and stream'),
 ('rejected-frame-suppresses-seed', original.replace('receivedFrame = this.publishFrame(agentId, session, frame) || receivedFrame;', 'receivedFrame = true; this.publishFrame(agentId, session, frame);'), 'seeds the view when'),
 ('dispatch-only', immediate, 'captures the latest input after repaint'),
 ('revision-before-settle', early_revision, 'captures the latest input after repaint'),
 ('leading-settle', original.replace('if (!current() || (!throttled && pending.revision !== revision)) return;', 'if (!current()) return;'), 'restarts the paint barrier'),
 ('overwrite-live', original.replace('session.frameRevision === frameRevision)', 'session.frameRevision >= frameRevision)'), 'drops a late input still'),
 ('scale-breaks-agent-input', original.replace('...viewport, deviceScaleFactor: bounds.deviceScaleFactor, mobile: false,', '...viewport, deviceScaleFactor: bounds.deviceScaleFactor, mobile: false, scale: bounds.deviceScaleFactor,'), None),
]
for name, changed, test in mutants:
 assert changed != original
 log = Path('/tmp/browser-panel-mutant-' + name + '.log')
 try:
  source.write_text(changed)
  assert source.read_text() == changed
  with log.open('w') as f:
   f.write(subprocess.check_output(['git', 'rev-parse', 'HEAD'],text=True))
   f.flush()
   command = ['bun', 'test', 'server/test-support/browser-session.test.ts', '-t', test] if test else ['bun', 'prototypes/browser-panel-measure/agent-check.ts']
   result = subprocess.run(command, stdout=f, stderr=subprocess.STDOUT)
   f.write(f'\nexit={result.returncode}\n')
  line = next(i for i, (a, b) in enumerate(zip(original.splitlines(), changed.splitlines()), 1) if a != b)
  print(name, 'source-line=' + str(line), 'exit=' + str(result.returncode), str(log), flush=True)
  assert result.returncode != 0, 'surviving mutant: ' + name
 finally:
  source.write_text(original)
  assert source.read_text() == original
assert subprocess.run(['git', 'diff', '--quiet', '--', str(source)]).returncode == 0
print('source restored')
