# r2: merge add-on results and summaries into the two evidence files (2026-10-25).
import json, sqlite3, sys
E = '/tmp/t-4840abc5/evidence/'
RM = '/tmp/t-4840abc5/run/r2-models-1792896724'
RI = '/tmp/t-4840abc5/run/r2-integ-1792896885'
RC2 = '/tmp/t-4840abc5/run/r2-v2cred-1792897096'

def stats(cat):
    oc = cat.get('opencode', {}).get('models', {})
    free = lambda m: not ((m.get('cost') or {}).get('input', 0) > 0)
    return dict(providers=len(cat), models=sum(len(p.get('models', {})) for p in cat.values()),
                opencodeModels=len(oc), zeroCostOpencodeModelsInRawCatalog=sum(1 for m in oc.values() if free(m)))

m = json.load(open(E + 'r2-models.json'))
for r in m['runs']:
    for k in ('t0', 't1'):
        if k in r and 'provider' in r[k]:
            r[k]['provider'].pop('default', None)
db = sqlite3.connect(RM + '/dbcopy-v2-default/opencode.db')
live = json.loads(json.loads(db.execute("select value from kv where key='models-dev:catalog'").fetchone()[0])['body'])
m['rawCatalogOffline'] = {
    'method': 'python over (a) the models-dev:catalog kv body 2.1.4 fetched in v2-default (copied db), (b) 2.1.4 bundled snapshot packages/core/src/models-dev/snapshot.txt at tag v2.1.4, (c) 1.18.35 cache/opencode/models.json fetched in v1-default. zero-cost = cost.input absent or 0. These are raw catalog rows; the servers list fewer free models (status/enabled filtering).',
    'v2LiveFetched_2026-10-25': stats(live),
    'v2BundledSnapshot': stats(json.load(open('/tmp/t-4840abc5/src/packages/core/src/models-dev/snapshot.txt'))),
    'v1LiveFetched_2026-10-25': stats(json.load(open(RM + '/v1-default/cache/opencode/models.json'))),
}
integ = json.load(open(RI + '/integration.json'))
m['v2IntegrationCatalog'] = {
    'method': 'r2-integration.ts: fresh 2.1.4 profile per mode, no provider, GET /api/integration at t0 and after models-dev.refreshed (or 20 s)',
    'runDir': RI,
    'runs': [{'label': x['label'], 'refreshedEvent': x['refreshed'], 't0Count': x['t0']['count'], 't1Count': x['t1']['count'], 'stopped': x['exited']} for x in integ],
}
m['summary'] = {
    '2.1.4 default': 'contacts models.opencode.ai at boot: models-dev.refreshed at ~1.8 s, kv models-dev:catalog row 6,697,199 bytes; /api/model 9 models, all provider opencode, all 9 cost 0, default opencode/big-pickle; /api/provider [] at t0, [opencode] at t1',
    '2.1.4 OPENCODE_DISABLE_MODELS_FETCH=1': 'no refreshed event in 30 s, no kv catalog row; catalog = bundled snapshot; /api/model the SAME 9 free opencode models (same IDs), same default opencode/big-pickle; /api/integration 235 in both modes',
    'conclusion': 'On 2.1.4 the flag stops the network fetch and the 5-minute refresh only. It does not remove or reduce the free models: the bundled snapshot is the boot floor (core/src/models-dev.ts populate: file > kv cache > bundled snapshot > fetch). Only OPENCODE_DISABLE_FREE_MODELS=1 (core/src/model.ts:224-228) removes them (see pm-p4-free-models.json).',
    '1.18.35 default': 'fetches models.json (5,942,697 bytes, written 2.8 s after start); GET /provider 232 providers, 8939 models, opencode 9 models all free, connected [opencode]',
    '1.18.35 OPENCODE_DISABLE_MODELS_FETCH=1': 'binary reads the flag (strings count 2); no models.json written; falls back to its own older bundled snapshot: 226 providers, 8400 models, opencode 10 free models with a different ID set; connected [opencode]',
    'compare': 'Today (1.18.35, Isomux does not set the flag) both versions show 9 free opencode models from the live catalog. With the flag, 2.1.4 keeps showing 9 (its snapshot matches today\'s live list), 1.18.35 would show a stale 10. Neither version empties the free list with this flag.',
}
txt = json.dumps(m, indent=2)
open(E + 'r2-models.json', 'w').write(txt + '\n')

c = json.load(open(E + 'r2-v1-credential.json'))
c['v2FreshProfileNote'] = {
    'finding': 'On a FRESH 2.1.4 profile the planted auth.json is NOT imported: /api/credential [] and credential table 0 rows. Reason: a database with no tables takes the schema bootstrap path, which marks every migration (incl. 20260805200742_import_legacy_credentials) done without running it (core/src/database/migration.ts:22-50). So the fresh-profile scan in v2.routeScan is not a valid negative.',
}
c['v2OnV1Profile'] = json.load(open(RC2 + '/v2-on-v1.json'))
c['v2OnV1Profile']['method'] = 'r2-v2cred.ts: copy of the stopped 1.18.35 profile data/opencode (v1 opencode.db with session table + fake auth.json) into a new 2.1.4 profile; start 2.1.4 (no provider config); GET routes at 3 s and again at 15 s; counts only'
c['v2OnV1Profile']['runDir'] = RC2
c['summary'] = {
    '1.18.35 bash tool env': 'c0 PATH control 1, OPENCODE_SERVER_PASSWORD 1, OPENCODE_SERVER_USERNAME 1: the agent shell inherits the server password today',
    '1.18.35 key over HTTP': 'fake key count 1 in GET /provider and 1 in GET /config/providers; 0 in the other 75 called GET routes (incl. /config, /provider/auth, /auth). Control: GATE_KEY_SENTINEL_7f3a from the config file seen in /config, /config/providers, /provider',
    '2.1.4 key over HTTP': 'after import from a v1 profile: fake key count 1 in GET /api/credential (the route is documented as returning every secret value), 0 in /api/provider (also at 15 s when it lists opencode+openai), /api/config, /api/integration, /api/model',
}
txt = json.dumps(c, indent=2)
open(E + 'r2-v1-credential.json', 'w').write(txt + '\n')
